// ============================================================================
//  The core matching engine + fetch dispatcher — type definitions (the §5
//  source of truth). `Router` is a PURE, environment-agnostic registry-and-
//  match engine: it compiles route path patterns, extracts URL-decoded params,
//  ranks candidates by specificity, and exposes the `answers` predicate as the
//  single seam both the browser `Navigator` and the core `Dispatcher` compose
//  differently. `Dispatcher` layers fetch-standard, method-dimensioned dispatch
//  on top of one `Router<RouteRecord<TState>>`. Neither entity touches DOM or
//  `node:*` — only `URL` / `Request` / `Response` / `AbortSignal`, universal
//  web-standard globals available in every runtime this package targets.
//
//  Type groups, all `readonly` per AGENTS §11:
//
//    1. Path grammar typing — {@link PathParams}, the template-literal param
//       extraction that gives handlers a typed `context.params`.
//    2. The registry value types — {@link RouteEntry}, {@link RouterMatch},
//       {@link AnswerHandler}, {@link CompiledPath} — plain data, no behavior.
//    3. The registry entity surface — {@link RouterInterface} / {@link GroupInterface}
//       / {@link RouterOptions}, the shared `Router` both faces compose.
//    4. The dispatch surface — {@link Method}, {@link RouteContext},
//       {@link RouteHandler}, {@link RouteInput}, {@link RouteRecord},
//       {@link DispatchResult}, {@link DispatcherEventMap},
//       {@link DispatcherOptions}, {@link DispatcherInterface},
//       {@link DispatchGroupInterface} — the fetch-standard dispatch entity.
//
//  `EmitterHooks` / `EmitterErrorHandler` / `EmitterInterface` are imported as
//  types from `@orkestrel/emitter` and never re-exported (AGENTS §6) —
//  consumers import them directly from the emitter package.
// ============================================================================

import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'

/**
 * The identifier START characters an identifier-grammar param name may
 * begin with — mirrors the runtime classifier's `[A-Za-z_]` head class
 * (`classifySegment` / `compilePath`, `helpers.ts`).
 */
export type IdentifierStartChar =
	| 'a'
	| 'b'
	| 'c'
	| 'd'
	| 'e'
	| 'f'
	| 'g'
	| 'h'
	| 'i'
	| 'j'
	| 'k'
	| 'l'
	| 'm'
	| 'n'
	| 'o'
	| 'p'
	| 'q'
	| 'r'
	| 's'
	| 't'
	| 'u'
	| 'v'
	| 'w'
	| 'x'
	| 'y'
	| 'z'
	| 'A'
	| 'B'
	| 'C'
	| 'D'
	| 'E'
	| 'F'
	| 'G'
	| 'H'
	| 'I'
	| 'J'
	| 'K'
	| 'L'
	| 'M'
	| 'N'
	| 'O'
	| 'P'
	| 'Q'
	| 'R'
	| 'S'
	| 'T'
	| 'U'
	| 'V'
	| 'W'
	| 'X'
	| 'Y'
	| 'Z'
	| '_'

/**
 * The identifier CONTINUATION characters after the first — mirrors the
 * runtime classifier's `[A-Za-z0-9_]*` tail class.
 */
export type IdentifierChar =
	| IdentifierStartChar
	| '0'
	| '1'
	| '2'
	| '3'
	| '4'
	| '5'
	| '6'
	| '7'
	| '8'
	| '9'

// Consume the identifier-continuation run off the front of `S`, char by char, appending each
// onto `Acc` — stops (returns `Acc` unchanged) at the first non-identifier char or end of string.
export type TakeIdentifierTail<
	S extends string,
	Acc extends string,
> = S extends `${infer Head}${infer Tail}`
	? Head extends IdentifierChar
		? TakeIdentifierTail<Tail, `${Acc}${Head}`>
		: Acc
	: Acc

// The identifier HEAD captured at the FRONT of `S` (empty when `S` does not begin with an
// identifier-start char) — the type-level mirror of the runtime `/^[A-Za-z_]\w*/` head match.
export type IdentifierHead<S extends string> = S extends `${infer Head}${infer Tail}`
	? Head extends IdentifierStartChar
		? TakeIdentifierTail<Tail, Head>
		: ''
	: ''

