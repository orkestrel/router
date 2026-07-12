// ============================================================================
//  `Navigator` — the browser navigation face's public contract (the §5 source
//  of truth; the impl file holds only the class, every type lives here).
//  Headless History/hash navigation over one core `Router<RouteEntry<Meta>>`:
//  it registers each route's PATTERN once through the shared matching engine,
//  so `:param` extraction, literal-over-param precedence, and trailing-slash
//  insensitivity all come from the SAME machine the core `Dispatcher` composes
//  (AGENTS §21 "one engine, native overrides"). There is no `render`/`outlet` —
//  the consumer (vanilla DOM, Vue, React) owns rendering; the `Navigator`
//  resolves, tracks `active`, and emits `navigate`.
//
//  `EmitterHooks` / `EmitterErrorHandler` / `EmitterInterface` are imported as
//  types from `@orkestrel/emitter` and never re-exported (AGENTS §6) —
//  consumers import them directly from the emitter package. `RouteEntry` /
//  `RouterInterface` / `RouterMatch` are imported from `@src/core` — the
//  Navigator composes the SAME registry types the core `Router` and
//  `Dispatcher` use, never a local re-declaration.
// ============================================================================

import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'
import type { RouteEntry, RouterInterface, RouterMatch } from '@src/core'

/**
 * The `Navigator`'s event map (AGENTS §13) — the single `navigate` signal a
 * consumer observes.
 *
 * @typeParam Meta - The opaque per-route payload the resolved match carries
 *
 * @remarks
 * `navigate` fires once per successful resolution (start, hashchange/popstate,
 * `navigate()`, link interception) — never for a vetoed or superseded navigation
 * ({@link NavigatorOptions.guard}), and never when a miss's fallback also
 * misses (§21-honest: `active` is left `undefined`, nothing emitted).
 */
export type NavigatorEventMap<Meta> = {
	readonly navigate: readonly [match: RouterMatch<Meta>]
}

/**
 * Options for `createNavigator` — the `routes` to dispatch between, the
 * navigation substrate, the optional guard hook, and the AGENTS §13 emitter
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
 *   interception). Ignored unless `history` is set.
 * - `fallback` — the route PATTERN to resolve when the current location
 *   matches NOTHING. Omitted ⇒ the first route's path. A `fallback` that
 *   itself matches no registered route leaves `active` `undefined` and emits
 *   nothing (§21-honest: no phantom match is fabricated).
 * - `guard` — `(to, from, signal) => boolean | Promise<boolean>`, called
 *   before a navigation commits; a `false`/rejected verdict, or one arriving
 *   after the navigation was SUPERSEDED (`signal.aborted`), is discarded —
 *   `active` stays unchanged and nothing is emitted. `signal` fires when a
 *   NEWER navigation starts (or on `stop`/`destroy`), so a slow async guard
 *   can cancel its own work off it. A throw routes to the `error` handler
 *   below and vetoes the navigation.
 * - `intercept` — opt-in same-origin `<a>` click interception (history mode
 *   only): a plain left-click on a same-origin link with no modifier keys,
 *   no `target`, and no `download` attribute is intercepted into `navigate`.
 * - `sensitive` — forwarded to the underlying `Router` (default `true`).
 * - `on` — initial `NavigatorEventMap` listeners (AGENTS §8/§13).
 * - `error` — the emitter's listener-error handler (AGENTS §13); ALSO the
 *   handler a thrown {@link guard} routes to (the Navigator's own pipeline,
 *   not a listener throw, so it is surfaced through the same channel).
 */
export interface NavigatorOptions<Meta> {
	readonly routes: readonly RouteEntry<Meta>[]
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
 * The headless History/hash navigation entity contract (the §4.5 behavioral-
 * interface role for the one-class-per-file `Navigator`). Composes a core
 * `Router<RouteEntry<Meta>>`, resolves the current location on `start()` and
 * on every subsequent navigation event, tracks `active`, and emits
 * `navigate` through the AGENTS §13 {@link EmitterInterface}.
 *
 * @typeParam Meta - The opaque per-route payload a match carries back
 *
 * @remarks
 * - `router` — the underlying registry, exposed READONLY for introspection
 *   (the same object routes were registered on).
 * - `emitter` — the AGENTS §13 observable surface for {@link NavigatorEventMap}.
 * - `active` — the currently-resolved {@link RouterMatch}, or `undefined`
 *   before the first resolve (or when a miss's fallback also misses).
 * - `start()` — begin listening (`hashchange` in hash mode; `popstate` +
 *   optional link interception in history mode) and resolve the current
 *   location now. Idempotent — a second call is a no-op.
 * - `stop()` — stop listening. Idempotent.
 * - `navigate(path)` — navigate programmatically: sets `location.hash` (hash
 *   mode) or calls `history.pushState` (history mode), then resolves. A
 *   no-op hash navigation (already the active hash) resolves directly, since
 *   no `hashchange` would otherwise fire.
 * - `match(path)` — a PURE lookup through the underlying `Router`: no
 *   location read, no fallback, no guard, no emit.
 * - `destroy()` — `stop()` plus tear down the `#emitter` (AGENTS §13).
 */
export interface NavigatorInterface<Meta> {
	readonly router: RouterInterface<RouteEntry<Meta>>
	readonly emitter: EmitterInterface<NavigatorEventMap<Meta>>
	readonly active: RouterMatch<Meta> | undefined
	start(): void
	stop(): void
	navigate(path: string): void
	match(path: string): RouterMatch<Meta> | undefined
	destroy(): void
}
