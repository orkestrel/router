# Router

> The pure, environment-agnostic core (PROPOSAL §5.1): a registry-and-match
> engine (`Router`) plus a fetch-standard, method-dimensioned dispatcher
> (`Dispatcher`) layered over one internal `Router<RouteRecord<TState>>`.
> Neither entity touches DOM or `node:*` — only `URL` / `Request` / `Response`
> / `AbortSignal`, universal web-standard globals available in every runtime
> this package targets. `Router` is the ONE shared machine both the browser
> `Navigator` and the core `Dispatcher` compose — literal-over-param-over-
> wildcard precedence, trailing-slash folding, tolerant percent-decoding, and
> the `answers` native-override seam all come from this single engine
> (AGENTS §21 "one engine, native overrides"). Source: [`src/core`](../../src/core).
> Surfaced through the `@orkestrel/router` barrel (aliased `@src/core` inside
> this repo).

## Surface

Register routes on a `Router`, resolve the most-specific match, and dispatch
fetch-standard requests through a `Dispatcher`:

```ts
import { createDispatcher, createRouter } from '@src/core'

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

Path patterns are `/`-prefixed: a literal segment (`/users`), a `:name` param
(one segment), or a final `*name` wildcard (captures the rest of the path).
Matching is case-sensitive by default (`sensitive: false` opts out); a single
trailing slash is always optional except on the root `/` and the empty
pattern (PROPOSAL §4).

### Factories

| API                | Kind     | Summary                                                                   |
| ------------------ | -------- | ------------------------------------------------------------------------- |
| `createRouter`     | function | Create a `RouterInterface<Meta>` — the shared matching + registry engine. |
| `createDispatcher` | function | Create a `DispatcherInterface<TState>` over one internal `Router`.        |

### Constants

| API             | Kind  | Summary                                                                  |
| --------------- | ----- | ------------------------------------------------------------------------ |
| `METHODS`       | const | The seven registrable HTTP methods (`GET`…`OPTIONS`) as a `ReadonlySet`. |
| `TIER_LITERAL`  | const | The highest path-segment specificity tier (a literal segment).           |
| `TIER_PARAM`    | const | The middle path-segment specificity tier (a `:name` param).              |
| `TIER_WILDCARD` | const | The lowest path-segment specificity tier (a final `*name` wildcard).     |

### Helpers

| API                  | Kind     | Summary                                                                         |
| -------------------- | -------- | ------------------------------------------------------------------------------- |
| `escapeRegExp`       | function | Escape regex metacharacters in a literal string.                                |
| `canonicalPath`      | function | Strip one trailing slash off a path pattern (except `/` and `''`).              |
| `compilePath`        | function | Compile a path pattern into an anchored regex + ordered param names.            |
| `decodeParam`        | function | URL-decode one captured param, tolerating a malformed `%` escape.               |
| `matchPath`          | function | Extract decoded params from a compiled path against a pathname, or `undefined`. |
| `classifySegment`    | function | Classify one path segment into its specificity tier.                            |
| `parseMethod`        | function | Narrow a raw `request.method` string into a typed `Method`, or `undefined`.     |
| `pathSpecificity`    | function | Compute a path's per-segment specificity vector.                                |
| `compareSpecificity` | function | Compare two paths by specificity for a descending sort.                         |
| `joinPaths`          | function | Join a group prefix and a route path into one `/`-prefixed path.                |

### Entities

| API             | Kind  | Summary                                                                         |
| --------------- | ----- | ------------------------------------------------------------------------------- |
| `Router`        | class | The path-matching + registry engine; entries compiled once, most-specific wins. |
| `Group`         | class | A prefix-scoped registration handle over a `Router` (pure string composition).  |
| `Dispatcher`    | class | The fetch-standard, method-dimensioned dispatch entity over one `Router`.       |
| `DispatchGroup` | class | A prefix-scoped registration handle over a `Dispatcher`.                        |

### Types

| Type                     | Kind      | Shape                                                                                             |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------- |
| `PathParams`             | type      | Template-literal param extraction: `'/users/:id'` → `{ readonly id: string }`.                    |
| `PathParamsRaw`          | type      | The recursive, unflattened extractor behind `PathParams`; walks one path segment at a time.       |
| `IdentifierStartChar`    | type      | The identifier-grammar START char union (`[A-Za-z_]`) a type-level param name may begin with.     |
| `IdentifierChar`         | type      | The identifier-grammar CONTINUATION char union (`[A-Za-z0-9_]`) after the first char.             |
| `TakeIdentifierTail`     | type      | Char-by-char consumer of an identifier-continuation run off the front of a string literal.        |
| `IdentifierHead`         | type      | The identifier captured at the front of a string literal (empty when it doesn't start one).       |
| `SegmentParam`           | type      | One path segment's type-level param contribution — mirrors the runtime `classifySegment` grammar. |
| `CompiledPath`           | interface | `{ regex: RegExp; params: readonly string[] }` — a compiled route pattern.                        |
| `RouteEntry`             | interface | `{ path: string; meta: Meta; name?: string }` — one registered entry.                             |
| `RouterMatch`            | interface | `{ path; params; meta; name? }` — the winning entry a `match` call returns.                       |
| `RouterAnswers`          | type      | `(meta: Meta) => boolean` — the native-override seam passed to `match`.                           |
| `RouterOptions`          | interface | `{ entries?; sensitive?; key? }` — options for `createRouter` / the constructor.                  |
| `RouterInterface`        | interface | `count` data member + `add` / `match` / `entries` / `group` / `clear`.                            |
| `GroupInterface`         | interface | `prefix` data member + `add` / `group`, forwarding to the owning router.                          |
| `Method`                 | type      | The seven registrable HTTP methods (`'GET' \| 'POST' \| … \| 'OPTIONS'`).                         |
| `RouteContext`           | interface | `{ params; pattern; url; state }` — the ambient context a `RouteHandler` receives.                |
| `RouteHandler`           | type      | `(request, context) => Response \| Promise<Response>` — one route's handler.                      |
| `RouteInput`             | interface | `{ method; path; handler; name? }` — one `Dispatcher.add` registration input.                     |
| `RouteRecord`            | interface | `{ method; handler; name? }` — the `meta` payload a `Dispatcher` stores in its `Router`.          |
| `DispatchResult`         | type      | `'matched' \| 'unmethoded' \| 'unmatched'` discriminated union — `Dispatcher.match`'s outcome.    |
| `DispatcherEventMap`     | type      | `{ match: […]; miss: […] }` — the `Dispatcher`'s AGENTS §13 event map.                            |
| `DispatcherOptions`      | interface | `{ routes?; sensitive?; unmatched?; unmethoded?; on?; error? }` — options for `createDispatcher`. |
| `DispatcherInterface`    | interface | `router` / `emitter` data members + `add` / `group` / `match` / `handle` / `destroy`.             |
| `DispatchGroupInterface` | interface | `prefix` data member + `add` / `group`, forwarding to the owning dispatcher.                      |

The `count` member of `RouterInterface`, the `prefix` members of
`GroupInterface` / `DispatchGroupInterface`, and the `router` / `emitter`
members of `DispatcherInterface` are `readonly` data members (Surface rows,
above) — the call-signature methods of `RouterInterface` and
`DispatcherInterface` are documented under [Methods](#methods).

## Methods

The public methods of `RouterInterface` and `DispatcherInterface` — every
call-signature member listed (their `readonly` data members stay Surface
rows). `Router` and `Dispatcher` implement their interfaces exactly, so this
doubles as each class's instance-method surface (AGENTS §22).

#### `RouterInterface`

`add` registers one/many entries (§9.2 batch), compiling each path once;
`match` resolves the most-specific matching entry, optionally filtered by the
`answers` seam; `entries` lists all entries, or only those matching a
pathname (the Allow-set source); `group` scopes a prefixed registration
handle; `clear` is the §10 reset.

| Method    | Returns                    | Behavior                                                                          |
| --------- | -------------------------- | --------------------------------------------------------------------------------- |
| `add`     | `void`                     | Register one entry, or many (§9.2 batch); throws `TypeError` on a malformed path. |
| `match`   | `RouterMatch \| undefined` | Resolve the most-specific matching entry for a pathname, or `undefined`.          |
| `entries` | `readonly RouteEntry[]`    | All registered entries, or only those whose path matches a given pathname.        |
| `group`   | `GroupInterface`           | A prefix-scoped registration handle over this router.                             |
| `clear`   | `void`                     | Drop every entry (§10); the router stays usable.                                  |

#### `DispatcherInterface`

`add` registers one/many route inputs (§9.2 batch); `group` scopes a
prefixed registration handle; `match` is the raw method+pathname decision;
`handle` runs the full fetch dispatch (auto-`HEAD`, auto-`OPTIONS`,
`unmatched`/`unmethoded` responders); `destroy` is the §10 teardown.

| Method    | Returns                  | Behavior                                                                                        |
| --------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `add`     | `void`                   | Register one route input, or many (§9.2 batch); throws `TypeError` on a malformed registration. |
| `group`   | `DispatchGroupInterface` | A prefix-scoped registration handle over this dispatcher.                                       |
| `match`   | `DispatchResult`         | The raw `'matched' \| 'unmethoded' \| 'unmatched'` decision for a method + pathname pair.       |
| `handle`  | `Promise<Response>`      | The full dispatch: parse, match, run the handler (or the `unmatched`/`unmethoded` responder).   |
| `destroy` | `void`                   | Tear down the `#emitter`; the underlying `router` is left registered (not cleared).             |

