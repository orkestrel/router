import type {
	NavigatorEventMap,
	NavigatorInterface,
	NavigatorMode,
	NavigatorOptions,
} from './types.js'
import type { AbortInterface } from '@orkestrel/abort'
import type { EmitterErrorHandler, EmitterInterface } from '@orkestrel/emitter'
import type { RouteEntry, RouterInterface, RouterMatch } from '@src/core'
import { createAbort } from '@orkestrel/abort'
import { Emitter } from '@orkestrel/emitter'
import { isFunction, isString } from '@orkestrel/contract'
import { canonicalPath, createRouter, joinPaths } from '@src/core'
import { findAnchor, locationPath } from './helpers.js'

/**
 * The headless History/hash navigation entity — composes one core
 * `Router<RouteEntry<Meta>>`, resolving the current location on `start()` and
 * every subsequent navigation event, tracking `active`, and emitting
 * `navigate` through the core {@link Emitter} (AGENTS §13). No `render` /
 * `outlet` — the consumer owns rendering.
 *
 * @typeParam Meta - The opaque per-route payload a match carries back
 *
 * @remarks
 * - **One shared engine.** Each `route.path` is registered on the SAME
 *   `Router` machine the core `Dispatcher` composes, keyed for dedup by its
 *   {@link canonicalPath} (last write wins, replace-in-place) — literal-over-
 *   param precedence, trailing-slash insensitivity, and `:param`/`*wildcard`
 *   extraction all come from that one engine (AGENTS §21).
 * - **Resolve pipeline.** Compute the `/`-prefixed pathname to match
 *   ({@link locationPath}) → {@link match} it → on a miss, match the
 *   `fallback` through the SAME engine → a fallback that ALSO matches nothing
 *   aborts any pending guarded navigation (a miss SUPERSEDES it, same as a
 *   newer navigation) and leaves `active` `undefined`, emitting nothing
 *   (§21-honest: no phantom match is fabricated) → the optional `guard` may
 *   veto → on a verdict, `active` is set and `navigate` emitted.
 * - **Supersede-safe guard.** Every navigation mints an `@orkestrel/abort`
 *   handle, aborting the PREVIOUS navigation's handle first; a guard verdict
 *   that resolves after its navigation was superseded (`signal.aborted`) is
 *   discarded, same as a `false`/rejected verdict. A guard throw routes to
 *   the `error` handler and vetoes. `stop()`/`destroy()` also abort the
 *   pending handle.
 * - **`'hash'` vs `'history'`.** `'hash'` mode binds `hashchange`; `'history'`
 *   mode binds `popstate` and, when `intercept` is set, same-origin `<a>`
 *   click interception (a plain left-click with no modifier keys, `target`,
 *   or `download` attribute).
 *
 * @example
 * ```ts
 * const navigator = new Navigator<{ readonly title: string }>({
 * 	routes: [
 * 		{ path: '/users/:id', meta: { title: 'User' } },
 * 		{ path: '/tokens', meta: { title: 'Tokens' } },
 * 	],
 * })
 * navigator.emitter.on('navigate', (match) => (document.title = match.meta.title))
 * navigator.start() // resolves the current hash now, and on every hashchange
 * navigator.go('/tokens')
 * ```
 */
export class Navigator<Meta> implements NavigatorInterface<Meta> {
	readonly #router: RouterInterface<RouteEntry<Meta>>
	readonly #emitter: Emitter<NavigatorEventMap<Meta>>
	readonly #mode: NavigatorMode
	readonly #base: string | undefined
	readonly #fallback: string | undefined
	readonly #guard: NavigatorOptions<Meta>['guard']
	readonly #error: EmitterErrorHandler | undefined
	readonly #intercept: boolean
	readonly #hashListener: () => void
	readonly #popListener: () => void
	readonly #clickListener: (event: MouseEvent) => void
	#active: RouterMatch<Meta> | undefined
	#started = false
	#current: AbortInterface | undefined

