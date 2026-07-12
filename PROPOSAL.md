# PROPOSAL — `@orkestrel/router`

A typed, environment-agnostic routing library: one pure matching-and-registry
core, a browser navigation face, and a server dispatch face — the router the
server _consumes_, never the server itself.

> **Status: awaiting approval.** The `old/` folder (the original implementation,
> kept for reference) is deleted the moment this proposal is approved and the
> rebuild lands. Nothing in `old/` ships.

---

## 1. Why the original missed the mark

The autopsy (direct read + independent review) is unambiguous. Of ~6,300 lines
of source, the genuinely router-shaped code is ~550 lines: the `src/core`
matching engine (~340), the browser `Router` (~170), and two small server
modules (`RouteManager`/`Route`, ~176). Everything else — ~4,600 lines across
`server/types.ts` (1,438), `server/helpers.ts` (2,725), `server/constants.ts`
(526) — is a complete HTTP server framework: lifecycle, middleware onion, body
parsing with zip-bomb caps, sessions with pluggable stores, signed cookies,
CSRF, CORS, rate limiting, security headers, ETag/Range, static files,
compression, content negotiation, multipart uploads, SSE, WebSocket upgrade
fan-out. It even imported a database layer to persist sessions and reached into
MCP constants — a router that could not ship without its consumers.

Three structural failures, in the philosophy's own terms:

1. **It did not stay a module the server consumes — it became the server.**
   The `src/server` face _was_ the framework, so the router could never be
   isolated, independently versioned, or reused.
2. **It did not rigorously push into core before branching.** Only the matcher
   went down. The registry concept was built twice (the browser inlined a
   `Map` + matcher; the server built `RouteManager`), route grouping existed
   only server-side despite being pure string composition, and env-agnostic
   string logic (negotiation, ETag, cookie serialization) sat in the node face
   by association.
3. **The two faces did not present a similar surface.** Three different
   "match result" shapes, two incompatible path grammars (bare slugs in the
   browser, `/`-prefixed on the server), disjoint vocabularies
   (`go/active/start` vs `add/allow/routes/group`), and observability on one
   face only.

What _was_ right — and survives: the pure core engine (compile → match →
specificity, with the `answers` predicate as the single server/browser seam),
its excellent test suite, the literal-over-param order-independent precedence,
tolerant percent-decoding, trailing-slash folding, and the server's
404-vs-405 + auto-HEAD + `Allow`-set semantics.

## 2. Design philosophy

- **Core-first, proven by construction.** Anything that runs on web-standard
  primitives available in every environment lives in `src/core`. The faces hold
  only what is _physically_ environment-bound: `window`/`history`/DOM events in
  the browser, `node:http` message conversion on the server.
- **One mental model, three faces.** A single registry-and-match entity
  (`Router`) in core; both faces compose it and expose it readonly, so route
  definition, grouping, precedence, introspection, and the match vocabulary are
  literally the same object everywhere.
- **The router is a library, not a framework.** No listener, no middleware
  implementations, no body parsing, no sessions, no rendering. It returns data
  and (on the dispatch path) fetch-standard `Response`s; consumers own
  everything else.
- **Web-standards-first.** Fetch `Request`/`Response` as the dispatch
  vocabulary (WinterTC minimum common API — Node ≥ 24, Deno, Bun, workers,
  browsers), URLPattern-_style_ authored syntax, History API baseline in the
  browser. But dispatch is **never** delegated to `URLPattern` (no precedence,
  regex-per-component performance, ReDoS class) — core owns its matcher.
- **Sibling integration where honest.** `@orkestrel/emitter` for the two
  stateful entities' events (§13); `@orkestrel/contract` guards at the
  construction/registration boundary (§14) — hot paths stay guard-free;
  `@orkestrel/abort` (published) for the two places cancellation is genuinely
  routing's job (§6). `timeout`/`budget` are considered and excluded — no
  routing-shaped consumer.

