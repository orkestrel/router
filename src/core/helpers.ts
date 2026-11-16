import type { CompiledPath, Method, RouteEntry, RouteInput, SegmentRank } from './types.js'
import { ContractError, escapeRegExp, isArray, preview } from '@orkestrel/contract'
import {
	PATH_ENCODE_PATTERN,
	PATH_ESCAPE_PATTERN,
	PATH_REFUSED_SET,
	PATH_WIDE_PATTERN,
	PERCENT_ESCAPES,
	PROTOTYPE_KEYS,
	TIER_LITERAL,
	TIER_PARAM,
	TIER_WILDCARD,
} from './constants.js'

// The PURE path-matching primitives (self-describing helper naming — module scope,
// no entity context). Every one is exported (the centralized-file rule): a
// consumer composes them directly, or reaches them through the `Router` engine.
// They use ECMAScript built-ins and `@orkestrel/contract` only, with no DOM, no `node:*`,
// no host `URL` parser, and no `TextEncoder`, so the same engine drives a
// method-dimensioned server dispatcher and a method-less browser navigator.

/**
 * Canonicalizes a route path for registry identity — encodes it with `encodePath` and
 * strips a single trailing slash, except the root `/` (and the empty pattern). The
 * trailing-slash fold {@link compilePath} normalizes a pattern through, so identity
 * agrees with the matcher.
 *
 * @remarks
 * Mirrors {@link compilePath}'s canonical pattern: `/users/` canonicalizes to `/users`,
 * and `/café` and `/caf%C3%A9` both canonicalize to `/caf%C3%A9` (each pair compiles to
 * the same regex and matches the same path text), while the root `/` and the empty `''`
 * are EXEMPT from the slash fold (a bare `/` already matches `/`; stripping it would
 * break that). Pure and total — a path the encoder leaves alone and that ends in no
 * trailing slash returns unchanged.
 *
 * @param path - The route path pattern
 * @returns The canonical path (encoded, one trailing slash removed, except `/` and `''`)
 *
 * @example
 * ```ts
 * canonicalizePath('/users/') // '/users'
 * canonicalizePath('/café') // '/caf%C3%A9'
 * canonicalizePath('/') // '/'
 * canonicalizePath('') // ''
 * ```
 */
export function canonicalizePath(path: string): string {
	const encoded = encodePath(path)
	return encoded.length > 1 && encoded.endsWith('/') ? encoded.slice(0, -1) : encoded
}

/**
 * Computes the canonical `METHOD /path` registry key for a method-dimensioned
 * dispatcher route.
 *
 * @remarks
 * Combines the route record's HTTP method with the outer entry's canonical
 * path, so registrations that differ only by one trailing slash replace each
 * other while registrations for different methods remain distinct.
 *
 * @param entry - The dispatcher route entry to identify
 * @returns The canonical `METHOD /path` registry key
 *
 * @example
 * ```ts
 * computeDispatchKey({ path: '/health/', meta: { method: 'GET' } }) // 'GET /health'
 * ```
 */
export function computeDispatchKey(entry: RouteEntry<{ readonly method: Method }>): string {
	return `${entry.meta.method} ${canonicalizePath(entry.path)}`
}

