# Navigator

> The browser navigation face (PROPOSAL §5.2): headless History/hash
> navigation over one core `Router<RouteEntry<Meta>>`. There is no
> `render`/`outlet` — the `Navigator` resolves the current location, tracks
> `active`, and emits `navigate`; the consumer (vanilla DOM, Vue, React, or a
> future server-driven UI) owns rendering entirely. Every route is registered
> once through the SAME matching engine [`router.md`](router.md) documents —
> `:param` extraction, literal-over-param-over-wildcard precedence, and
> trailing-slash insensitivity all come from that one machine (AGENTS §21).
> Source: [`src/browser`](../../src/browser). Surfaced through the
> `@orkestrel/router` barrel (aliased `@src/browser` inside this repo).

## Surface

Register routes, start listening, and navigate:

```ts
import { createNavigator } from '@src/browser'

const navigator = createNavigator({
	routes: [
		{ path: '/users/:id', meta: { title: 'User' } },
		{ path: '/tokens', meta: { title: 'Tokens' } },
	],
	on: { navigate: (match) => (document.title = match.meta.title) },
})
navigator.start() // resolves the current hash now, and on every hashchange
navigator.go('/tokens')
```

Default mode is `'hash'` (`#/…` + `hashchange`, zero server configuration);
`mode: 'history'` uses `pushState`/`popstate` with an optional `base` prefix
and opt-in same-origin `<a>` click `intercept`ion. An optional `guard(to,
from, signal)` may veto (or asynchronously veto) a navigation before it
commits.

### Factories

| API               | Kind     | Summary                                                          |
| ----------------- | -------- | ---------------------------------------------------------------- |
| `createNavigator` | function | Create a `NavigatorInterface<Meta>` composing one core `Router`. |

### Helpers

| API            | Kind     | Summary                                                               |
| -------------- | -------- | --------------------------------------------------------------------- |
| `hashPath`     | function | Extract the `/`-prefixed pathname from a `location.hash` value.       |
| `locationPath` | function | Resolve the `/`-prefixed pathname to match for the current location.  |
| `findAnchor`   | function | Find the nearest enclosing `<a>` element a DOM event originated from. |

### Entities

| API         | Kind  | Summary                                                                  |
| ----------- | ----- | ------------------------------------------------------------------------ |
| `Navigator` | class | The headless History/hash navigation entity composing one core `Router`. |

### Types

| Type                 | Kind      | Shape                                                                                         |
| -------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `NavigatorEventMap`  | type      | `{ navigate: [match: RouterMatch<Meta>] }` — the `Navigator`'s AGENTS §13 event map.          |
| `NavigatorMode`      | type      | `'hash' \| 'history'` — the navigation substrate.                                             |
| `NavigatorOptions`   | interface | `{ routes; mode?; base?; fallback?; guard?; intercept?; sensitive?; on?; error? }`.           |
| `NavigatorInterface` | interface | `router` / `emitter` / `active` data members + `start` / `stop` / `go` / `match` / `destroy`. |

