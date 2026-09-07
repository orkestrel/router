# @orkestrel/router

> The typed request router: a path-matching engine (`Router`) that compiles route patterns,
> extracts URL-decoded params, and resolves the most specific match, with a fetch-standard,
> method-dimensioned dispatcher (`Dispatcher`), a headless History or hash `Navigator`, and a
> `node:http` adapter all composing that same engine.

Register routes on a `Router`, or hand them to a `Dispatcher` where they are
method-dimensioned; reach for `createNavigator` in the browser and `createListener` behind
`node:http`. Part of the `@orkestrel` line, built on `@orkestrel/contract` for validation,
`@orkestrel/emitter` for the observable surface, and `@orkestrel/abort` for cancellation.

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

Path params are inferred at the type level from the literal pattern through the
`PathParams` type, and the `defineRoute` function pins a `RouteInput`'s path so literal
inference survives across call sites. The `./browser` entry adds the `createNavigator`
function for headless History or hash navigation; the `./server` entry adds the
`buildRequest`, `sendResponse`, and `createListener` functions for `node:http`.

## Guide

For the full surface — the core `Router`, the `Dispatcher`, the browser `Navigator`, and the
`node:http` server adapter — see
[`guides/router.md`](guides/router.md).

## Package

Published as environment-scoped entry points per the `exports` field in
`package.json`: a shared core, `./browser`, and `./server`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