/**
 * Compiles a route path pattern into an anchored regex, its ordered param names,
 * and its specificity vector.
 *
 * @remarks
 * Splits the CANONICALIZED path into segments. Each `:name` segment becomes a
 * `([^/]+)` capture group; the FINAL segment may instead be `*name`, which
 * becomes a `(.+)` capture spanning the REST of the path including slashes.
 * The pattern is encoded with {@link encodePath} first, and literal text — a whole
 * literal segment or the suffix after a param name — is then regex-escaped
 * ({@link import('@orkestrel/contract').escapeRegExp}), so `/files/:name.json`
 * matches the `.` literally apart from the param. The regex is anchored (`^…$`)
 * and reads canonical text: {@link matchPath} and the `Router` encode the request
 * text with the same function, so `/café` matches `/café` and `/caf%C3%A9`. Request
 * text is encoded and never decoded, so `/us%65rs` does not match `/users`.
 *
 * Registration refuses five shapes with a `ContractError`: a pattern holding `\`,
 * tab, line feed, or carriage return anywhere (`pattern`, with a `limit` naming each
 * as `U+XXXX`, its index, and the escape to write instead), a wildcard segment
 * anywhere but last (`placement`), a final `*name` followed by more text
 * (`pattern`), a param or wildcard named for an `Object.prototype` property
 * ({@link import('./constants.js').PROTOTYPE_KEYS}, `literal`), and a name used
 * twice (`structure`).
 *
 * **Trailing slash is INSENSITIVE** (Express's `strict: false` default): a
 * single trailing slash on the request path is OPTIONAL, so `/users` matches
 * both `/users` and `/users/`, and `/users/:id` matches both `/users/me` and
 * `/users/me/`. This is NOT prefix matching — a deeper path is still a
 * distinct segment, so `/api` does not match `/api/users`. The ROOT `/` (and
 * the empty pattern `''`) are EXEMPT — they are not stripped, so `/` stays
 * `^/$` and `''` stays `^$`.
 *
 * `sensitive` (default `true`) controls case folding: `false` adds the `i`
 * regex flag over canonical text, which is ASCII, so it folds the letters A to Z
 * with a to z, in literal text and in escape hex, and no other letter: `/Users`
 * matches `/users`, while `/CAFÉ` misses `/café`. The pattern's own casing is
 * never altered — only the matching behavior.
 *
 * @param path - The route path pattern (for example `/users/:id`, `/files/*rest`)
 * @param sensitive - If `true`, matching is case-sensitive; if `false`, ASCII
 *   letters fold during matching. Default: `true`
 * @returns The {@link CompiledPath} — its `regex`, ordered `params`, and `specificity`
 * @throws {@link import('@orkestrel/contract').ContractError} Thrown when the
 *   pattern holds `\`, tab, line feed, or carriage return, when a `*name`
 *   wildcard segment is not the FINAL segment or carries a suffix, or when a
 *   param name is a prototype key or repeats
 *
 * @example
 * ```ts
 * const { regex, params } = compilePath('/users/:id/posts/:slug')
 * params // ['id', 'slug']
 * regex.exec('/users/7/posts/hello') // ['…', '7', 'hello']
 * regex.test('/users/7/posts/hello/') // true — the trailing slash is optional
 *
 * compilePath('/files/*rest').regex.test('/files/a/b.png') // true
 * compilePath('/Users', false).regex.test('/users') // true — case-insensitive
 * compilePath('/café').regex.test('/caf%C3%A9') // true — literals match encoded
 * ```
 */