### Non-goals (the do-not-build list)

HTTP server/listener ownership; middleware implementations (auth, sessions,
CORS, CSRF, rate limits, compression, static files); body parsing or
serialization; SSE/WebSocket transports; data loaders/caching; scroll
restoration; DOM rendering (no `render`/`outlet` — the old browser router's
render-into-outlet mode is deliberately cut; the browser face is headless);
file-based route codegen; framework bindings. The old framework code is
competent and security-aware in isolation — it is salvage for a **future
`@orkestrel/server` package**, which will consume this router through the seam
in §7. None of it ships here.

## 3. Architecture

```
src/core/      Router (registry + match), Dispatcher (fetch dispatch),
               pattern helpers, PathParams typing, factories
src/browser/   Navigator — History/hash navigation over a Router
src/server/    node:http adapter — Request/Response ⇄ IncomingMessage/ServerResponse
```

Why `Dispatcher` is core, not server: a fetch-standard dispatcher touches only
`Request`/`Response`/`URL` — typed in all three face configs (verified: core
inherits node types; browser has DOM lib; server has node types) and present at
runtime everywhere, including service workers. Method-dimensioned dispatch is
HTTP vocabulary, not Node vocabulary. Putting it in core is the philosophy's
"as much as possible in core" made concrete — and it makes the server face
honestly tiny: message-format conversion, nothing else.

Environment assumptions per face (config ground truth):

| Face    | May assume                                                                                                                    | Must not touch                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| core    | ESNext + runtime-universal web globals (`URL`, `URLSearchParams`, `Request`, `Response`, `AbortSignal`, `decodeURIComponent`) | DOM (`window`, `document`, `history`), `node:*` |
| browser | DOM + core                                                                                                                    | `node:*`                                        |
| server  | `node:*` + core                                                                                                               | DOM                                             |

## 4. Path grammar (one grammar, both faces)

- **Shape.** Patterns are `/`-prefixed: `/users/:id`, `/files/*rest`. The
  browser face normalizes `location`/hash input to a `/`-prefixed pathname
  before matching — the grammar divergence in the old code (bare slugs vs
  prefixed) is gone.
- **Segments.** Three kinds: **literal** (`/users`), **param** (`:name` — one
  segment, `([^/]+)`), **wildcard** (`*name` — final segment only, captures the
  REST of the path including slashes; named per path-to-regexp v8 convention).
  The old code's "reserved tier 0" becomes a real feature with a real consumer
  (static-asset and catch-all routes) instead of speculative surface.
- **Precedence.** Literal (2) > param (1) > wildcard (0), compared
  left-to-right at the earliest differing segment; registration-order
  independent; a shorter pattern that is a prefix of a longer one ranks below
  it; equal-specificity ties (only possible between distinct wildcard shapes)
  resolve to the earliest registered — stable and documented.
- **Trailing slash.** Insensitive, folded at both registration
  (`canonicalPath`) and match (one optional trailing `/` before the anchor);
  root `/` and the empty pattern are exempt. (Preserved old semantics, already
  test-pinned.)
- **Case.** Matching is case-sensitive by default with an explicit
  `sensitive: false` opt-out at Router construction — an explicit, documented
  decision rather than an accident of the regex.
- **Encoding.** Captured params are percent-decoded; a malformed `%` escape is
  tolerated as a literal (never throws) — the old `decodeParam` contract, kept.
- **Fixes over the old engine.** `escapeRegExp` folds into core `helpers.ts`
  (the old core reached up to an undocumented `src/helpers.ts`); the
  `pathSpecificity` bug where any segment _containing_ `:` ranked as a param
  (while `compilePath` only rewrote syntactically valid `:name` heads) is fixed
  — classification and compilation share one segment parser.

## 5. Public API

### 5.1 `src/core` — the shared machine