// One path SEGMENT's param contribution — the type-level mirror of the runtime `classifySegment`
// + `compilePath` segment parser (`helpers.ts`): a `:` HEAD followed by an identifier captures
// that identifier (stopping at the first non-identifier char, e.g. `:name.json` captures only
// `name`); a segment whose `:` is NOT at the segment start (`a:b`) is LITERAL and captures
// nothing — the fix this type mirrors (§4). A `*name` segment (only valid as the grammar's FINAL
// segment, unchanged from before) captures the identifier the same way. A non-capturing segment
// resolves to `unknown` (the intersection IDENTITY) rather than `Record<string, never>` — an
// index-signature type intersected with a later `{ id: string }` would otherwise conflict
// (`string` not assignable to the index signature's `never`); `PathParams` normalizes the
// eventual `unknown` (parameterless) result down to a clean empty record.
export type SegmentParam<Segment extends string> = Segment extends `:${infer Rest}`
	? IdentifierHead<Rest> extends infer Name extends string
		? Name extends ''
			? unknown
			: { readonly [K in Name]: string }
		: unknown
	: Segment extends `*${infer Rest}`
		? IdentifierHead<Rest> extends infer Name extends string
			? Name extends ''
				? unknown
				: { readonly [K in Name]: string }
			: unknown
		: unknown

/**
 * Recursive, unflattened param extraction for {@link PathParams} — walks a
 * path pattern segment by segment (split on `/`), extracting each segment's
 * {@link SegmentParam} contribution and intersecting the rest.
 *
 * @typeParam Path - The path pattern literal being decomposed
 *
 * @remarks
 * Splits `Path` at its first `/` into `Segment` + `Rest`, intersects
 * `SegmentParam<Segment>` with the recursive walk of `Rest`, and — once no
 * further `/` remains — resolves the final segment's own `SegmentParam`
 * directly. `SegmentParam` mirrors the runtime `classifySegment` grammar
 * exactly: a `:name` HEAD (identifier-char run, stopping at the first
 * non-identifier char) captures a param; a segment whose `:` is not at the
 * segment START (`a:b`) contributes nothing (the classification fix, §4); a
 * final `*name` wildcard captures the rest-of-path param the same way. A
 * fully parameterless `Path` resolves to `unknown` here (the intersection
 * identity every non-capturing segment contributes) — {@link PathParams}
 * flattens that down to a clean empty record. This type is exported so
 * {@link PathParams} (which flattens it into a clean mapped type for IDE
 * hovers) has a documented, testable recursive step; consumers reach for the
 * flattened {@link PathParams} form, never this raw recursion.
 */
export type PathParamsRaw<Path extends string> = string extends Path
	? Readonly<Record<string, string>>
	: Path extends `${infer Segment}/${infer Rest}`
		? SegmentParam<Segment> & PathParamsRaw<Rest>
		: SegmentParam<Path>

/**
 * Extracts `{ name: string }` param records from a path pattern at the type
 * level — the typed half of the path grammar (§4).
 *
 * @typeParam Path - A route path pattern literal (`/users/:id/posts/:slug`,
 *   `/files/*rest`, or a parameterless literal path)
 *
 * @remarks
 * A `:name` segment contributes `{ name: string }`; a trailing `*name`
 * wildcard (the grammar's only allowed wildcard position) contributes
 * `{ name: string }` capturing the rest of the path; a parameterless pattern
 * resolves to an empty record. Built over {@link PathParamsRaw} and flattened
 * through an identity-mapped type so editor hovers show the resolved shape
 * (`{ id: string; slug: string }`) rather than an unresolved intersection.
 *
 * @example
 * ```ts
 * type A = PathParams<'/users/:id/posts/:slug'> // { readonly id: string; readonly slug: string }
 * type B = PathParams<'/files/*rest'>            // { readonly rest: string }
 * type C = PathParams<'/health'>                 // Record<string, never>
 * ```
 */
export type PathParams<Path extends string> = {
	readonly [K in keyof PathParamsRaw<Path>]: PathParamsRaw<Path>[K]
}

