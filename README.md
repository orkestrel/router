# @orkestrel/router

A typed request router for the `@orkestrel` line. One matching engine compiles
route patterns, extracts URL-decoded params, and resolves the most specific
match; a `Dispatcher` layers fetch-standard, method-dimensioned dispatch over
it; a headless `Navigator` drives History or hash navigation in the browser;
and a `node:http` adapter converts messages in both directions. Built on
`@orkestrel/contract` for validation, `@orkestrel/emitter` for the observable
surface, and `@orkestrel/abort` for cancellation.

## Install

```sh
npm install @orkestrel/router
```

## Requirements

- Node.js >= 22.12.0
- ESM and CommonJS for the core and `./server` entries; the `./browser` entry is ESM only.
- Server and browser environments both supported

## Usage

```ts
import { createDispatcher, createRouter } from '@orkestrel/router'

const router = createRouter<{ readonly page: string }>()
router.add({ path: '/users/:id', meta: { page: 'profile' } })
router.match('/users/7') // { path: '/users/:id', params: { id: '7' }, meta: { page: 'profile' } }

const dispatcher = createDispatcher<{ readonly userId: string }>({
	routes: [
		{
			method: 'GET',
			path: '/users/:id',
			handler: (_request, context) => Response.json(context.params),
		},
	],
})
const response = await dispatcher.handle(new Request('http://x/users/7'), { userId: 'me' })
```

`Router` is the shared registry-and-match engine — literal-over-param-over-wildcard
precedence, trailing-slash folding, and tolerant percent-decoding — that both `Dispatcher`
(fetch-standard, method-dimensioned) and the browser `Navigator` compose. Path params are
inferred at the type level from the literal pattern through `PathParams`, and `defineRoute()`
pins a `RouteInput`'s path so literal inference survives across call sites. The `./browser` entry
adds `createNavigator` for headless History/hash navigation; the `./server` entry adds
`buildRequest` / `sendResponse` / `createListener` for `node:http`.

## Guide

For the full surface — the core `Router`, the `Dispatcher`, the browser `Navigator`, and the
`node:http` server adapter — see
[`guides/router.md`](guides/router.md).

## Package

Published as environment-scoped entry points per the `exports` field in
`package.json`: a shared core, `./browser`, and `./server`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