export function compilePath(path: string, sensitive = true): CompiledPath {
	const refused = [...path].flatMap((char, index) => {
		const hex = char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
		return PATH_REFUSED_SET.has(char) ? [`U+00${hex} at ${index} (write %${hex})`] : []
	})
	if (refused.length > 0)
		throw new ContractError(
			'a route path must hold no backslash, tab, line feed, or carriage return',
			{
				code: 'pattern',
				context: {
					path: ['path'],
					limit: `no ${refused.join(', ')}`,
					received: preview(path),
				},
			},
		)
	// Encode, then fold ONE trailing slash off the pattern so `/users/` compiles like `/users`
	// — except the root `/` (and the empty pattern), which must keep matching `/` / `''`.
	const normalized = canonicalizePath(path)
	const segments = normalized.split('/')
	const compiledSegments = segments.map((segment, index) => {
		const isFinal = index === segments.length - 1
		const wildcard = /^\*[A-Za-z_]\w*/.exec(segment)?.[0]
		if (wildcard !== undefined && !isFinal)
			throw new ContractError('a wildcard segment must be the final segment of a path pattern', {
				code: 'placement',
				context: {
					path: ['path'],
					limit: `a wildcard only in the final segment, not "${segment}"`,
					received: preview(path),
				},
			})
		if (wildcard !== undefined && wildcard !== segment)
			throw new ContractError('a wildcard segment must carry no text after its name', {
				code: 'pattern',
				context: {
					path: ['path'],
					limit: `a bare "${wildcard}" wildcard, not "${segment}"`,
					received: preview(path),
				},
			})
		const tier = classifySegment(segment, isFinal)
		if (tier === TIER_WILDCARD) return { pattern: '(.+)', param: segment.slice(1) }
		if (tier === TIER_PARAM) {
			const name = /^:([A-Za-z_]\w*)/.exec(segment)?.[1] ?? ''
			const literal = segment.slice(1 + name.length)
			return { pattern: `([^/]+)${escapeRegExp(literal)}`, param: name }
		}
		return { pattern: escapeRegExp(segment) }
	})
	const pattern = compiledSegments.map((segment) => segment.pattern).join('/')
	const params = compiledSegments.flatMap((segment) =>
		segment.param === undefined ? [] : [segment.param],
	)
	const reserved = params.find((name) => PROTOTYPE_KEYS.has(name))
	if (reserved !== undefined)
		throw new ContractError('a param name must not name an Object.prototype property', {
			code: 'literal',
			context: {
				path: ['path'],
				limit: `a param name outside Object.prototype, not "${reserved}"`,
				received: preview(path),
			},
		})
	const repeated = params.find((name, index) => params.indexOf(name) !== index)
	if (repeated !== undefined)
		throw new ContractError('a param name must appear once in a path pattern', {
			code: 'structure',
			context: {
				path: ['path'],
				limit: `one param named "${repeated}"`,
				received: preview(path),
			},
		})
	// Allow ONE optional trailing slash before the `$` anchor (Express `strict: false`),
	// EXCEPT for the root `/` and the empty pattern — those anchor exactly so they keep
	// matching only `/` / `''` (a bare `/?` there would let `''` match `/` and vice versa).
	const suffix = normalized === '/' || normalized === '' ? '' : '/?'
	const flags = sensitive ? '' : 'i'
	return {
		regex: new RegExp(`^${pattern}${suffix}$`, flags),
		params,
		specificity: computeSpecificity(normalized),
	}
}

/**
 * Encodes path text, raw or already encoded, into the canonical form the router compares:
 * each member of its path encode set becomes its UTF-8 percent-escapes.
 *
 * @remarks
 * Reads its own table, {@link import('./constants.js').PATH_ENCODE_SET}, and never the host's
 * `URL` parser, so every host gives one text. A C0 control, U+0020, `"`, `#`, `<`, `>`, `?`,
 * `^`, `` ` ``, `{`, `|`, `}`, U+007F, and every greater code point become uppercase-hex
 * UTF-8 escapes (`|` is the table's one departure from the URL Standard's path set), and a
 * lone surrogate encodes as U+FFFD (`%EF%BF%BD`). Every other code point stays as written:
 * `/`, `\`, `[`, `]`, an existing escape such as `%65` (hex case included), and a `%` that
 * opens no escape, which never becomes `%25`. Nothing is decoded, so `%65` stays apart from
 * `e`. Total and idempotent, with a cost linear in the length of the text: an ASCII member costs
 * one scan step and one lookup in {@link import('./constants.js').PERCENT_ESCAPES}, and a run of
 * non-ASCII code points costs one `encodeURIComponent` call over its well-formed text.
 *
 * @param text - Path text, a segment or a whole path
 * @returns The canonical text
 *
 * @example
 * ```ts
 * encodePath('/café/a b') // '/caf%C3%A9/a%20b'
 * encodePath('/^w') // '/%5Ew'
 * encodePath('/caf%C3%A9') // '/caf%C3%A9' — already canonical
 * encodePath('/100%') // '/100%'
 * ```
 */
export function encodePath(text: string): string {
	if (!PATH_ENCODE_PATTERN.test(text)) return text
	// One global pass per class: an ASCII member is one table lookup, and a non-ASCII run is
	// one `encodeURIComponent` call over its well-formed text (a lone surrogate becomes U+FFFD).
	return text
		.replace(PATH_ESCAPE_PATTERN, (char) => PERCENT_ESCAPES[char.charCodeAt(0)] ?? '')
		.replace(PATH_WIDE_PATTERN, (run) => encodeURIComponent(run.toWellFormed()))
}