/**
 * A compiled route path — the anchored regex plus its ordered param names.
 *
 * @remarks
 * The once-per-path compile output of `compilePath` (U1 `helpers.ts`):
 * `regex` is anchored (`^…$`) and matches the WHOLE pathname (with an
 * optional trailing slash, §4), and `params` lists each captured segment's
 * name (`:name` or the final `*name`) in order, so a `regex.exec` result's
 * capture groups line up with `params` positionally (the walk `matchPath`
 * performs). Plain data — no behavior.
 */
export interface CompiledPath {
	readonly regex: RegExp
	readonly params: readonly string[]
}

/**
 * One registered route in a {@link RouterInterface} — the `path` pattern plus
 * the opaque `meta` payload to return on a match, with an optional `name`.
 *
 * @typeParam Meta - The payload to carry on a match (opaque to the engine —
 *   a route handler + method on the `Dispatcher`, a component/loader
 *   reference on the `Navigator`)
 *
 * @remarks
 * - `path` — the `/`-prefixed route path pattern (`/users/:id`); compiled
 *   once at registration.
 * - `meta` — the opaque payload returned (as {@link RouterMatch.meta}) when
 *   this entry is the most-specific match. The engine never inspects it —
 *   the consumer's {@link AnswerHandler} predicate (the override seam)
 *   decides eligibility from it.
 * - `name` — an optional route identifier, carried through onto a match for
 *   consumers that build named links or debug output.
 */
export interface RouteEntry<Meta> {
	readonly path: string
	readonly meta: Meta
	readonly name?: string
}

/**
 * One matched route — the winning entry's PATTERN, decoded params, `meta`
 * payload, and optional `name`.
 *
 * @typeParam Meta - The payload the winning entry carries
 *
 * @remarks
 * What {@link RouterInterface.match} returns on a hit (`undefined` on a
 * miss). `path` is the winning entry's REGISTERED PATTERN (not the concrete
 * pathname that was matched) — useful for consumers that need to know which
 * route fired. `params` is a frozen `name → value` record (empty for a
 * parameterless path), each value URL-decoded with a malformed `%` escape
 * tolerated as a literal (§4, never throws). Plain data — no behavior.
 */
export interface RouterMatch<Meta> {
	readonly path: string
	readonly params: Readonly<Record<string, string>>
	readonly meta: Meta
	readonly name?: string
}

/**
 * The native-override seam — a predicate deciding whether an entry's `meta`
 * ANSWERS a given `match` call, beyond path matching.
 *
 * @typeParam Meta - The entry payload the predicate reads
 *
 * @remarks
 * The single seam the philosophy's "one engine, native overrides" principle
 * hangs on: the `Dispatcher` passes a method-check (`(record) => record.method
 * === requestMethod`), the `Navigator` omits the predicate entirely (every
 * path match always answers). Passed per-call to {@link RouterInterface.match};
 * when omitted, every entry whose path matches is eligible. Total — it never
 * throws (a consumer keeps it pure, per AGENTS §14 guard totality).
 */
export type AnswerHandler<Meta> = (meta: Meta) => boolean

/**
 * Options for `createRouter` — an optional initial entry set, the case-
 * sensitivity toggle, and the dedup identity function.
 *
 * @typeParam Meta - The entry payload type
 *
 * @remarks
 * - `entries` — the initial `{ path, meta, name? }` entries to register (each
 *   path compiled once), equivalent to a bare `createRouter()` followed by
 *   `add(entries)`. Omitted ⇒ an empty router.
 * - `sensitive` — case-sensitive path matching (default `true`, §4). Set
 *   `false` to fold case during matching (`/Users` matches `/users`);
 *   registered patterns are never case-folded in storage, only in matching.
 * - `key` — an optional dedup identity function computed per entry
 *   (`RouteEntry<Meta> → string`). When provided, registering an entry whose
 *   key already exists REPLACES the prior entry in place (last write wins,
 *   no engine rebuild) instead of adding a second candidate. Omitted ⇒ every
 *   registered entry is kept, even duplicate paths.
 */
export interface RouterOptions<Meta> {
	readonly entries?: readonly RouteEntry<Meta>[]
	readonly sensitive?: boolean
	readonly key?: (entry: RouteEntry<Meta>) => string
}

