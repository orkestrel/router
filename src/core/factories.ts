import type {
	DispatcherInterface,
	DispatcherOptions,
	RouterInterface,
	RouterOptions,
} from './types.js'
import { Dispatcher } from './Dispatcher.js'
import { Router } from './Router.js'

/**
 * Create a {@link RouterInterface} — the pure path-matching + registry engine
 * shared by the browser `Navigator` and the core `Dispatcher`.
 *
 * @remarks
 * Prefer this over `new Router(...)` at call sites that only need the
 * interface; an entity that OWNS a `Router` internally (like `Dispatcher`)
 * still constructs `new Router(...)` directly.
 *
 * @typeParam Meta - The opaque payload each entry carries and a match returns
 * @param options - Optional initial `entries`, the `sensitive` case toggle
 *   (default `true`), and a `key` dedup identity function
 * @returns A {@link RouterInterface}
 *
 * @example
 * ```ts
 * import { createRouter } from '@src/core'
 *
 * const router = createRouter<{ readonly page: string }>()
 * router.add({ path: '/users/:id', meta: { page: 'profile' } })
 * router.match('/users/7') // { path: '/users/:id', params: { id: '7' }, meta: { page: 'profile' } }
 * ```
 */
export function createRouter<Meta>(options?: RouterOptions<Meta>): RouterInterface<Meta> {
	return new Router<Meta>(options)
}

/**
 * Create a {@link DispatcherInterface} — the fetch-standard, method-
 * dimensioned dispatch entity over one internal `Router<RouteRecord<TState>>`.
 *
 * @remarks
 * Prefer this over `new Dispatcher(...)` at call sites that only need the
 * interface.
 *
 * @typeParam TState - The consumer's opaque per-request state type (default
 *   `undefined` for stateless use)
 * @param options - Optional initial `routes`, the `sensitive` case toggle,
 *   the `unmatched`/`unmethoded` default-responder overrides, and the AGENTS
 *   §13 emitter `on`/`error` wiring
 * @returns A {@link DispatcherInterface}
 *
 * @example
 * ```ts
 * import { createDispatcher } from '@src/core'
 *
 * const dispatcher = createDispatcher<{ readonly userId: string }>({
 * 	routes: [
 * 		{ method: 'GET', path: '/health', handler: () => new Response('ok') },
 * 	],
 * })
 * const response = await dispatcher.handle(new Request('http://x/health'), { userId: 'me' })
 * ```
 */
export function createDispatcher<TState = undefined>(
	options?: DispatcherOptions<TState>,
): DispatcherInterface<TState> {
	return new Dispatcher<TState>(options)
}
