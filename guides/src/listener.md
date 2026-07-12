# Listener

> The node adapter face (PROPOSAL §5.3) — deliberately tiny: pure
> message-format conversion between `node:http` and the fetch vocabulary the
> core `Dispatcher` speaks, and nothing else. No lifecycle, no listener
> ownership beyond the handler function `createListener` returns. A consumer
> runs `node:http.createServer(createListener(dispatcher, () => state))`
> today; on runtimes that speak fetch natively (Bun, Deno, workers),
> consumers skip this face entirely and pass `Request`s straight to
> `dispatcher.handle`. Source: [`src/server`](../../src/server). Surfaced
> through the `@orkestrel/router` barrel (aliased `@src/server` inside this
> repo).

## Surface

Convert a `node:http` request to a fetch `Request`, dispatch it, and write
the `Response` back — or use `createListener` to do all three at once:

```ts
import { createListener } from '@src/server'
import { createDispatcher } from '@src/core'
import http from 'node:http'

const dispatcher = createDispatcher()
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
http.createServer(createListener(dispatcher, () => undefined)).listen(0)
```

### Helpers

| API                 | Kind     | Summary                                                                  |
| ------------------- | -------- | ------------------------------------------------------------------------ |
| `isEncryptedSocket` | function | Whether a `node:http` connection socket is TLS-encrypted.                |
| `requestFrom`       | function | Build a fetch `Request` from a `node:http` `IncomingMessage`.            |
| `sendResponse`      | function | Write a fetch `Response` back to a `node:http` `ServerResponse`.         |
| `createListener`    | function | Create a `node:http` request listener over a core `DispatcherInterface`. |

### Types

| Type             | Kind      | Shape                                                                                       |
| ---------------- | --------- | ------------------------------------------------------------------------------------------- |
| `RequestOptions` | interface | `{ origin?: string }` — options for `requestFrom`.                                          |
| `Listener`       | type      | `(request: IncomingMessage, response: ServerResponse) => void` — `createListener`'s return. |
| `StateResolver`  | type      | `(message: IncomingMessage) => TState` — derives `createListener`'s per-request state.      |

## Contract

These invariants hold across `src/server` ↔ `listener.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `interface` /
   `type` row in the `## Surface` table is a real export of `src/server`, and
   every export appears as a Surface row — exhaustive, both directions
   (AGENTS §22).
2. **Signal fires on client disconnect.** `requestFrom` mints an
   `@orkestrel/abort` handle and builds the `Request` over its `signal`; if
   the underlying connection closes before the message finished
   (`!message.complete`), the handle aborts — so `request.signal` fires the
   fetch-standard way, with zero router-specific cancellation API.
3. **Transport-level 500 is a last resort, not an error policy.**
   `createListener`'s handler wraps `dispatcher.handle` in a try/catch purely
   for the CONNECTION: when nothing has been sent yet, it writes a bare `500`
   head and ends the response (never leaking a hanging socket); once headers
   are already sent, it destroys the connection outright. The router still
   owns no error POLICY — a consumer wanting mapped error responses installs
   its own boundary around `dispatcher.handle` directly (the future
   `@orkestrel/server` seam, PROPOSAL §7); a handler throw is NEVER silently
   swallowed into a generic response by the core `Dispatcher` itself (see
   [`router.md`](router.md) Contract §9).
4. **Streaming both ways.** `requestFrom` streams a body-carrying method's
   message into the `Request` via a manual `ReadableStream` pump — a `for
await` loop over the `IncomingMessage` enqueueing each chunk, with
   `duplex: 'half'` set as Node's fetch implementation requires for a
   streamed request body; `sendResponse` streams a non-`null` `Response` body
   back to the `ServerResponse` chunk by chunk, ending the target when the
   stream completes (or stopping cleanly, without throwing, if the target was
   destroyed mid-stream by a client disconnect).
5. **Header fidelity.** `requestFrom` copies every incoming header
   (multi-value headers comma-joined, except `set-cookie`, appended
   individually); `sendResponse` writes every outgoing header and re-derives
   `set-cookie` via `Headers.getSetCookie()` so multiple response cookies
   stay distinct instead of collapsing into one comma-joined header.

## Patterns

### Basic server

```ts
import { createListener } from '@src/server'
import { createDispatcher } from '@src/core'
import http from 'node:http'

const dispatcher = createDispatcher<{ readonly requestId: string }>()
dispatcher.add({
	method: 'GET',
	path: '/users/:id',
	handler: (_request, context) =>
		Response.json({ id: context.params.id, requestId: context.state.requestId }),
})

const server = http.createServer(
	createListener(dispatcher, () => ({ requestId: crypto.randomUUID() })),
)
server.listen(0)
```

### Converting requests and responses directly

For a runtime seam that needs finer control than `createListener` (custom
error handling around `dispatcher.handle`, for instance), compose
`requestFrom`/`sendResponse` directly:

```ts
import { requestFrom, sendResponse } from '@src/server'
import { createDispatcher } from '@src/core'
import http from 'node:http'

const dispatcher = createDispatcher()
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })

const server = http.createServer(async (incoming, target) => {
	const request = requestFrom(incoming, { origin: 'https://api.example.com' })
	try {
		const response = await dispatcher.handle(request, undefined)
		await sendResponse(response, target)
	} catch (error) {
		target.writeHead(500).end(String(error)) // this consumer's own error policy
	}
})
server.listen(0)
```

### Observing client disconnect

```ts
import { requestFrom } from '@src/server'
import http from 'node:http'

const server = http.createServer((incoming) => {
	const request = requestFrom(incoming)
	request.signal.addEventListener('abort', () => console.log('client disconnected'))
})
```

### Practices

- **Prefer `createListener` for the common case** — it wires conversion,
  dispatch, and the transport-level last-resort `500` together correctly.
- **Install your own error boundary for mapped error responses** — the
  router (core and this adapter) never invents one; a handler throw
  propagates.
- **Thread `request.signal` into downstream work** — a handler can cancel
  its own I/O when the client disconnects, the fetch-standard idiom.
- **Skip this face entirely on fetch-native runtimes** — Bun, Deno, and
  workers hand `Request`s to `dispatcher.handle` directly.

## Tests

- [`tests/src/server/helpers.test.ts`](../../tests/src/server/helpers.test.ts) —
  `isEncryptedSocket`, `requestFrom` fidelity (method, URL from `Host`,
  headers including multi-value and `set-cookie`, body streaming, the
  disconnect-aborts-`signal` case), `sendResponse` (status, headers including
  `set-cookie`, streamed and empty bodies, a destroyed target mid-stream),
  and `createListener` end-to-end round-trips over real `node:http` sockets.

## See also

- [`AGENTS.md`](../../AGENTS.md) — the rules; §14 contract & validation
  architecture, §22 documentation-as-contracts.
- [`PROPOSAL.md`](../../PROPOSAL.md) — §5.3 the server adapter's public API,
  §7 the future `@orkestrel/server` seam.
- [`router.md`](router.md) — the core `Dispatcher` this face converts
  `node:http` messages for.
- [`abort.md`](abort.md) — `@orkestrel/abort`, the client-disconnect
  cancellation primitive this face composes.
- [`README.md`](../README.md) — the guides index.