/**
 * The path-matching + registry engine contract (the §4.5 behavioral-interface
 * role for the one-class-per-file `Router`). Registers `{ path, meta, name? }`
 * entries (compiling each path once) and resolves a concrete pathname to the
 * MOST SPECIFIC matching entry — a literal segment beats a param beats a
 * wildcard at the earliest differing segment, registration-order-independent
 * (§4). The shared engine both the `Navigator` (browser) and the `Dispatcher`
 * (core, method-dimensioned) compose.
 *
 * @typeParam Meta - The opaque payload each entry carries and a match returns
 *
 * @remarks
 * - `count` — the number of registered entries.
 * - `add(entry)` / `add(entries)` — register ONE / MANY entries (§9.2 batch);
 *   each path is compiled once here. When constructed with a `key` option,
 *   an entry whose key already exists replaces the prior one in place;
 *   otherwise every entry is kept, even duplicate paths.
 * - `match(pathname, answers?)` — the MOST-SPECIFIC matching entry as a
 *   {@link RouterMatch} (its winning `path`, decoded `params`, `meta`, and
 *   `name`), or `undefined`. The optional {@link AnswerHandler} predicate
 *   filters candidates by `meta` first; omitted ⇒ every path match is
 *   eligible.
 * - `entries()` — ALL registered entries in registration order.
 * - `entries(pathname)` — only entries whose path matches `pathname` (the
 *   §9 plural accessor's filtered form; backs a consumer's allow/405 set).
 * - `group(prefix)` — a {@link GroupInterface} scoped under `prefix`; entries
 *   added through the group are registered on this same router with `prefix`
 *   prepended to each path.
 * - `clear()` — drop every entry (§10), leaving the router reusable.
 */
export interface RouterInterface<Meta> {
	readonly count: number
	add(entry: RouteEntry<Meta>): void
	add(entries: readonly RouteEntry<Meta>[]): void
	match(pathname: string, answers?: AnswerHandler<Meta>): RouterMatch<Meta> | undefined
	entries(): readonly RouteEntry<Meta>[]
	entries(pathname: string): readonly RouteEntry<Meta>[]
	group(prefix: string): GroupInterface<Meta>
	clear(): void
}

/**
 * A prefix-scoped registration handle over a {@link RouterInterface} — pure
 * string composition (§4.2.2), no independent state or storage.
 *
 * @typeParam Meta - The entry payload type, matching the owning router
 *
 * @remarks
 * - `prefix` — the path prefix this group prepends to every entry it
 *   registers (and to every nested group's own prefix).
 * - `add(entry)` / `add(entries)` — register ONE / MANY entries on the
 *   OWNING router, each entry's `path` composed as `prefix + entry.path`
 *   (§9.2 batch, mirroring {@link RouterInterface.add}).
 * - `group(prefix)` — a nested group whose prefix is `this.prefix + prefix`;
 *   nesting composes prefixes left to right with no depth limit.
 */
export interface GroupInterface<Meta> {
	readonly prefix: string
	add(entry: RouteEntry<Meta>): void
	add(entries: readonly RouteEntry<Meta>[]): void
	group(prefix: string): GroupInterface<Meta>
}

/**
 * The seven HTTP methods a {@link DispatcherInterface} dimensions dispatch
 * over — the value-level counterpart is {@link import('./constants.js').METHODS}.
 *
 * @remarks
 * `HEAD` is a valid explicit registration even though a `GET` route already
 * auto-answers `HEAD` (§5.1 dispatch semantics) — an explicit `HEAD` handler
 * always takes precedence over the derived one.
 */
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/**
 * The ambient context a {@link RouteHandler} receives alongside the raw
 * `Request` — decoded params, the winning pattern, the parsed URL, and the
 * consumer's opaque per-request state.
 *
 * @typeParam Path - The route path pattern the handler was registered under
 *   (drives the typed shape of `params` via {@link PathParams})
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * - `params` — the decoded param record, typed from `Path` via
 *   {@link PathParams} (empty for a parameterless path).
 * - `pattern` — the winning REGISTERED pattern (matches
 *   {@link RouterMatch.path}), useful for logging/metrics.
 * - `url` — the request URL, already parsed once by the dispatcher.
 * - `state` — the consumer's per-request payload (logger, session, DI bag),
 *   threaded opaquely through `handle()` — the router never inspects it.
 */
export interface RouteContext<Path extends string = string, TState = undefined> {
	readonly params: PathParams<Path>
	readonly pattern: string
	readonly url: URL
	readonly state: TState
}