/**
 * Returns the input list as it is, or a one-entry list holding a single input — the
 * shape every batch-capable `add` reads.
 *
 * @param input - One input or a list of inputs
 * @returns The inputs as a list
 *
 * @example
 * ```ts
 * collectInputs('a') // ['a']
 * collectInputs(['a', 'b']) // ['a', 'b']
 * ```
 */
export function collectInputs<T>(input: T | readonly T[]): readonly T[] {
	return isArray<T>(input) ? input : [input]
}

/**
 * Decodes one captured param value from a URL, tolerating a malformed percent-escape —
 * the decode {@link matchPath} applies to each captured group.
 *
 * @remarks
 * A bad `%` sequence is not a reason to reject an otherwise-matching route, so
 * a `decodeURIComponent` that would throw falls back to the raw value
 * (mirroring the cookie / token boundary readers). Total — never
 * throws.
 *
 * @param value - The raw captured param value
 * @returns The URL-decoded value, or the raw value when decoding would throw
 *
 * @example
 * ```ts
 * decodeParam('a%2Fb') // 'a/b'
 * decodeParam('100%25') // '100%'
 * decodeParam('%') // '%' — malformed escape stays literal
 * ```
 */
export function decodeParam(value: string): string {
	try {
		return decodeURIComponent(value)
	} catch {
		// A malformed `%` escape stays literal rather than throwing — the match still succeeds.
		return value
	}
}

/**
 * Extracts the URL-decoded params a compiled path captures from a concrete
 * pathname, or `undefined` when the pathname does not match.
 *
 * @remarks
 * Encodes `pathname` with {@link encodePath}, so raw and encoded path text read
 * alike, then runs the {@link CompiledPath} `regex` against it (a single `exec`); a
 * miss returns `undefined`. On a hit it walks `params` POSITIONALLY — the
 * `n`-th param name pairs with the `n`-th capture group — and URL-decodes each
 * value with {@link decodeParam}. Returns a frozen `name → value` record (empty
 * for a parameterless path). Total — never throws. A decoded value is opaque
 * text: `..%2F` decodes to `../` and `%00` to a NUL character, so a consumer that
 * maps a capture to a file path must contain it.
 *
 * @param compiled - The {@link CompiledPath} from {@link compilePath}
 * @param pathname - The request path text to match, raw or encoded (for example `/users/7`)
 * @returns The decoded params on a hit, or `undefined` on a miss
 *
 * @example
 * ```ts
 * const compiled = compilePath('/users/:id')
 * matchPath(compiled, '/users/7') // { id: '7' }
 * matchPath(compiled, '/users/a%2Fb') // { id: 'a/b' } — decoded
 * matchPath(compiled, '/posts/7') // undefined
 * ```
 */
export function matchPath(
	compiled: CompiledPath,
	pathname: string,
): Readonly<Record<string, string>> | undefined {
	const result = compiled.regex.exec(encodePath(pathname))
	if (result === null) return undefined
	const params = compiled.params.entries().flatMap(([index, name]) => {
		const value = result[index + 1]
		return value === undefined ? [] : [[name, decodeParam(value)]]
	})
	return Object.freeze(Object.fromEntries(params))
}

/**
 * Classifies one path segment into its specificity tier — the same syntax
 * {@link compilePath} rewrites: a syntactically valid `:name` head is a param
 * segment, a final `*name` is a wildcard segment, and everything else (including a
 * literal segment that merely contains a `:` mid-string, for example `a:b`) is a
 * literal segment.
 *
 * @remarks
 * This is the fix over the old engine's bug: the old classifier ranked any
 * segment `includes(':')` as a param, so a literal segment like `a:b` was
 * mis-tiered even though {@link compilePath} compiles it literally. Sharing one
 * segment parser between compilation and classification keeps the two in
 * agreement. Pure and total.
 *
 * @param segment - One `/`-split path segment
 * @param isFinal - If `true`, `segment` is the path's last segment and may
 *   classify as a wildcard; if `false`, a wildcard-shaped segment classifies as
 *   a literal
 * @returns The segment's specificity tier — {@link import('./constants.js').TIER_LITERAL},
 *   {@link import('./constants.js').TIER_PARAM}, or
 *   {@link import('./constants.js').TIER_WILDCARD}
 *
 * @example
 * ```ts
 * classifySegment(':id', true) // 1 — TIER_PARAM
 * classifySegment('*rest', true) // 0 — TIER_WILDCARD
 * classifySegment('a:b', true) // 2 — TIER_LITERAL — the old bug's regression case
 * classifySegment('users', false) // 2 — TIER_LITERAL
 * ```
 */
