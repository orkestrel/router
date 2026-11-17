// ============================================================================
//  `Navigator` — the browser navigation face's public contract (the types.ts source
//  of truth; the impl file holds only the class, every type lives here).
//  Headless History/hash navigation over one core `Router<Meta>`:
//  it registers each route's PATTERN once through the shared matching engine,
//  so `:param` extraction, literal-over-param precedence, and trailing-slash
//  insensitivity all come from the SAME machine the core `Dispatcher` composes
//  (one shared engine, native overrides only for a genuine faster path). There is no `render`/`outlet` —
//  the consumer (vanilla DOM, Vue, React) owns rendering; the `Navigator`
//  resolves, tracks `active`, and emits `navigate`.
//
//  `EmitterHooks` / `EmitterErrorHandler` / `EmitterInterface` are imported as
//  types from `@orkestrel/emitter` and never re-exported — consumers import
//  them directly from the emitter package. `RouteEntry` /
//  `RouterInterface` / `RouterMatch` are imported from `@src/core` — the
//  Navigator composes the SAME registry types the core `Router` and
//  `Dispatcher` use, never a local re-declaration.
// ============================================================================

import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'
import type { RouteEntry, RouterInterface, RouterMatch } from '@src/core'

/**
 * Represents the `Navigator`'s event map — the single `navigate` signal a
 * consumer observes.
 *
 * @typeParam Meta - The opaque per-route payload the resolved match carries
 *
 * @remarks
 * `navigate` fires once per successful resolution (start, hashchange/popstate,
 * `navigate()`, link interception) — never for a vetoed or superseded navigation
 * ({@link NavigatorOptions.guard}), and never when a miss's fallback also
 * misses — honest to the one-shared-engine rule: `active` is left `undefined`, nothing emitted.
 * `active` equals the delivered match for every listener of one emission: a `navigate` a
 * listener calls runs in a microtask after the emission ends, so the next emission follows it.
 */
export type NavigatorEventMap<Meta> = {
	readonly navigate: readonly [match: RouterMatch<Meta>]
}

/**
 * Represents the options for `createNavigator` — the `routes` to dispatch between, the
 * navigation substrate, the optional guard hook, and the Emitter pattern's
 * wiring.
 *
 * @typeParam Meta - The opaque payload each route may carry
 *
 * @remarks
 * - `routes` — the route entries to register once with the shared core
 *   `Router` (each `path` compiled once); registration order does NOT decide
 *   precedence — specificity does (literal-over-param-over-wildcard).
 * - `history` — `false` (default, hash mode: `#/…` + `hashchange`, zero
 *   server configuration) or `true` (history mode: `pushState`/`popstate`).
 * - `base` — a history-mode path prefix stripped from `location.pathname`
 *   before matching, and prepended when navigating (`navigate`, link
 *   interception). It is compared in the encoded form `location.pathname`
 *   carries, and a location outside it resolves the `fallback`. Ignored unless
 *   `history` is set.
 * - `fallback` — the route PATTERN to resolve when the current location
 *   matches NOTHING. Omitted ⇒ the first route's path. A `fallback` that
 *   itself matches no registered route leaves `active` `undefined` and emits
 *   nothing — honest to the one-shared-engine rule: no phantom match is fabricated.
 * - `guard` — `(to, from, signal) => boolean | Promise<boolean>`, called
 *   before a navigation commits; a `false`/rejected verdict, or one arriving
 *   after the navigation was SUPERSEDED (`signal.aborted`), is discarded —
 *   `active` stays unchanged and nothing is emitted. `navigate` and an
 *   intercepted link ask the guard before the URL moves, so a veto leaves the
 *   location unchanged too. After a `popstate` or `hashchange` veto, the
 *   navigator moves the browser back to the entry `active` describes when
 *   both entries carry the index it writes into `history.state`; an entry it
 *   did not write leaves the location for the consumer to reconcile with
 *   `active`. `signal` fires when a
 *   NEWER navigation starts (or on `stop`/`destroy`), so a slow async guard
 *   can cancel its own work off it. A throw routes to the `error` handler
 *   described later in this list and vetoes the navigation.
 * - `intercept` — opt-in same-origin `<a>` click interception (history mode
 *   only): a plain left-click on a same-origin link inside `base` with no
 *   modifier keys, no `target`, and no `download` attribute is intercepted
 *   into `navigate`; a link outside `base` navigates natively.
 * - `sensitive` — forwarded to the underlying `Router` (default `true`).
 * - `on` — initial `NavigatorEventMap` listeners (the Emitter pattern's
 *   similar-surface pin).
 * - `error` — the emitter's listener-error handler; ALSO the
 *   handler a thrown {@link guard} routes to (the Navigator's own pipeline,
 *   not a listener throw, so it is surfaced through the same channel).
 */
export interface NavigatorOptions<Meta> {
	readonly routes: ReadonlyArray<RouteEntry<Meta>>
	readonly history?: boolean
	readonly base?: string
	readonly fallback?: string
	readonly guard?: (
		to: RouterMatch<Meta>,
		from: RouterMatch<Meta> | undefined,
		signal: AbortSignal,
	) => boolean | Promise<boolean>
	readonly intercept?: boolean
	readonly sensitive?: boolean
	readonly on?: EmitterHooks<NavigatorEventMap<Meta>>
	readonly error?: EmitterErrorHandler
}

/**
 * Represents the headless History/hash navigation entity contract (the
 * behavioral-interface role for the one-class-per-file `Navigator`). Composes a core
 * `Router<Meta>`, resolves the current location on `start()` and on every subsequent
 * navigation event, tracks `active`, and emits `navigate` through the
 * {@link EmitterInterface}.
 *
 * @typeParam Meta - The opaque per-route payload a match carries back
 *
 * @remarks
 * Rendering stays outside this contract: a consumer subscribes to `navigate` and
 * renders whatever the resolved match names.
 */
export interface NavigatorInterface<Meta> {
	/**
	 * Holds the underlying registry, exposed readonly for introspection — the same
	 * object the routes were registered on.
	 */
	readonly router: RouterInterface<Meta>
	/** Holds the observable surface for {@link NavigatorEventMap}. */
	readonly emitter: EmitterInterface<NavigatorEventMap<Meta>>
	/**
	 * Holds the resolved {@link RouterMatch}, or `undefined` before the first resolve
	 * and whenever a miss's fallback also misses.
	 */
	readonly active: RouterMatch<Meta> | undefined
	/**
	 * Begins listening and resolves the current location — idempotent, so a second call
	 * is a no-op.
	 *
	 * @remarks
	 * Hash mode binds `hashchange`; history mode binds `popstate` and, where `intercept`
	 * is set, same-origin link interception. The current history entry gets
	 * `{ index: 0 }` as its `history.state` when it carries no index. After `destroy`,
	 * it does nothing.
	 */
	start(): void
	/** Stops listening and aborts any pending guard — idempotent. */
	stop(): void
	/**
	 * Navigates programmatically — runs the guard, then pushes the entry (`#path` in hash
	 * mode, the `base`-joined path in history mode) and commits.
	 *
	 * @remarks
	 * The pushed entry's `history.state` is `{ index }`, one past the current entry's.
	 * A hash navigation to the hash the location shows keeps its entry and resolves
	 * directly. Thrown when the history-mode path resolves on another origin: a
	 * `ContractError` coded `pattern`. After `destroy`, it does nothing.
	 */
	navigate(path: string): void
	/** Stops listening, aborts any pending guard, and tears down the emitter. */
	destroy(): void
}