## Contract

These invariants hold across `src/core` ↔ `router.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `interface` /
   `type` / `const` row in the `## Surface` tables is a real export of
   `src/core`, and every export appears as a Surface row — exhaustive, both
   directions (AGENTS §22).
2. **DOC ↔ SOURCE method bijection.** The `## Methods` tables list exactly
   `RouterInterface`'s and `DispatcherInterface`'s public methods —
   exhaustive, both directions — and `Router` / `Dispatcher` expose the same
   public methods, no more (AGENTS §22).
3. **Path grammar (PROPOSAL §4).** Three segment kinds: literal (`/users`),
   param (`:name`, one segment), wildcard (`*name`, final segment only,
   captures the rest of the path including slashes). A wildcard anywhere but
   the final segment throws `TypeError` at compile time (§14 boundary guard).
4. **Precedence tiers.** Literal (`TIER_LITERAL`, 2) > param (`TIER_PARAM`, 1)
   > wildcard (`TIER_WILDCARD`, 0), compared left-to-right at the earliest
   > differing segment; registration-order-independent. A shorter pattern that
   > is a prefix of a longer one ranks below it. Equal-specificity ties (only
   > possible between distinct wildcard shapes) resolve to the earliest
   > registered.
5. **Trailing slash is insensitive.** A single trailing slash on the request
   path is always optional, folded both at registration (`canonicalPath`)
   and at match time — except the root `/` and the empty pattern, which are
   exempt and anchor exactly.