	constructor(options: NavigatorOptions<Meta>) {
		if (options.guard !== undefined && !isFunction(options.guard))
			throw new TypeError(
				`a navigator guard must be a function, got ${JSON.stringify(options.guard)}`,
			)
		if (options.fallback !== undefined && !isString(options.fallback))
			throw new TypeError(
				`a navigator fallback must be a string, got ${JSON.stringify(options.fallback)}`,
			)
		if (options.base !== undefined && !isString(options.base))
			throw new TypeError(`a navigator base must be a string, got ${JSON.stringify(options.base)}`)
		this.#mode = options.mode ?? 'hash'
		this.#base = options.base
		this.#intercept = options.intercept ?? false
		this.#guard = options.guard
		this.#error = options.error
		this.#emitter = new Emitter<NavigatorEventMap<Meta>>({ on: options.on, error: options.error })
		this.#router = createRouter<RouteEntry<Meta>>({
			entries: options.routes.map((route) => ({ path: route.path, meta: route, name: route.name })),
			sensitive: options.sensitive,
			key: (entry) => canonicalPath(entry.meta.path),
		})
		this.#fallback = options.fallback ?? options.routes[0]?.path
		this.#hashListener = () => this.#resolve()
		this.#popListener = () => this.#resolve()
		this.#clickListener = (event) => this.#intercepted(event)
	}

	get router(): RouterInterface<RouteEntry<Meta>> {
		return this.#router
	}

	get emitter(): EmitterInterface<NavigatorEventMap<Meta>> {
		return this.#emitter
	}

	get active(): RouterMatch<Meta> | undefined {
		return this.#active
	}

	start(): void {
		if (this.#started) return
		this.#started = true
		if (this.#mode === 'hash') {
			window.addEventListener('hashchange', this.#hashListener)
		} else {
			window.addEventListener('popstate', this.#popListener)
			if (this.#intercept) document.addEventListener('click', this.#clickListener)
		}
		this.#resolve()
	}

	stop(): void {
		if (!this.#started) return
		this.#started = false
		if (this.#mode === 'hash') {
			window.removeEventListener('hashchange', this.#hashListener)
		} else {
			window.removeEventListener('popstate', this.#popListener)
			if (this.#intercept) document.removeEventListener('click', this.#clickListener)
		}
		this.#current?.abort()
	}

	go(path: string): void {
		if (this.#mode === 'hash') {
			const next = `#${path}`
			if (window.location.hash === next) this.#resolve()
			else window.location.hash = next
			return
		}
		const target = this.#base === undefined ? path : joinPaths(this.#base, path)
		window.history.pushState(null, '', target)
		this.#resolve()
	}

	match(path: string): RouterMatch<Meta> | undefined {
		const hit = this.#router.match(path)
		if (hit === undefined) return undefined
		return { path: hit.path, params: hit.params, meta: hit.meta.meta, name: hit.meta.name }
	}

	destroy(): void {
		this.stop()
		this.#emitter.destroy()
	}

	// === Private

	// Compute the pathname to match for the CURRENT location, resolve it (falling back to the
	// configured fallback through the SAME engine on a miss), and either navigate or — when
	// neither the location nor the fallback matches anything — leave `active` `undefined` with
	// no emit (§21-honest: no phantom match is fabricated).
	#resolve(): void {
		const pathname = locationPath(
			{ hash: window.location.hash, pathname: window.location.pathname },
			this.#mode,
			this.#base,
		)
		const to = this.match(pathname) ?? this.#matchFallback()
		if (to === undefined) {
			this.#current?.abort()
			this.#active = undefined
			return
		}
		this.#navigate(to)
	}

	#matchFallback(): RouterMatch<Meta> | undefined {
		if (this.#fallback === undefined) return undefined
		return this.match(this.#fallback)
	}

	// Supersede the previous pending navigation's abort handle, mint a fresh one for this
	// navigation, and either commit directly (no guard configured — the synchronous fast path) or
	// run the guard pipeline.
	#navigate(to: RouterMatch<Meta>): void {
		this.#current?.abort()
		const handle = createAbort()
		this.#current = handle
		const guard = this.#guard
		if (guard === undefined) {
			this.#commit(to)
			return
		}
		void this.#guarded(guard, to, this.#active, handle)
	}

	#commit(to: RouterMatch<Meta>): void {
		this.#active = to
		this.#emitter.emit('navigate', to)
	}

	// Await the guard's verdict; a throw routes to the `error` handler and vetoes, a discarded
	// verdict (superseded via `handle.signal.aborted`, or a plain `false`/rejected verdict) leaves
	// `active` unchanged with no emit, and a true verdict commits.
	async #guarded(
		guard: NonNullable<NavigatorOptions<Meta>['guard']>,
		to: RouterMatch<Meta>,
		from: RouterMatch<Meta> | undefined,
		handle: AbortInterface,
	): Promise<void> {
		let verdict: boolean
		try {
			verdict = await guard(to, from, handle.signal)
		} catch (error) {
			this.#surface(error)
			return
		}
		if (handle.signal.aborted || !verdict) return
		this.#commit(to)
	}

	// Route a guard throw to the `error` handler (AGENTS §13's own channel, not a listener
	// throw so it cannot flow through the emitter's `emit`), swallowing a throwing handler itself
	// (anti-recursion, mirroring the emitter's own contract).
	#surface(error: unknown): void {
		const handler = this.#error
		if (handler === undefined) return
		try {
			handler(error, 'navigate')
		} catch {
			// The error handler itself threw — swallow it (anti-recursion).
		}
	}

	// Same-origin `<a>` click interception ('history' mode, opt-in via `intercept`): skip an
	// already-handled event, a non-primary button, any modifier key, a targeted or download link,
	// or a cross-origin destination — otherwise prevent the native navigation and `go` instead.
	#intercepted(event: MouseEvent): void {
		if (event.defaultPrevented || event.button !== 0) return
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
		const anchor = findAnchor(event)
		if (anchor === undefined) return
		if (anchor.target !== '' && anchor.target !== '_self') return
		if (anchor.hasAttribute('download')) return
		const url = new URL(anchor.href, window.location.href)
		if (url.origin !== window.location.origin) return
		event.preventDefault()
		this.go(locationPath({ hash: url.hash, pathname: url.pathname }, 'history', this.#base))
	}
}