export function classifySegment(segment: string, isFinal: boolean): number {
	if (isFinal && /^\*[A-Za-z_]\w*$/.test(segment)) return TIER_WILDCARD
	if (/^:[A-Za-z_]\w*/.test(segment)) return TIER_PARAM
	return TIER_LITERAL
}

/**
 * Computes a route path's specificity vector — one {@link SegmentRank} per
 * segment, the ranking that picks the winner when several registered routes
 * match the same concrete pathname.
 *
 * @remarks
 * Splits the CANONICALIZED path into segments (on `/`) and ranks each by its
 * tier through {@link classifySegment} — the same segment parser
 * {@link compilePath} uses, so a literal segment that merely contains a `:`
 * (for example `a:b`) is tiered as literal rather than param — and then by the
 * encoded length of its literal text: the whole segment for a literal, the
 * suffix after the name for a param, and `0` for a wildcard.
 * {@link compareSpecificity} reads two vectors segment by segment.
 *
 * @param path - The route path pattern (for example `/users/:id`)
 * @returns The per-segment ranks, in order
 *
 * @example
 * ```ts
 * computeSpecificity('/users/:id') // [{ tier: 2, length: 0 }, { tier: 2, length: 5 }, { tier: 1, length: 0 }]
 * computeSpecificity('/files/:name.json').at(-1) // { tier: 1, length: 5 }
 * computeSpecificity('/files/*rest').at(-1) // { tier: 0, length: 0 }
 * computeSpecificity('/a:b').at(-1) // { tier: 2, length: 3 } — literal, not param
 * ```
 */
export function computeSpecificity(path: string): readonly SegmentRank[] {
	const segments = canonicalizePath(path).split('/')
	return segments.map((segment, index) => {
		const tier = classifySegment(segment, index === segments.length - 1)
		if (tier === TIER_WILDCARD) return { tier, length: 0 }
		const literal = tier === TIER_PARAM ? segment.replace(/^:[A-Za-z_]\w*/, '') : segment
		return { tier, length: literal.length }
	})
}

/**
 * Compares two specificity vectors — the comparator that picks the
 * most-specific matching route: tier first, then literal length, segment by
 * segment.
 *
 * @remarks
 * Walks the two {@link computeSpecificity} vectors LEFT-TO-RIGHT and returns a
 * standard `Array.sort` ordering: a NEGATIVE number when `a` is MORE specific
 * than `b` (so a descending-specificity sort puts `a` first), positive when `b`
 * is more specific, `0` when neither out-ranks the other. At the first segment
 * where the ranks differ, the higher tier wins (a literal over a param over a
 * wildcard), and within one tier the longer literal text wins, so
 * `/files/:name.json` outranks `/files/:name`. If one vector is a prefix of the
 * other, the LONGER, more-segmented path is more specific (a missing segment
 * ranks below any real one). A `0` leaves the choice to the caller; the
 * `Router` keeps the earlier registration.
 *
 * @param a - The first path's specificity vector
 * @param b - The second path's specificity vector
 * @returns A negative number when `a` is more specific, positive when `b` is, else `0`
 *
 * @example
 * ```ts
 * compareSpecificity(computeSpecificity('/users/me'), computeSpecificity('/users/:id')) // negative — literal wins
 * compareSpecificity(computeSpecificity('/files/:name.json'), computeSpecificity('/files/:name')) // negative — longer suffix wins
 * compareSpecificity(computeSpecificity('/users/:id'), computeSpecificity('/users/:slug')) // 0 — equal specificity
 * ```
 */