```ts
// types.ts (source of truth; all readonly per §11)

/** Extract `{ name: string }` param records from a path pattern at the type level. */
type PathParams<Path extends string> = /* template-literal inference:
	'/users/:id/posts/:slug' → { id: string; slug: string }
	'/files/*rest'           → { rest: string }
	parameterless             → {} (empty record) */

interface RouteEntry<Meta> {
	readonly path: string
	readonly meta: Meta
	readonly name?: string
}

interface RouterMatch<Meta> {
	readonly path: string                              // the winning PATTERN
	readonly params: Readonly<Record<string, string>>  // decoded captures
	readonly meta: Meta
	readonly name?: string
}

type RouterAnswers<Meta> = (meta: Meta) => boolean   // the one face seam

interface RouterOptions<Meta> {
	readonly entries?: readonly RouteEntry<Meta>[]
	readonly sensitive?: boolean                       // default true
	readonly key?: (entry: RouteEntry<Meta>) => string // dedup identity; omitted = keep all
}

interface RouterInterface<Meta> {
	readonly count: number
	add(entry: RouteEntry<Meta>): void
	add(entries: readonly RouteEntry<Meta>[]): void
	match(pathname: string, answers?: RouterAnswers<Meta>): RouterMatch<Meta> | undefined
	entries(): readonly RouteEntry<Meta>[]
	entries(pathname: string): readonly RouteEntry<Meta>[]  // the Allow/405 source
	group(prefix: string): GroupInterface<Meta>
	clear(): void
}

interface GroupInterface<Meta> {
	readonly prefix: string
	add(entry: RouteEntry<Meta>): void
	add(entries: readonly RouteEntry<Meta>[]): void
	group(prefix: string): GroupInterface<Meta>
}
```

`Router` merges the old `RouteMatcher` (registry, compile-once, most-specific
scan, `answers` seam, `entries`, `clear`) with the two capabilities both faces
rebuilt separately: **dedup** (the `key` option — the Dispatcher passes
`method + canonical path`, the Navigator passes `canonical path`; last write
wins per key, replace-in-place with no engine rebuild) and **groups** (the old
server-only `RouteGroup` prefix composition, promoted — pure string logic, now
available to both faces). `Router` is event-free and stateless-per-call: the
pure machine.

```ts
// Dispatcher — fetch-standard, method-dimensioned dispatch over a Router (core)

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

interface RouteContext<Path extends string = string, TState = undefined> {
	readonly params: PathParams<Path>
	readonly pattern: string
	readonly url: URL
	readonly state: TState // opaque consumer pass-through from handle()
}

type RouteHandler<Path extends string = string, TState = undefined> = (
	request: Request,
	context: RouteContext<Path, TState>,
) => Response | Promise<Response>

interface RouteInput<Path extends string = string, TState = undefined> {
	readonly method: Method
	readonly path: Path
	readonly handler: RouteHandler<Path, TState>
	readonly name?: string
}

type DispatchResult<TState> =
	| { readonly status: 'matched'; readonly match: RouterMatch<RouteRecord<TState>> }
	| { readonly status: 'unmethoded'; readonly allow: readonly Method[] }
	| { readonly status: 'unmatched' }

type DispatcherEventMap = {
	readonly match: readonly [method: Method, pattern: string]
	readonly miss: readonly [method: Method, pathname: string, kind: 'unmatched' | 'unmethoded']
}

interface DispatcherOptions<TState> {
	readonly routes?: readonly RouteInput<string, TState>[]
	readonly sensitive?: boolean
	readonly unmatched?: (request: Request) => Response | Promise<Response> // default: 404
	readonly unmethoded?: (request: Request, allow: readonly Method[]) => Response | Promise<Response> // default: 405 + Allow
	readonly on?: EmitterHooks<DispatcherEventMap>
	readonly error?: EmitterErrorHandler
}

interface DispatcherInterface<TState = undefined> {
	readonly router: RouterInterface<RouteRecord<TState>> // readonly introspection, same object
	readonly emitter: EmitterInterface<DispatcherEventMap>
	add<Path extends string>(input: RouteInput<Path, TState>): void
	add(inputs: readonly RouteInput<string, TState>[]): void
	group(prefix: string): DispatchGroupInterface<TState>
	match(method: Method, pathname: string): DispatchResult<TState>
	handle(request: Request, state: TState): Promise<Response>
	destroy(): void
}
```

