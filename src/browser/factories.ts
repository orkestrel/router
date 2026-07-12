import type { NavigatorInterface, NavigatorOptions } from './types.js'
import { Navigator } from './Navigator.js'

/**
 * Create a {@link NavigatorInterface} — the headless History/hash navigation
 * entity composing one core `Router<RouteEntry<Meta>>`.
 *
 * @remarks
 * Prefer this over `new Navigator(...)` at call sites that only need the
 * interface.
 *
 * @typeParam Meta - The opaque per-route payload a match carries back
 * @param options - The `routes` to register, the `history` toggle (default
 *   `false`, hash mode), an optional `base` (history mode), an optional
 *   `fallback` path, an optional `guard` hook, opt-in link `intercept`
 *   (history mode), the `sensitive` case toggle, and the AGENTS §13 emitter
 *   `on`/`error` wiring
 * @returns A live {@link NavigatorInterface} handle — call `start()` to begin
 *   dispatching
 *
 * @example
 * ```ts
 * import { createNavigator } from '@src/browser'
 *
 * const navigator = createNavigator({
 * 	routes: [
 * 		{ path: '/users/:id', meta: { title: 'User' } },
 * 		{ path: '/tokens', meta: { title: 'Tokens' } },
 * 	],
 * 	on: { navigate: (match) => (document.title = match.meta.title) },
 * })
 * navigator.start()
 * ```
 */
export function createNavigator<Meta>(options: NavigatorOptions<Meta>): NavigatorInterface<Meta> {
	return new Navigator<Meta>(options)
}