/**
 * A route handler — receives the raw fetch `Request` plus its typed
 * {@link RouteContext} and returns (or resolves) a fetch `Response`.
 *
 * @typeParam Path - The route path pattern the handler is registered under
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * A handler throw propagates to the caller of `dispatcher.handle` — the
 * dispatcher never invents an error boundary; mapping throws to responses is
 * the consuming server's policy (§5.1).
 */
export type RouteHandler<Path extends string = string, TState = undefined> = (
	request: Request,
	context: RouteContext<Path, TState>,
) => Response | Promise<Response>

/**
 * One route registration input for {@link DispatcherInterface.add} — the
 * method-dimensioned counterpart of {@link RouteEntry}.
 *
 * @typeParam Path - The route path pattern literal (drives the typed
 *   `handler`'s `context.params` via {@link PathParams})
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * - `method` — the HTTP method this route answers.
 * - `path` — the `/`-prefixed route path pattern.
 * - `handler` — the {@link RouteHandler} invoked on a match.
 * - `name` — an optional route identifier, carried through onto a
 *   {@link RouterMatch}.
 */
export interface RouteInput<Path extends string = string, TState = undefined> {
	readonly method: Method
	readonly path: Path
	readonly handler: RouteHandler<Path, TState>
	readonly name?: string
}

/**
 * The `meta` payload a {@link DispatcherInterface} stores in its underlying
 * `Router` — what {@link RouterInterface.match} returns as
 * {@link RouterMatch.meta} on a dispatch hit.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * The handler is typed over `string` (not the original literal `Path`) at
 * storage — path-specific param typing is recovered at the call site through
 * {@link RouteInput}'s generic `Path`, not preserved in the stored record.
 */
export interface RouteRecord<TState> {
	readonly method: Method
	readonly handler: RouteHandler<string, TState>
	readonly name?: string
}

/**
 * The outcome of {@link DispatcherInterface.match} — a discriminated union
 * over the three dispatch tiers: a full hit, a path-matches-but-method-
 * doesn't (405 territory), or nothing matched at all (404 territory).
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * - `'matched'` — carries the winning {@link RouterMatch} (its `meta` is a
 *   {@link RouteRecord}).
 * - `'unmethoded'` — the pathname matched at least one entry but none for
 *   the requested method; `allow` is the derived `Allow` method set (from
 *   `router.entries(pathname)`).
 * - `'unmatched'` — no registered pattern matches the pathname at all.
 */
export type DispatchResult<TState> =
	| { readonly status: 'matched'; readonly match: RouterMatch<RouteRecord<TState>> }
	| { readonly status: 'unmethoded'; readonly allow: readonly Method[] }
	| { readonly status: 'unmatched' }

/**
 * The `Dispatcher`'s event map (AGENTS §13) — the two dispatch-outcome
 * signals a consumer can observe alongside the return value of `handle`.
 *
 * @remarks
 * - `match` — emitted on every dispatch that resolves to a handler
 *   (including the auto-`HEAD`/auto-`OPTIONS` derived cases): the request
 *   `method` and the winning `pattern`.
 * - `miss` — emitted on every non-matching dispatch: the RAW request
 *   `method` (a plain `string`, not narrowed to {@link Method} — an unknown
 *   verb like `PURGE` is observable here exactly as sent, never coerced),
 *   the raw `pathname`, and which tier missed (`'unmatched'` — nothing
 *   matched the path at all; `'unmethoded'` — the path matched but not the
 *   method, including an unknown verb against a path with other registered
 *   methods).
 */
export type DispatcherEventMap = {
	readonly match: readonly [method: Method, pattern: string]
	readonly miss: readonly [method: string, pathname: string, reason: 'unmatched' | 'unmethoded']
}

/**
 * Options for `createDispatcher` — initial routes, case sensitivity, the two
 * default-responder overrides, and the AGENTS §13 emitter wiring.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * - `routes` — the initial route inputs to register, equivalent to a bare
 *   `createDispatcher()` followed by `add(routes)`. Omitted ⇒ no routes.
 * - `sensitive` — forwarded to the underlying `Router` (default `true`, §4).
 * - `unmatched` — the responder invoked when nothing matches the pathname at
 *   all (default: a `404` `Response`).
 * - `unmethoded` — the responder invoked when the pathname matches but not
 *   the method, given the derived `Allow` set (default: a `405` `Response`
 *   with an `Allow` header).
 * - `on` — initial `DispatcherEventMap` listeners (AGENTS §8/§13).
 * - `error` — the emitter's own listener-error handler (AGENTS §13),
 *   forwarded alongside `on`.
 */