Dispatch semantics (preserved from the old `RouteManager`, re-shaped to fetch):

- `HEAD` with no `HEAD` route runs the `GET` handler and strips the body
  (`new Response(null, …)` with the handler's status/headers).
- `OPTIONS` with no explicit route answers `204` with the derived `Allow` set.
- Path-matches-but-method-doesn't → the `unmethoded` responder (default `405`
  - `Allow`, derived from `router.entries(pathname)` — `GET` advertises `HEAD`).
- Nothing matches → the `unmatched` responder (default `404`).
- **A handler throw propagates to the caller.** The dispatcher never invents an
  error boundary — mapping throws to responses is the consuming server's
  policy. This is the module boundary the philosophy demands.
- `state` is a typed, opaque pass-through: the consuming server threads its
  per-request context (logger, session, DI bag) without the router knowing its
  shape.

```ts
// factories.ts
function createRouter<Meta>(options?: RouterOptions<Meta>): RouterInterface<Meta>
function createDispatcher<TState = undefined>(
	options?: DispatcherOptions<TState>,
): DispatcherInterface<TState>
```

Pattern helpers stay individually exported per §5 (`compilePath`, `matchPath`,
`canonicalPath`, `decodeParam`, `pathSpecificity`, `compareSpecificity`,
`escapeRegExp`, `joinPaths`) — consumers compose them directly, and the
entities never hold private copies.

### 5.2 `src/browser` — `Navigator`

```ts
type NavigatorEventMap<Meta> = {
	readonly navigate: readonly [match: RouterMatch<Meta>]
}

type NavigatorMode = 'hash' | 'history'

interface NavigatorOptions<Meta> {
	readonly routes: readonly RouteEntry<Meta>[]
	readonly mode?: NavigatorMode // default 'hash' (zero server config); 'history' uses pushState/popstate
	readonly base?: string // history-mode base path prefix
	readonly fallback?: string // pattern to resolve on a miss; default: first route's path
	readonly guard?: (
		to: RouterMatch<Meta>,
		from: RouterMatch<Meta> | undefined,
		signal: AbortSignal, // fires when a newer navigation supersedes this one
	) => boolean | Promise<boolean>
	readonly intercept?: boolean // opt-in same-origin <a> click interception (history mode)
	readonly sensitive?: boolean
	readonly on?: EmitterHooks<NavigatorEventMap<Meta>>
	readonly error?: EmitterErrorHandler
}

interface NavigatorInterface<Meta> {
	readonly router: RouterInterface<RouteEntry<Meta>> // same registry object, readonly
	readonly emitter: EmitterInterface<NavigatorEventMap<Meta>>
	readonly active: RouterMatch<Meta> | undefined
	start(): void // begin listening (hashchange / popstate + interception) and resolve now
	stop(): void
	go(path: string): void // navigate programmatically (sets hash / pushState → resolve)
	match(path: string): RouterMatch<Meta> | undefined // pure lookup, no side effects
	destroy(): void
}
```

Deliberate changes from the old browser router:

- **Headless.** `render`/`outlet` are gone. The Navigator resolves, tracks
  `active`, and emits `navigate`; the consumer (vanilla DOM, Vue, React, or the
  future server-driven UI) owns rendering. This is what makes the face
  reusable instead of a mini-framework.
