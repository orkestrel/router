// ============================================================================
//  Pure conversion + glue between `node:http` and the fetch vocabulary the
//  core `Dispatcher` speaks — no lifecycle, no listener ownership beyond the
//  handler function `createListener` returns (§5.3). Every function is
//  exported per AGENTS §5.
// ============================================================================

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DispatcherInterface } from '@src/core'
import type { ListenerFunction, RequestOptions, StateFunction } from './types.js'
import { createAbort } from '@orkestrel/abort'
import { isRecord } from '@orkestrel/contract'

/**
 * Determine whether a `node:http` connection socket is TLS-encrypted — the
 * total, never-throwing narrow (AGENTS §14) `buildRequest` uses to pick the
 * derived scheme (`https` vs `http`).
 *
 * @param socket - The connection value to test (typically `message.socket`)
 * @returns `true` when `socket` carries a truthy `encrypted` property (a
 *   `tls.TLSSocket`), `false` for anything else (including `undefined`)
 *
 * @example
 * ```ts
 * import { isEncryptedSocket } from '@src/server'
 *
 * isEncryptedSocket({ encrypted: true }) // true
 * isEncryptedSocket({}) // false
 * ```
 */
export function isEncryptedSocket(socket: unknown): socket is { readonly encrypted: true } {
	return isRecord(socket) && socket.encrypted === true
}

/**
 * Build a fetch-standard `Request` from a `node:http` `IncomingMessage` — the
 * server-adapter half of the §5.3 conversion seam.
 *
 * @remarks
 * - `method` is carried over verbatim (defaulting to `GET` when absent).
 * - The URL is built against `options.origin` when given, otherwise a scheme
 *   derived from the connection (`https` when {@link isEncryptedSocket}, else
 *   `http`) plus the `Host` header (absent `Host` ⇒ `localhost`).
 * - Every request header is copied; multi-value headers are joined per fetch
 *   semantics (`', '`-joined), except `set-cookie`, whose values are each
 *   appended individually (fetch `Headers` preserves multiple `set-cookie`
 *   entries distinctly).
 * - For a method that carries a body (anything but `GET`/`HEAD`), the message
 *   is pumped chunk by chunk into a DOM-compatible `ReadableStream<Uint8Array>`
 *   (reconciling the DOM + node type worlds under the root config), with
 *   `duplex: 'half'` set as Node's fetch implementation requires for a
 *   streamed request body.
 * - A fresh `@orkestrel/abort` handle backs `request.signal`. It aborts when
 *   the request connection closes before the message finished
 *   (`!message.complete`), or when the paired `options.response` closes before
 *   its response finished (`!response.writableEnded`). A handler awaiting the
 *   signal therefore observes either side of a client disconnect the
 *   fetch-standard way, with zero router-specific API.
 *
 * @param message - The raw `node:http` request
 * @param options - Optional `origin` override and paired `response` for
 *   response-side disconnect tracking (§5.3 {@link RequestOptions})
 * @returns A fetch `Request` whose `signal` fires on an incomplete request, or
 *   on a response-side client disconnect when `options.response` is provided
 *
 * @example
 * ```ts
 * import { buildRequest } from '@src/server'
 * import http from 'node:http'
 *
 * const server = http.createServer((incoming, response) => {
 * 	const request = buildRequest(incoming, { response })
 * 	console.log(request.method, request.url)
 * })
 * ```
 */
export function buildRequest(message: IncomingMessage, options?: RequestOptions): Request {
	const method = message.method ?? 'GET'
	const host = message.headers.host ?? 'localhost'
	const scheme = isEncryptedSocket(message.socket) ? 'https' : 'http'
	const origin = options?.origin ?? `${scheme}://${host}`
	const url = new URL(message.url ?? '/', origin)

	const headers = new Headers()
	for (const [name, value] of Object.entries(message.headers)) {
		if (value === undefined) continue
		if (name === 'set-cookie') {
			for (const cookie of Array.isArray(value) ? value : [value]) headers.append(name, cookie)
			continue
		}
		headers.set(name, Array.isArray(value) ? value.join(', ') : value)
	}

	const abort = createAbort()
	message.once('close', () => {
		if (!message.complete)
			abort.abort(new Error(`request to ${url.pathname} disconnected before completion`))
	})
	const response = options?.response
	if (response !== undefined)
		response.once('close', () => {
			if (!response.writableEnded)
				abort.abort(new Error(`request to ${url.pathname} disconnected before response completed`))
		})

	const carriesBody = method !== 'GET' && method !== 'HEAD'
	const init: RequestInit = { method, headers, signal: abort.signal }
	if (!carriesBody) return new Request(url, init)

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const chunk of message) controller.enqueue(chunk)
				controller.close()
			} catch (error) {
				controller.error(error)
			}
		},
	})
	const streamed: RequestInit & { readonly duplex: 'half' } = { ...init, body, duplex: 'half' }
	return new Request(url, streamed)
}