6. **Case-sensitive by default.** `sensitive: true` (`Router`/`Dispatcher`
   construction) is the default; `sensitive: false` folds case during
   matching without altering the pattern's own stored casing.
7. **Dedup via `key`.** When `RouterOptions.key` is set, an entry whose
   computed key already exists REPLACES the prior entry in place (last write
   wins, no engine rebuild); `Dispatcher` always constructs its internal
   `Router` with `key: (entry) => \`${entry.meta.method} ${entry.path}\``.
8. **The `answers` seam.** `RouterInterface.match`'s optional
   `RouterAnswers<Meta>` predicate is the single native-override point both
   faces compose differently: the `Dispatcher` passes a method-check, the
   browser `Navigator` (see [`navigator.md`](navigator.md)) omits it entirely
   — every path match answers.
9. **Dispatch semantics (PROPOSAL §5.1).** A `HEAD` request with no explicit
   `HEAD` route runs the matching `GET` handler and strips the response
   body. An `OPTIONS` request with no explicit `OPTIONS` route answers `204`
   with a derived `Allow` header (from `router.entries(pathname)`, `GET`
   implying `HEAD`). A path-matches-but-method-doesn't dispatch invokes the
   `unmethoded` responder (default `405` + `Allow`); nothing matching invokes
   the `unmatched` responder (default `404`). **A handler throw propagates
   uncaught** — the dispatcher never invents an error boundary (that is the
   consuming server's policy, PROPOSAL §7).
10. **Wildcard trailing-slash capture is asymmetric with param folding
    (intended).** A final `*name` wildcard captures ANY trailing slash on the
    request path into its own captured value (`/files/a/b/` → `rest: 'a/b/'`)
    — unlike a `:name` param segment, whose own trailing slash is folded away
    by the shared trailing-slash-insensitivity rule (§5 above). This is
    deliberate: the wildcard's capture is "the rest of the path, verbatim,"
    including whatever trailing slash the caller sent.
11. **Event map.** `DispatcherEventMap` carries `match` (emitted on every
    dispatch that resolves to a handler, including derived `HEAD`/`OPTIONS`)
    and `miss` (emitted on every non-matching dispatch, tagged
    `'unmatched'`/`'unmethoded'`) — AGENTS §13, no `error`/`observerError`
    domain event (listener errors route through the emitter's own `error`
    option).

## Patterns

### Groups and dedup

`group(prefix)` scopes a registration handle that composes its prefix onto
every entry it registers on the SAME underlying router; a `key` function
lets a later registration replace an earlier one in place instead of adding
a duplicate candidate.

```ts
import { createRouter } from '@src/core'

const router = createRouter<{ readonly page: string }>({
	key: (entry) => entry.path,
})
const api = router.group('/api')
api.add({ path: '/users', meta: { page: 'list' } })
router.match('/api/users')?.path // '/api/users'

router.add({ path: '/api/users', meta: { page: 'list-v2' } }) // replaces the prior entry
```

### Wildcard capture and precedence

A literal segment always outranks a param, which always outranks a wildcard,
compared left-to-right at the earliest differing segment:

```ts
import { createRouter } from '@src/core'

const router = createRouter<{ readonly handler: string }>()
router.add([
	{ path: '/files/*rest', meta: { handler: 'catchAll' } },
	{ path: '/files/:name', meta: { handler: 'named' } },
	{ path: '/files/readme', meta: { handler: 'literal' } },
])
router.match('/files/readme')?.meta.handler // 'literal'
router.match('/files/other')?.meta.handler // 'named'
router.match('/files/a/b.png')?.meta.handler // 'catchAll'
```

### Method-dimensioned dispatch (auto-HEAD, auto-OPTIONS, 405)

```ts
import { createDispatcher } from '@src/core'

const dispatcher = createDispatcher()
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })

const head = await dispatcher.handle(new Request('http://x/health', { method: 'HEAD' }), undefined)
head.body // null — auto-HEAD strips the GET handler's body

const options = await dispatcher.handle(
	new Request('http://x/health', { method: 'OPTIONS' }),
	undefined,
)
options.headers.get('Allow') // 'GET, HEAD, OPTIONS'

const notAllowed = await dispatcher.handle(
	new Request('http://x/health', { method: 'DELETE' }),
	undefined,
)
notAllowed.status // 405
```

### Observing dispatch outcomes

```ts
import { createDispatcher } from '@src/core'

const dispatcher = createDispatcher({
	on: {
		match: (method, pattern) => console.log('matched', method, pattern),
		miss: (method, pathname, kind) => console.log('missed', method, pathname, kind),
	},
})
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
await dispatcher.handle(new Request('http://x/missing'), undefined) // logs a 'miss'
```

### Introspection and reset

`entries()` lists every registration (or only those matching a pathname —
the same set a 405 response's `Allow` header derives from); `clear()` drops
every entry while leaving the router usable; `Dispatcher.destroy()` tears
down its emitter.

```ts
import { createDispatcher, createRouter } from '@src/core'

const router = createRouter<{ readonly page: string }>()
router.add([
	{ path: '/users/:id', meta: { page: 'profile' } },
	{ path: '/tokens', meta: { page: 'tokens' } },
])
router.entries().length // 2
router.entries('/users/7').length // 1 — only the matching entry
router.clear()
router.entries().length // 0 — the router stays usable

const dispatcher = createDispatcher()
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
dispatcher.destroy() // tears down the #emitter; router.entries() is still valid afterward
```

### Practices

- **One engine, two seams** — compose `Router` directly for a method-less
  consumer (a Navigator), or through `Dispatcher` for method-dimensioned
  fetch dispatch; never rebuild the matching logic per face (AGENTS §21).
- **Guard the registration boundary, not the hot path** — `add` throws on a
  malformed entry; `match`/`handle` carry zero guards (AGENTS §14).
- **Let handler throws propagate** — the dispatcher is not an error
  boundary; a consuming server installs its own around `handle`.
- **Dedup with `key`, not manual lookups** — pass a `key` function instead of
  checking `router.entries()` before every `add`.

## Tests

- [`tests/src/core/Router.test.ts`](../../tests/src/core/Router.test.ts) —
  registration boundary guard, method-less matching, order-independent
  literal-over-param-over-wildcard precedence, wildcard capture, the
  `answers` seam, `entries()` (all + filtered), dedup via `key`, `group`
  registration and nesting, case sensitivity, and `RouterInterface`
  conformance.
- [`tests/src/core/helpers.test.ts`](../../tests/src/core/helpers.test.ts) —
  `escapeRegExp`, `canonicalPath`, `compilePath` (literal/param/wildcard,
  trailing-slash folding, case sensitivity, the wildcard-not-final throw),
  `decodeParam` (including a malformed `%` escape), `matchPath`,
  `classifySegment` (the literal-vs-param classification fix regression
  case), `pathSpecificity`, `compareSpecificity`, and `joinPaths`.

## See also

- [`AGENTS.md`](../../AGENTS.md) — the rules; §13 the Emitter pattern, §14
  contract & validation architecture, §21 "one engine, native overrides",
  §22 documentation-as-contracts.
- [`PROPOSAL.md`](../../PROPOSAL.md) — §4 path grammar, §5.1 the core public
  API and dispatch semantics.
- [`navigator.md`](navigator.md) — the browser face composing this same
  `Router` engine.
- [`listener.md`](listener.md) — the server face converting `node:http`
  messages into `Dispatcher.handle` calls.
- [`README.md`](../README.md) — the guides index.
