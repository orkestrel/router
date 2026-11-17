import type { NavigatorEventMap, NavigatorInterface, NavigatorOptions } from './types.js'
import type { AbortInterface } from '@orkestrel/abort'
import type { EmitterErrorHandler, EmitterInterface } from '@orkestrel/emitter'
import type { RouterInterface, RouterMatch } from '@src/core'
import { createAbort } from '@orkestrel/abort'
import { Emitter } from '@orkestrel/emitter'
import {
	ContractError,
	isFunction,
	isInteger,
	isRecord,
	isString,
	preview,
	refuseValue,
} from '@orkestrel/contract'
import { createRouter, joinPaths } from '@src/core'
import { computeNavigationKey, findAnchor, resolveLocationPath } from './helpers.js'

/**
 * Represents the headless History/hash navigation entity — composes one core
 * `Router<Meta>`, resolving the current location on `start()` and
 * every subsequent navigation event, tracking `active`, and emitting
 * `navigate` through the core {@link Emitter}. No `render` /
 * `outlet` — the consumer owns rendering.
 *
 * @typeParam Meta - The opaque per-route payload a match carries back
 *
 * @remarks
 * - **One shared engine.** Each `route.path` is registered on the same `Router` machine the core
 *   `Dispatcher` composes, keyed for dedup by its {@link canonicalizePath}.
 * - **Resolve pipeline.** Read the `/`-prefixed path ({@link resolveLocationPath}), match it
 *   through the router, and on a miss match the `fallback`. A fallback that also misses leaves
 *   `active` `undefined`, emits nothing, and aborts any pending navigation.
 * - **The guard runs before the URL moves.** `navigate` and an intercepted link ask the guard
 *   first, and only an allowed navigation pushes the entry (or the hash) and commits.
 * - **A veto after the browser moved the URL.** On a `popstate` or `hashchange` veto, the
 *   navigator moves the browser back with `history.go` to the entry `active` describes, by the
 *   `index` it writes into `history.state`. An entry it did not write carries no index, and the
 *   location then stays where the browser put it.
 * - **Pending navigations.** Each navigation holds an `@orkestrel/abort` handle until its verdict
 *   arrives; a newer navigation, `stop`, and `destroy` abort every pending handle.
 * - **Re-entrancy.** A `navigate` called during a `navigate` emission runs in a microtask after
 *   the emission, unless a later navigation supersedes it first.
 * - **After `destroy`.** `start` and `navigate` do nothing.
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
 * navigator.navigate('/tokens')
 * ```
 */
export class Navigator<Meta> implements NavigatorInterface<Meta> {
	readonly #router: RouterInterface<Meta>
	readonly #emitter: Emitter<NavigatorEventMap<Meta>>
	readonly #history: boolean
	readonly #base: string | undefined
	readonly #fallback: string | undefined
	readonly #guard: NavigatorOptions<Meta>['guard']
	readonly #error: EmitterErrorHandler | undefined
	readonly #intercept: boolean
	readonly #listener: () => void
	readonly #clickListener: (event: MouseEvent) => void
	readonly #pending = new Set<AbortInterface>()
	readonly #emissions = new Set<AbortInterface>()
	#active: RouterMatch<Meta> | undefined
	#index: number | undefined
	#started = false
	#restoring = false