export interface DispatcherOptions<TState> {
	readonly routes?: readonly RouteInput<string, TState>[]
	readonly sensitive?: boolean
	readonly unmatched?: (request: Request) => Response | Promise<Response>
	readonly unmethoded?: (request: Request, allow: readonly Method[]) => Response | Promise<Response>
	readonly on?: EmitterHooks<DispatcherEventMap>
	readonly error?: EmitterErrorHandler
}

/**
 * The fetch-standard, method-dimensioned dispatch entity contract (the §4.5
 * behavioral-interface role for the one-class-per-file `Dispatcher`). Layers
 * HTTP method dispatch and web-standard `Request`/`Response` handling over a
 * single internal `Router<RouteRecord<TState>>`.
 *
 * @typeParam TState - The consumer's opaque per-request state type, threaded
 *   into every {@link RouteContext} (default `undefined` for stateless use)
 *
 * @remarks
 * - `router` — the underlying registry, exposed READONLY for introspection
 *   (the same object `add`/`group`/`match` operate on).
 * - `emitter` — the AGENTS §13 observable surface for {@link DispatcherEventMap}.
 * - `add(input)` / `add(inputs)` — register ONE / MANY {@link RouteInput}s
 *   (§9.2 batch); throws `TypeError` on a malformed registration (a
 *   non-`/`-prefixed path, a non-function handler, or a method outside
 *   {@link import('./constants.js').METHODS}) — the construction/registration
 *   boundary guard (§14); `match`/`handle` hot paths carry zero guards.
 * - `group(prefix)` — a {@link DispatchGroupInterface} scoped under `prefix`.
 * - `match(method, pathname)` — the raw {@link DispatchResult} for a method +
 *   pathname pair, with no `Request`/`Response` involvement — the pure
 *   decision `handle` builds its response from.
 * - `handle(request, state)` — the full dispatch: parses `request.url`,
 *   calls `match`, and either invokes the winning handler (auto-stripping
 *   the body for a derived `HEAD`, auto-answering a derived `OPTIONS` with
 *   the `Allow` set), or invokes the `unmatched`/`unmethoded` responder.
 *   Emits `match`/`miss` accordingly. A handler throw propagates uncaught.
 * - `destroy()` — tears down the `#emitter` (AGENTS §13); the underlying
 *   router is left registered (not cleared) so introspection remains valid
 *   after destroy.
 */
export interface DispatcherInterface<TState = undefined> {
	readonly router: RouterInterface<RouteRecord<TState>>
	readonly emitter: EmitterInterface<DispatcherEventMap>
	add<Path extends string>(input: RouteInput<Path, TState>): void
	add(inputs: readonly RouteInput<string, TState>[]): void
	group(prefix: string): DispatchGroupInterface<TState>
	match(method: Method, pathname: string): DispatchResult<TState>
	handle(request: Request, state: TState): Promise<Response>
	destroy(): void
}

/**
 * A prefix-scoped registration handle over a {@link DispatcherInterface} —
 * the method-dimensioned counterpart of {@link GroupInterface}.
 *
 * @typeParam TState - The consumer's opaque per-request state type, matching
 *   the owning dispatcher
 *
 * @remarks
 * - `prefix` — the path prefix this group prepends to every route it
 *   registers (and to every nested group's own prefix).
 * - `add(input)` / `add(inputs)` — register ONE / MANY {@link RouteInput}s on
 *   the OWNING dispatcher, each input's `path` composed as
 *   `prefix + input.path` (§9.2 batch, mirroring
 *   {@link DispatcherInterface.add}).
 * - `group(prefix)` — a nested group whose prefix is `this.prefix + prefix`.
 */
export interface DispatchGroupInterface<TState> {
	readonly prefix: string
	add<Path extends string>(input: RouteInput<Path, TState>): void
	add(inputs: readonly RouteInput<string, TState>[]): void
	group(prefix: string): DispatchGroupInterface<TState>
}