export function compareSpecificity(a: readonly SegmentRank[], b: readonly SegmentRank[]): number {
	const longest = a.length >= b.length ? a : b
	for (const [index] of longest.entries()) {
		// A missing segment ranks below any real one (the shorter path is less specific).
		const left = a[index]
		const right = b[index]
		const tierA = left?.tier ?? -1
		const tierB = right?.tier ?? -1
		if (tierA !== tierB) return tierB - tierA
		const lengthA = left?.length ?? 0
		const lengthB = right?.length ?? 0
		if (lengthA !== lengthB) return lengthB - lengthA
	}
	return 0
}

/**
 * Joins a group prefix and a route path into one `/`-prefixed path, normalizing
 * duplicate or missing joining slashes.
 *
 * @remarks
 * {@link import('./types.js').GroupInterface} / {@link import('./types.js').DispatchGroupInterface}
 * compose a prefix with each registered entry's path this way — pure string
 * composition, no independent state. Both a duplicated slash
 * (`'/api/'` + `'/users'`) and a missing one (`'/api'` + `'users'`) normalize
 * to a single joining slash. An empty `prefix` returns `path` unchanged (after
 * ensuring a leading slash); an empty `path` returns `prefix` unchanged.
 * Pure and total.
 *
 * @param prefix - The group prefix (for example `/api`)
 * @param path - The route path being joined under the prefix (for example `/users`)
 * @returns The joined `/`-prefixed path
 *
 * @example
 * ```ts
 * joinPaths('/api', '/users') // '/api/users'
 * joinPaths('/api/', '/users') // '/api/users'
 * joinPaths('/api', 'users') // '/api/users'
 * joinPaths('', '/users') // '/users'
 * joinPaths('/api', '') // '/api'
 * ```
 */
export function joinPaths(prefix: string, path: string): string {
	if (prefix === '') return path.startsWith('/') ? path : `/${path}`
	if (path === '') return prefix
	const left = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
	const right = path.startsWith('/') ? path : `/${path}`
	return `${left}${right}`
}

/**
 * Provides an identity pass-through for a {@link RouteInput} that pins its `Path`
 * generic to the literal registration-site string, so `context.params` types
 * correctly through {@link PathParams} without an explicit type argument.
 *
 * @remarks
 * A bare object literal handed straight to {@link import('./types.js').DispatcherInterface}'s
 * `add` already infers `Path` as a literal at that call site — but the moment
 * the object is built through an intermediate binding (a local `const route =
 * { method, path, handler }`) TypeScript widens `path` to `string` unless the
 * binding's own type is pinned. Wrapping the literal in `defineRoute(...)`
 * supplies that pin: its `const Path extends string` type parameter infers the
 * NARROW literal from the call, and the function returns its input completely
 * unchanged (same reference, no cloning, no validation) — this is a
 * compile-time typing aid only, not a construction step (contrast
 * {@link import('./factories.js')} `create*` entity factories). A
 * heterogeneous `RouteInput[]` built from several `defineRoute(...)` calls
 * still widens each element's `Path` to `string` after collection into one array —
 * the realistic ceiling this helper raises is PER-CALL typing at the
 * registration site, not a stored, still-literal-typed record.
 *
 * @typeParam Path - The route path pattern literal (drives `context.params`
 *   through {@link PathParams})
 * @typeParam TState - The consumer's opaque per-request state type
 * @param input - The {@link RouteInput} to pass through unchanged
 * @returns `input`, unchanged (same reference)
 *
 * @example
 * ```ts
 * const input = defineRoute({
 * 	method: 'GET',
 * 	path: '/users/:id',
 * 	handler: (_request, context) => new Response(context.params.id), // typed string
 * })
 * dispatcher.add(input)
 * ```
 */
export function defineRoute<const Path extends string, TState = undefined>(
	input: RouteInput<Path, TState>,
): RouteInput<Path, TState> {
	return input
}