	constructor(options: NavigatorOptions<Meta>) {
		refuseValue(
			options.guard,
			(value): value is NavigatorOptions<Meta>['guard'] => value === undefined || isFunction(value),
			'Navigator',
			{ path: ['options', 'guard'], limit: 'function or undefined', code: 'literal' },
		)
		refuseValue(
			options.fallback,
			(value): value is string | undefined => value === undefined || isString(value),
			'Navigator',
			{ path: ['options', 'fallback'], limit: 'string or undefined', code: 'literal' },
		)
		refuseValue(
			options.base,
			(value): value is string | undefined => value === undefined || isString(value),
			'Navigator',
			{ path: ['options', 'base'], limit: 'string or undefined', code: 'literal' },
		)
		this.#history = options.history ?? false
		this.#base = options.base
		this.#intercept = options.intercept ?? false
		this.#guard = options.guard
		this.#error = options.error
		this.#emitter = new Emitter<NavigatorEventMap<Meta>>({
			...(options.on === undefined ? {} : { on: options.on }),
			...(options.error === undefined ? {} : { error: options.error }),
		})
		this.#router = createRouter<Meta>({
			entries: options.routes,
			...(options.sensitive === undefined ? {} : { sensitive: options.sensitive }),
			key: computeNavigationKey,
		})
		this.#fallback = options.fallback ?? options.routes[0]?.path
		this.#listener = this.#arrive.bind(this)
		this.#clickListener = this.#intercepted.bind(this)
	}

	get router(): RouterInterface<Meta> {
		return this.#router
	}

	get emitter(): EmitterInterface<NavigatorEventMap<Meta>> {
		return this.#emitter
	}

	get active(): RouterMatch<Meta> | undefined {
		return this.#active
	}

	start(): void {
		if (this.#started || this.#emitter.destroyed) return
		this.#started = true
		if (!this.#history) {
			window.addEventListener('hashchange', this.#listener)
		} else {
			window.addEventListener('popstate', this.#listener)
			if (this.#intercept) document.addEventListener('click', this.#clickListener)
		}
		if (this.#position() === undefined) window.history.replaceState({ index: 0 }, '')
		this.#resolve(this.#position())
	}

	stop(): void {
		if (!this.#started) return
		this.#started = false
		if (!this.#history) {
			window.removeEventListener('hashchange', this.#listener)
		} else {
			window.removeEventListener('popstate', this.#listener)
			if (this.#intercept) document.removeEventListener('click', this.#clickListener)
		}
		this.#restoring = false
		this.#supersede()
	}

	navigate(path: string): void {
		if (this.#emitter.destroyed) return
		if (this.#emissions.size > 0) {
			this.#defer(path)
			return
		}
		const url = this.#target(path)
		const to = this.#lookup(url)
		this.#supersede()
		if (to === undefined) {
			this.#miss(this.#push(url))
			return
		}
		const handle = createAbort()
		const guard = this.#guard
		if (guard === undefined) {
			this.#commit(to, this.#push(url), handle)
			return
		}
		this.#pending.add(handle)
		void this.#request(guard, to, this.#active, url, handle)
	}

	destroy(): void {
		this.stop()
		this.#supersede()
		this.#emitter.destroy()
	}

	// === Private

	// An arrival at the entry `active` describes resolves nothing: a restore's landing cancels
	// nothing, and any other arrival there cancels every pending navigation.
	#arrive(): void {
		const landed = this.#position()
		const restored = this.#restoring
		this.#restoring = false
		if (landed !== undefined && landed === this.#index) {
			if (!restored) this.#supersede()
			return
		}
		this.#resolve(landed)
	}

	// Resolve the location the browser already shows; `landed` is that entry's index.
	#resolve(landed: number | undefined): void {
		const to = this.#lookup(window.location)
		this.#supersede()
		if (to === undefined) {
			this.#miss(landed)
			return
		}
		const handle = createAbort()
		const guard = this.#guard
		if (guard === undefined) {
			this.#commit(to, landed, handle)
			return
		}
		this.#pending.add(handle)
		void this.#arrival(guard, to, this.#active, landed, handle)
	}

	// The browser's own parser builds the destination, so the text matched here is the text
	// `location` shows after the push.
	#target(path: string): URL {
		if (!this.#history) return new URL(`#${path}`, window.location.href)
		const url = new URL(
			this.#base === undefined ? path : joinPaths(this.#base, path),
			window.location.href,
		)
		if (url.origin === window.location.origin) return url
		throw new ContractError('a navigator path must resolve on the page origin', {
			code: 'pattern',
			context: { path: ['path'], limit: 'a path on the page origin', received: preview(path) },
		})
	}

	#lookup(location: Pick<Location, 'hash' | 'pathname'>): RouterMatch<Meta> | undefined {
		const path = resolveLocationPath(location, this.#history, this.#base)
		const hit = path === undefined ? undefined : this.#router.match(path)
		if (hit !== undefined || this.#fallback === undefined) return hit
		return this.#router.match(this.#fallback)
	}

	// A hash navigation to the hash the location shows keeps its entry, and a push from an entry
	// that carries no index writes none.
	#push(url: URL): number | undefined {
		const current = this.#position()
		this.#restoring = false
		if (!this.#history && url.hash === window.location.hash) return current
		const index = current === undefined ? undefined : current + 1
		window.history.pushState(
			index === undefined ? null : { index },
			'',
			this.#history ? url.href : url.hash,
		)
		return index
	}

	#position(): number | undefined {
		const state: unknown = window.history.state
		return isRecord(state) && isInteger(state.index) ? state.index : undefined
	}

	#commit(to: RouterMatch<Meta>, index: number | undefined, handle: AbortInterface): void {
		this.#active = to
		this.#index = index
		this.#emissions.add(handle)
		this.#emitter.emit('navigate', to)
		this.#emissions.delete(handle)
	}

	#miss(index: number | undefined): void {
		this.#active = undefined
		this.#index = index
	}

	#defer(path: string): void {
		this.#supersede()
		const handle = createAbort()
		this.#pending.add(handle)
		queueMicrotask(() => {
			if (handle.signal.aborted) return
			this.#pending.delete(handle)
			this.navigate(path)
		})
	}

	#supersede(): void {
		for (const handle of this.#pending) {
			this.#pending.delete(handle)
			handle.abort()
		}
	}

	async #request(
		guard: NonNullable<NavigatorOptions<Meta>['guard']>,
		to: RouterMatch<Meta>,
		from: RouterMatch<Meta> | undefined,
		url: URL,
		handle: AbortInterface,
	): Promise<void> {
		if (await this.#verdict(guard, to, from, handle)) this.#commit(to, this.#push(url), handle)
	}

	async #arrival(
		guard: NonNullable<NavigatorOptions<Meta>['guard']>,
		to: RouterMatch<Meta>,
		from: RouterMatch<Meta> | undefined,
		landed: number | undefined,
		handle: AbortInterface,
	): Promise<void> {
		const allowed = await this.#verdict(guard, to, from, handle)
		if (allowed === undefined) return
		if (allowed) this.#commit(to, landed, handle)
		else this.#restore(landed)
	}

	// A verdict that arrives after its navigation was superseded is absent.
	async #verdict(
		guard: NonNullable<NavigatorOptions<Meta>['guard']>,
		to: RouterMatch<Meta>,
		from: RouterMatch<Meta> | undefined,
		handle: AbortInterface,
	): Promise<boolean | undefined> {
		const allowed = await this.#judge(guard, to, from, handle.signal)
		if (handle.signal.aborted) return undefined
		this.#pending.delete(handle)
		return allowed
	}

	async #judge(
		guard: NonNullable<NavigatorOptions<Meta>['guard']>,
		to: RouterMatch<Meta>,
		from: RouterMatch<Meta> | undefined,
		signal: AbortSignal,
	): Promise<boolean> {
		try {
			return await guard(to, from, signal)
		} catch (error) {
			this.#surface(error)
			return false
		}
	}

	// An entry the navigator did not write carries no index, so the location stays where the
	// browser put it.
	#restore(landed: number | undefined): void {
		const index = this.#index
		if (landed === undefined || index === undefined || landed === index) return
		this.#restoring = true
		window.history.go(index - landed)
	}

	// A guard throw reaches the `error` handler, and a throwing handler is swallowed as the emitter
	// swallows one.
	#surface(error: unknown): void {
		const handler = this.#error
		if (handler === undefined) return
		try {
			handler(error, 'navigate')
		} catch {
			// A throwing error handler is swallowed to prevent recursion.
		}
	}

	// A same-origin link outside `base` is left to the browser.
	#intercepted(event: MouseEvent): void {
		if (event.defaultPrevented || event.button !== 0) return
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
		const anchor = findAnchor(event)
		if (anchor === undefined) return
		if (anchor.target !== '' && anchor.target !== '_self') return
		if (anchor.hasAttribute('download')) return
		const url = new URL(anchor.href, window.location.href)
		if (url.origin !== window.location.origin) return
		const path = resolveLocationPath(url, true, this.#base)
		if (path === undefined) return
		event.preventDefault()
		this.navigate(path)
	}
}