The `router`, `emitter`, and `active` members of `NavigatorInterface` are
`readonly` data members (Surface rows, above) — its call-signature methods
are documented under [Methods](#methods).

## Methods

The public methods of `NavigatorInterface` — every call-signature member
listed (its `readonly` data members `router` / `emitter` / `active` stay
Surface rows). `Navigator` implements the interface exactly, so this doubles
as the class's instance-method surface (AGENTS §22).

#### `NavigatorInterface`

`start` begins listening and resolves the current location now; `stop` stops
listening; `go` navigates programmatically; `match` is a pure lookup with no
side effects; `destroy` is the §10 teardown.

| Method    | Returns                    | Behavior                                                                                          |
| --------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `start`   | `void`                     | Begin listening (`hashchange`/`popstate` + optional interception) and resolve now (idempotent).   |
| `stop`    | `void`                     | Stop listening and abort any pending guard (idempotent).                                          |
| `go`      | `void`                     | Navigate programmatically — set the hash or `pushState`, then resolve.                            |
| `match`   | `RouterMatch \| undefined` | A pure lookup through the underlying `Router` — no location read, no fallback, no guard, no emit. |
| `destroy` | `void`                     | `stop()` plus tear down the `#emitter`.                                                           |

## Contract

These invariants hold across `src/browser` ↔ `navigator.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `interface` /
   `type` row in the `## Surface` tables is a real export of `src/browser`,
   and every export appears as a Surface row — exhaustive, both directions
   (AGENTS §22).
2. **DOC ↔ SOURCE method bijection.** The `## Methods` table lists exactly
   `NavigatorInterface`'s public methods — exhaustive, both directions — and
   `Navigator` exposes the same public methods, no more (AGENTS §22).
3. **Headless by design.** No `render`/`outlet`. The `Navigator` resolves,
   tracks `active`, and emits `navigate`; rendering is entirely the
   consumer's responsibility (PROPOSAL §5.2).
4. **One shared engine.** Each route's `path` is registered once on the same
   `Router` machine the core `Dispatcher` composes (see [`router.md`](router.md)),
   keyed for dedup by its `canonicalPath` (last write wins, replace-in-place).
   `Navigator` never rebuilds matching logic of its own.
5. **Modes.** `'hash'` (default) reads/writes `location.hash` and binds
   `hashchange`; `'history'` reads/writes via `pushState`/`popstate`, with an
   optional `base` path prefix stripped before matching and prepended when
   navigating. `intercept: true` (`'history'` mode only) adds same-origin
   `<a>` click interception — a plain left-click with no modifier keys, no
   `target`, and no `download` attribute.
6. **Fallback semantics.** A location that matches nothing resolves the
   configured `fallback` pattern (default: the first route's path) through
   the SAME engine. A `fallback` that ALSO matches no registered route
   leaves `active` `undefined` and emits nothing — no phantom match is ever
   fabricated.
7. **Guard + supersede semantics.** An optional `guard(to, from, signal)` may
   veto (or asynchronously veto) a navigation. The `Navigator` mints an
   `@orkestrel/abort` handle per navigation and aborts the PREVIOUS handle
   when a newer navigation starts (or on `stop`/`destroy`) — a guard verdict
   that resolves after its navigation was superseded (`signal.aborted`) is
   discarded, same as a synchronous `false`/rejected verdict: `active` stays
   unchanged and nothing is emitted. A guard throw routes to the `error`
   handler (not through the emitter's own `emit`) and vetoes.
8. **Case-sensitive by default.** `sensitive: true` (forwarded to the
   underlying `Router`) is the default; `sensitive: false` folds case during
   matching.
9. **Intercepted links carry pathname only (known limitation).** Click
   interception passes only the intercepted link's `/`-prefixed pathname
   through to `go` — a query string on the link's `href` is NOT preserved
   (the pathname-only grammar §4 has no query concept). A consumer needing
   query data reads it from `window.location.search` after navigating, or
   skips interception for that link.
10. **Only HTML `<a>` elements are intercepted (known limitation).** Click
    interception ({@link findAnchor}) walks up the event's composed path for
    an `HTMLAnchorElement` — an SVG `<a>` (`SVGAElement`) is NOT intercepted,
    even inside a same-origin document, and falls through to the browser's
    native navigation.

## Patterns

### Hash-mode navigation

```ts
import { createNavigator } from '@src/browser'

const navigator = createNavigator({
	routes: [
		{ path: '/', meta: { title: 'Home' } },
		{ path: '/about', meta: { title: 'About' } },
	],
})
navigator.emitter.on('navigate', (match) => (document.title = match.meta.title))
navigator.start()
navigator.go('/about')
navigator.active?.path // '/about'
navigator.stop()
navigator.destroy() // stop() plus tear down the #emitter
```

### History mode with link interception

```ts
import { createNavigator } from '@src/browser'

const navigator = createNavigator({
	routes: [{ path: '/users/:id', meta: { title: 'User' } }],
	mode: 'history',
	base: '/app',
	intercept: true,
})
navigator.start() // binds popstate + same-origin <a> click interception
```

### Guarding navigation (auth walls)

A guard may veto synchronously or asynchronously; a superseded guard's
verdict is discarded via its own `signal`.

```ts
import { createNavigator } from '@src/browser'

const navigator = createNavigator({
	routes: [
		{ path: '/private', meta: { title: 'Private' } },
		{ path: '/', meta: { title: 'Home' } },
	],
	guard: async (to, _from, signal) => {
		const allowed = await checkAuth({ signal }) // cancels its own work if superseded
		return signal.aborted ? false : allowed
	},
})
navigator.start()
```

### Practices

- **Never build a second registry** — compose the same core `Router` other
  faces use; a `Navigator` never hand-rolls its own path matching.
- **Thread `signal` into async guard work** — a slow guard can cancel its own
  work when it observes `signal.aborted`, closing the stale-guard race.
- **Keep rendering outside the Navigator** — subscribe to `navigate` and
  render in the consumer, never inside this headless entity.
- **`stop()`/`destroy()` before disposal** — releases listeners and aborts
  any pending guard; `destroy()` also tears down the `#emitter`.

## Tests

- [`tests/src/browser/Navigator.test.ts`](../../tests/src/browser/Navigator.test.ts) —
  hash and history modes, `go`/`active`/`navigate` events, fallback semantics,
  guard veto (sync + async, including supersede-discard), link interception
  on/off, `start`/`stop`/`destroy` idempotence, and `NavigatorInterface`
  conformance.
- [`tests/src/browser/factories.test.ts`](../../tests/src/browser/factories.test.ts) —
  `createNavigator` returns a working `NavigatorInterface`.
- [`tests/src/browser/helpers.test.ts`](../../tests/src/browser/helpers.test.ts) —
  `hashPath`, `locationPath` (hash + history, with/without `base`), and
  `findAnchor` (including a click on a styled child inside an anchor).

## See also

- [`AGENTS.md`](../../AGENTS.md) — the rules; §13 the Emitter pattern, §21
  "one engine, native overrides", §22 documentation-as-contracts.
- [`PROPOSAL.md`](../../PROPOSAL.md) — §5.2 the browser face's public API
  and deliberate changes from the old browser router.
- [`router.md`](router.md) — the shared core `Router` engine this face
  composes.
- [`abort.md`](abort.md) — `@orkestrel/abort`, the supersede-safe guard
  cancellation primitive this face composes.
- [`README.md`](../README.md) — the guides index.