/**
 * Write a fetch-standard `Response` back to a `node:http` `ServerResponse` —
 * the reverse half of the §5.3 conversion seam.
 *
 * @remarks
 * Writes `status`/`statusText`, then every response header (`set-cookie`
 * written via {@link Headers.getSetCookie} so multiple cookies stay distinct
 * instead of collapsing into one comma-joined header), then streams the web
 * body to `target` chunk by chunk (`for await` over `response.body`), ending
 * `target` when the stream completes. A `null` body ends `target` immediately
 * with no further writes. Total error posture: if `target` is destroyed
 * mid-stream (the client disconnected), the write loop stops and `target` is
 * left as-is rather than throwing an unhandled rejection — a destroyed
 * target is not this function's error to surface.
 *
 * @param response - The fetch `Response` to write
 * @param target - The `node:http` response to write it to
 * @returns A promise that resolves once `target` has been ended (or the
 *   stream stopped because `target` was destroyed)
 *
 * @example
 * ```ts
 * import { sendResponse } from '@src/server'
 * import http from 'node:http'
 *
 * const server = http.createServer(async (_incoming, target) => {
 * 	await sendResponse(new Response('ok'), target)
 * })
 * ```
 */
export async function sendResponse(response: Response, target: ServerResponse): Promise<void> {
	target.statusCode = response.status
	target.statusMessage = response.statusText
	for (const [name, value] of response.headers) {
		if (name === 'set-cookie') continue
		target.setHeader(name, value)
	}
	const cookies = response.headers.getSetCookie()
	if (cookies.length > 0) target.setHeader('set-cookie', cookies)

	if (response.body === null) {
		if (!target.destroyed) target.end()
		return
	}
	try {
		for await (const chunk of response.body) {
			if (target.destroyed) return
			target.write(chunk)
		}
		if (!target.destroyed) target.end()
	} catch {
		if (!target.destroyed) target.end()
	}
}

/**
 * Handle one `node:http` request through a core dispatcher and write its
 * fetch-standard response.
 *
 * @remarks
 * This is the named asynchronous orchestration behind {@link createListener}.
 * A rejected dispatch is treated only as a transport-level last resort: write
 * a bare `500` before headers, or destroy a response whose headers have
 * already started.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param dispatcher - The core dispatcher to run
 * @param state - Derives the consumer state from the incoming message
 * @param request - The raw `node:http` request
 * @param response - The raw `node:http` response
 * @returns A promise that settles after the response is written or closed
 *
 * @example
 * ```ts
 * const server = http.createServer((request, response) => {
 * 	void handleListenerRequest(dispatcher, () => undefined, request, response)
 * })
 * ```
 */
export async function handleListenerRequest<TState>(
	dispatcher: DispatcherInterface<TState>,
	state: StateFunction<TState>,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	try {
		const converted = buildRequest(request, { response })
		const result = await dispatcher.handle(converted, state(request))
		await sendResponse(result, response)
	} catch (error) {
		if (!response.headersSent && !response.destroyed) {
			response.writeHead(500)
			response.end()
		} else if (!response.destroyed) {
			response.destroy(error instanceof Error ? error : new Error(String(error)))
		}
	}
}

/**
 * Create a `node:http` request listener over a core {@link DispatcherInterface} —
 * the whole server face's entry point (§5.3): convert the incoming message to
 * a fetch `Request`, hand it to the dispatcher with the consumer's per-request
 * `state`, and write the resulting `Response` back.
 *
 * @remarks
 * A rejected `dispatcher.handle` (a route handler throw — the dispatcher
 * never invents an error boundary, §5.1) is this listener's transport-level
 * LAST RESORT, distinct from an application error boundary: when nothing has
 * been sent yet, it destroys the connection with a bare `500` head (never
 * leaking a hanging socket); once headers are already sent, it destroys the
 * connection outright. The router still owns no error POLICY — a consumer
 * that wants mapped error responses installs its own boundary around
 * `dispatcher.handle` (the future `@orkestrel/server` seam, §7).
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param dispatcher - The core dispatcher to run each converted request through
 * @param state - Derives the consumer's per-request `state` from the raw message
 * @returns A `(request, response) => void` listener, passable directly to
 *   `http.createServer`
 *
 * @example
 * ```ts
 * import { createListener } from '@src/server'
 * import { createDispatcher } from '@src/core'
 * import http from 'node:http'
 *
 * const dispatcher = createDispatcher()
 * dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
 * http.createServer(createListener(dispatcher, () => undefined)).listen(0)
 * ```
 */
export function createListener<TState>(
	dispatcher: DispatcherInterface<TState>,
	state: StateFunction<TState>,
): ListenerFunction {
	return (request, response) => {
		void handleListenerRequest(dispatcher, state, request, response)
	}
}