- **History mode joins hash mode.** `mode: 'history'` uses
  `pushState`/`popstate` with an optional `base`; `intercept: true` adds
  same-origin link interception. The Navigation API is _not_ a build target in
  v1 (Safari's `precommitHandler` gap makes it unsafe as a sole substrate);
  the `mode` union leaves room for a `'navigation'` enhancement later without
  reshaping the surface.
- **A single guard hook, supersede-safe.** `guard(to, from, signal)` may veto
  (or asynchronously veto) a navigation — the real SPA need (auth walls)
  without a middleware system. A vetoed navigation leaves `active` unchanged
  and emits nothing. The Navigator mints an `@orkestrel/abort` handle per
  navigation and aborts it when a NEWER navigation starts (or on
  `stop`/`destroy`), so a slow async guard whose navigation was superseded has
  its verdict discarded and can cancel its own work off the `signal` — the
  classic stale-guard race, closed by construction.
- Hash/pathname normalization produces `/`-prefixed paths, unifying the grammar
  with the rest of the package (`hashPath('#/users/7?x') → '/users/7'`).

### 5.3 `src/server` — the node adapter (deliberately tiny)

```ts
// helpers.ts — pure conversion + glue; no lifecycle, no listener ownership
function requestFrom(message: IncomingMessage, options?: { readonly origin?: string }): Request
function sendResponse(response: Response, target: ServerResponse): Promise<void>
function createListener<TState>(
	dispatcher: DispatcherInterface<TState>,
	state: (message: IncomingMessage) => TState,
): (request: IncomingMessage, response: ServerResponse) => void
```

That is the whole face: convert `node:http` messages to fetch vocabulary, hand
them to the core `Dispatcher`, write the `Response` back (including streamed
bodies via the web-stream → node-stream bridge). `requestFrom` wires
cancellation: it mints an `@orkestrel/abort` handle, aborts it when the
underlying connection closes, and builds the `Request` over its `signal` — so
a handler's `request.signal` fires on client disconnect, the fetch-standard
idiom, with zero router-specific cancellation API. A consumer runs
`node:http.createServer(createListener(dispatcher, () => state))` today; the
future `@orkestrel/server` package composes the same seam with its own
lifecycle, middleware, and error boundary. On runtimes that speak fetch
natively (Bun, Deno, workers), consumers skip this face entirely and pass
`Request`s straight to `dispatcher.handle` — which is the proof the design is
environment-agnostic where it claims to be.

## 6. Sibling integration

- **`@orkestrel/emitter`** — `Navigator` and `Dispatcher` are §13 entities:
  each owns an `Emitter`, exposes `readonly emitter`, accepts `on` hooks and an
  `error` handler at construction, and `destroy()` tears the emitter down.
  Event maps are small and named (`navigate`; `match`/`miss`). The barrel
  **never re-exports emitter symbols** (§6) — consumers import
  `EmitterHooks`/`EmitterErrorHandler` from `@orkestrel/emitter`.
- **`@orkestrel/contract`** — construction/registration boundary guards, the
  line convention: `add()` validates each entry (`isString` path with a
  leading-`/` check, `isFunction` handler, method via a `literalOf`-derived
  guard) and **throws `TypeError`** on a malformed registration (budget
  precedent: required inputs fail loudly at the boundary). `match()`/`handle()`
  hot paths carry zero guards.
- **`@orkestrel/abort`** (now published) — two honest consumers, no
  speculation: the Navigator's per-navigation supersede signal (§5.2) and the
  server adapter's client-disconnect → `request.signal` wiring (§5.3). Both
  compose `createAbort`/`linkSignal`; the surfaced type is always the native
  `AbortSignal`, so consumers never import abort types to use the router.
  Landing the dep also brings its guide mirror: `guides/src/abort.md` joins
  `contract.md`/`emitter.md`/`guide.md` as a byte-identical dependency mirror,
  with a matching `guides/README.md` dependency-reference paragraph (U7).
- **`@orkestrel/timeout` / `@orkestrel/budget`** — considered and excluded:
  deadlines and spend ceilings on request handling are the consuming server's
  policy, not routing. No routing-shaped consumer exists, so the deps stay out.

## 7. The `@orkestrel/server` seam (future package, not this one)

The router's contract with its eventual primary consumer:

1. The server owns `node:http` (or any runtime) lifecycle and constructs one
   `Dispatcher<ServerState>`.
2. Route modules register through `dispatcher.add`/`group` — config-object
   inputs, so route tables are data and unit-testable without a socket.
3. Per request the server builds its `state`, calls
   `dispatcher.handle(request, state)`, and owns the error boundary around it.
4. Middleware, sessions, negotiation, static files, compression — everything in
   the old `src/server` — lives in that package, built over the same fetch
   vocabulary. The old code is its salvage donor, not this package's.

## 8. Testing strategy (enterprise bar)

- **Acceptance spec carried over.** The old core suite is the contract:
  order-independent literal-over-param at the earliest differing segment,
  trailing-slash + root exemption, tolerant percent-decode, `answers` seam
  driving method-dimensioned and method-less consumers, `entries(pathname)` as
  the Allow set, registration/`clear` reuse. All preserved as core `Router`
  cases, plus new: wildcard capture + precedence tier, dedup-by-key
  (last-write-wins, replace-in-place), group nesting, case-sensitivity toggle,
  the specificity/compile classification consistency fix (regression), and
  type-level `expectTypeOf` suites for `PathParams` inference.
- **Dispatcher (core, node env):** full method matrix — auto-HEAD body strip,
  auto-OPTIONS + Allow, 405 vs 404 responders (default + overridden), handler
  throw propagation (never swallowed), `state` pass-through typing, emitter
  `match`/`miss` events, guard-throw on malformed registration.
- **Navigator (browser project, real Chromium via Playwright):** hash and
  history modes, `go`/`active`/`navigate` events, fallback semantics
  (old suite's cases), guard veto (sync + async), link interception on/off,
  `start`/`stop`/`destroy` idempotence, no-op re-navigation re-resolve.
- **Server adapter (node env, real sockets):** `requestFrom` fidelity (method,
  URL from Host, headers, body streaming), `sendResponse` (status, headers,
  streamed and empty bodies), end-to-end `node:http` + `fetch` round-trip
  through a `Dispatcher` on an ephemeral port.
- **Mirror rule (§16):** every runtime src file has its mirrored test file per
  face project; `tests/setup.ts` (+ `setupBrowser.ts`) provide recorders per
  the house pattern.
- **Guides parity:** three manifest rows — `Router → src/router.md → src/core`,
  `Navigator → src/navigator.md → src/browser`,
  `Listener → src/listener.md → src/server` — with the standard drop-in parity
  suite (surface/methods bijection, examples, links, fence imports,
  `SELF_SPECIFIERS = ['@orkestrel/router', '@src/core', '@src/browser', '@src/server']`).

## 9. Implementation plan

Ordered units with disjoint ownership (the emitter/abort/budget/timeout
playbook):

| Unit | Owns                                                            | Content                                                                                                                                                              | Accept                                   |
| ---- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| U0   | `src/core/types.ts`, `constants.ts`, `package.json` (deps line) | Full type surface incl. `PathParams`, method set, tiers; add `@orkestrel/abort` to dependencies + regenerate lockfile                                                | `check:src:core` clean, `npm ci` green   |
| U1   | `src/core/helpers.ts`                                           | Pattern functions (port + `escapeRegExp` fold-in + wildcard + specificity fix + `joinPaths`)                                                                         | helpers unit tests green                 |
| U2   | `src/core/Router.ts`                                            | Registry + dedup-key + groups + match (composes U1)                                                                                                                  | old acceptance cases green               |
| U3   | `src/core/Dispatcher.ts`, `factories.ts`, `index.ts`            | Fetch dispatch + emitter + factories + barrel                                                                                                                        | dispatcher suite green                   |
| U4   | `src/browser/**`                                                | `Navigator` + hash/history helpers + factories + barrel                                                                                                              | browser project green (Chromium)         |
| U5   | `src/server/**`                                                 | `requestFrom`/`sendResponse`/`createListener`                                                                                                                        | server project green (socket round-trip) |
| U6   | `tests/**` expansion                                            | Type-level suites, adversarial inputs, cross-face grammar parity                                                                                                     | full `npm test` green                    |
| U7   | `guides/**`, parity test                                        | Three guides + manifest + parity adoption + `abort.md` dependency mirror (synced byte-identical from the abort repo) with its `guides/README.md` reference paragraph | `test:guides` green                      |
| U8   | —                                                               | Delete `old/`; verifier sweep; checker + opus reviewer; push                                                                                                         | all gates green, review PASS             |

U0→U1→U2→U3 serial (each consumes the last); U4 ∥ U5 after U3; U6 after U4+U5;
U7 ∥ U6; U8 last. Config note: the tri-face configs are already correct and
untouched; the one open config nuance is that AGENTS §17.5's table mentions a
CJS core while the actual build emits ES (`dist/src/core/index.js`) with the
server face building CJS — the implementation follows the _configs_ (they are
the user-corrected ground truth), and the guide documents that.

## 10. Open decisions (approval requested)

1. **Face entity names** — `Navigator` (browser) and `Dispatcher` (core
   dispatch). Alternatives: keeping `Router` as each face's local name (nice
   imports, awkward docs/parity with three same-named classes). Recommendation:
   as proposed.
2. **Navigator default mode** — proposed `'hash'` (zero server configuration,
   matches the old behavior). Flip to `'history'` if the primary consumer will
   control its server.
3. **Case sensitivity default** — proposed `sensitive: true` (preserves old
   behavior; explicit opt-out). Industry default leans insensitive; either is
   one line.
4. **Dispatcher events** — proposed minimal `match`/`miss`. Drop entirely for
   a silent dispatcher, or add nothing more; `error` stays a non-event (throws
   propagate).
5. **`old/` deletion** — happens in U8 per your instruction, alongside the
   final review.

## Appendix — old-code disposition

| Old module                                                                                                                                                                                                                                                                | Disposition                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `core/helpers.ts`, `RouteMatcher.ts`, `types.ts`, `factories.ts`                                                                                                                                                                                                          | **Salvage** — port into U1/U2 near-verbatim, with the two fixes (escapeRegExp fold-in, specificity classification) and wildcard support |
| `tests/src/core/RouteMatcher.test.ts`                                                                                                                                                                                                                                     | **Salvage** — becomes the U2 acceptance spec                                                                                            |
| `browser/Router.ts` shape (`start/stop/go/active/match/emitter`)                                                                                                                                                                                                          | **Salvage** — the `Navigator` surface template; render/outlet cut                                                                       |
| `server/RouteManager.ts` semantics (auto-HEAD, 405/`Allow`, dedup)                                                                                                                                                                                                        | **Salvage** — re-shaped into `Dispatcher` over fetch vocabulary                                                                         |
| `server/RouteGroup.ts`                                                                                                                                                                                                                                                    | **Salvage** — promoted to core `Router.group`                                                                                           |
| `server/Route.ts`, `RouteHandlerContext.ts`                                                                                                                                                                                                                               | **Kill** — replaced by fetch `Request`/`RouteContext`                                                                                   |
| `server/types.ts`/`helpers.ts`/`constants.ts`/`errors.ts`/`factories.ts` framework surface (sessions, tokens, cookies, CSRF, CORS, security headers, ETag, Range, static, compression, negotiation, multipart, SSE, upgrade, body parsing, `Server`, `MiddlewareManager`) | **Kill here; salvage donor for `@orkestrel/server`** — none of it is routing                                                            |
| Database/session store coupling, MCP references                                                                                                                                                                                                                           | **Kill** — dependency inversions                                                                                                        |
| Reserved wildcard tier 0 (speculative)                                                                                                                                                                                                                                    | **Replaced** — wildcard ships as a real feature                                                                                         |
