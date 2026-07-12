import type { CompiledPath, Method } from './types.js'
import { TIER_LITERAL, TIER_PARAM, TIER_WILDCARD } from './constants.js'

// The PURE path-matching primitives (AGENTS §4.3 multi-word names — module scope,
// no entity context). Every one is exported (the centralized-file rule, §5): a
// consumer composes them directly, or reaches them through the `Router` engine.
// They speak ONLY `string` / `RegExp` / `Record` and `decodeURIComponent` (a
// platform global valid in Node and the browser alike) — NO DOM, NO `node:*` — so
// the SAME engine drives a method-dimensioned server dispatcher and a method-less
// browser navigator.

/**
 * Escape every regex metacharacter in a literal string so it can be embedded
 * inside a larger `RegExp` source without being interpreted as syntax.
 *
 * @remarks
 * {@link compilePath} escapes the literal segments of a route pattern with this
 * before splicing in `:name` / `*name` capture groups, so a path like
 * `/files/:name.json` matches the `.` literally rather than as "any character".
 * Pure and total — never throws.
 *
 * @param value - The literal string to escape
 * @returns `value` with every regex metacharacter backslash-escaped
 *
 * @example
 * ```ts
 * escapeRegExp('a.b+c') // 'a\\.b\\+c'
 * new RegExp(`^${escapeRegExp('a.b')}$`).test('a.b') // true
 * new RegExp(`^${escapeRegExp('a.b')}$`).test('axb') // false
 * ```
 */
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Canonicalize a route path for REGISTRY IDENTITY — strip a single trailing
 * slash, except the root `/` (and the empty pattern). The trailing-slash fold
 * {@link compilePath} normalizes a pattern through, so identity agrees with the
 * matcher.
 *
 * @remarks
 * Mirrors {@link compilePath}'s trailing-slash folding: `/users/` canonicalizes
 * to `/users` (the two compile to the same regex and match the same
 * pathnames), while the root `/` and the empty `''` are EXEMPT (a bare `/`
 * already matches `/`; stripping it would break that). Pure and total — a path
 * without a trailing slash returns unchanged.
 *
 * @param path - The route path pattern
 * @returns The canonical path (one trailing slash removed, except `/` and `''`)
 *
 * @example
 * ```ts
 * canonicalizePath('/users/') // '/users'
 * canonicalizePath('/users') // '/users'
 * canonicalizePath('/') // '/'
 * canonicalizePath('') // ''
 * ```
 */
export function canonicalizePath(path: string): string {
	return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/**
 * Compile a route path pattern into an anchored regex and its ordered param
 * names.
 *
 * @remarks
 * Splits the CANONICALIZED path into segments. Each `:name` segment becomes a
 * `([^/]+)` capture group; the FINAL segment may instead be `*name`, which
 * becomes a `(.+)` capture spanning the REST of the path including slashes — a
 * wildcard segment anywhere but last is a registration-time programmer error
 * and throws `TypeError` (§14 construction/registration boundary). Every regex
 * metacharacter in a literal segment is escaped first ({@link escapeRegExp}),
 * so a path like `/files/:name.json` matches the `.` literally apart from the
 * param. The regex is anchored (`^…$`), so it matches the whole pathname, not
 * a prefix.
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
 * regex flag, so `/Users` matches `/users`. The pattern's own casing is never
 * altered — only the matching behavior.
 *
 * @param path - The route path pattern (e.g. `/users/:id`, `/files/*rest`)
 * @param sensitive - Case-sensitive matching (default `true`)
 * @returns The {@link CompiledPath} — its `regex` + ordered `params`
 * @throws {TypeError} When a `*name` wildcard segment is not the FINAL segment
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
 * ```
 */
export function compilePath(path: string, sensitive = true): CompiledPath {
	const params: string[] = []
	// Normalize ONE trailing slash off the pattern so `/users/` compiles like `/users`
	// — except the root `/` (and the empty pattern), which must keep matching `/` / `''`.
	const normalized = canonicalizePath(path)
	const segments = normalized.split('/')
	const compiledSegments = segments.map((segment, index) => {
		const isFinal = index === segments.length - 1
		// A wildcard-shaped segment head (`*name`) is only valid as the FINAL segment — a
		// registration-time programmer error anywhere else (§14 boundary guard).
		if (!isFinal && /^\*[A-Za-z_]\w*/.test(segment))
			throw new TypeError(
				`a wildcard segment ("${segment}") must be the final segment of a path pattern, got "${path}"`,
			)
		// Classification and compilation share ONE segment parser (§4 fix) — the tier
		// {@link classifySegment} assigns is exactly the shape compiled here.
		const tier = classifySegment(segment, isFinal)
		if (tier === TIER_WILDCARD) {
			params.push(segment.slice(1))
			return '(.+)'
		}
		if (tier === TIER_PARAM) {
			const match = /^:([A-Za-z_]\w*)/.exec(segment)
			const name = match?.[1] ?? ''
			params.push(name)
			return `([^/]+)${escapeRegExp(segment.slice(1 + name.length))}`
		}
		return escapeRegExp(segment)
	})
	const pattern = compiledSegments.join('/')
	// Allow ONE optional trailing slash before the `$` anchor (Express `strict: false`),
	// EXCEPT for the root `/` and the empty pattern — those anchor exactly so they keep
	// matching only `/` / `''` (a bare `/?` there would let `''` match `/` and vice versa).
	const suffix = normalized === '/' || normalized === '' ? '' : '/?'
	const flags = sensitive ? '' : 'i'
	return { regex: new RegExp(`^${pattern}${suffix}$`, flags), params }
}

/**
 * URL-decode one captured param value, tolerating a malformed percent-escape —
 * the decode {@link matchPath} applies to each captured group.
 *
 * @remarks
 * A bad `%` sequence is not a reason to reject an otherwise-matching route, so
 * a `decodeURIComponent` that would throw falls back to the raw value
 * (mirroring the cookie / token boundary readers, AGENTS §14). Total — never
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
 * Extract the URL-decoded params a compiled path captures from a concrete
 * pathname, or `undefined` when the pathname does not match.
 *
 * @remarks
 * Runs the {@link CompiledPath} `regex` against `pathname` (a single `exec`); a
 * miss returns `undefined`. On a hit it walks `params` POSITIONALLY — the
 * `n`-th param name pairs with the `n`-th capture group — and URL-decodes each
 * value with {@link decodeParam}. Returns a frozen `name → value` record (empty
 * for a parameterless path). Total — never throws.
 *
 * @param compiled - The {@link CompiledPath} from {@link compilePath}
 * @param pathname - The concrete request pathname to match (e.g. `/users/7`)
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
	const result = compiled.regex.exec(pathname)
	if (result === null) return undefined
	const params: Record<string, string> = {}
	for (let index = 0; index < compiled.params.length; index += 1) {
		const name = compiled.params[index]
		const value = result[index + 1]
		if (name !== undefined && value !== undefined) params[name] = decodeParam(value)
	}
	return Object.freeze(params)
}

/**
 * Classify one path segment into its specificity TIER — the SAME syntax
 * {@link compilePath} rewrites: a syntactically valid `:name` head is a PARAM
 * segment, a final `*name` is a WILDCARD segment, everything else (including a
 * literal segment that merely CONTAINS a `:` mid-string, e.g. `a:b`) is a
 * LITERAL segment.
 *
 * @remarks
 * This is the fix over the old engine's bug: the old classifier ranked any
 * segment `includes(':')` as a param, so a literal segment like `a:b` was
 * mis-tiered even though {@link compilePath} compiles it literally. Sharing one
 * segment parser between compilation and classification keeps the two in
 * agreement (§4 fixes). Pure and total.
 *
 * @param segment - One `/`-split path segment
 * @param isFinal - Whether `segment` is the last segment of its path (only the
 *   final segment may be classified as a wildcard)
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
 * Compute a route path's SPECIFICITY VECTOR — the per-segment type ranking
 * that breaks a tie when several registered routes match the same concrete
 * pathname.
 *
 * @remarks
 * Splits the CANONICALIZED path into segments (on `/`) and maps each to its
 * specificity tier via {@link classifySegment} — the same segment parser
 * {@link compilePath} uses, so a literal segment that merely contains a `:`
 * (e.g. `a:b`) is correctly tiered as literal rather than param (the old
 * engine's bug, fixed here). The standard route-precedence rule compares two
 * matching routes' vectors LEFT-TO-RIGHT: at the first index where the tiers
 * differ, the HIGHER tier (a literal over a param over a wildcard) is MORE
 * SPECIFIC and wins — so `/users/me` (`[2, 2]`) beats `/users/:id` (`[2, 1]`)
 * beats `/users/*rest` (`[2, 0]`) regardless of registration order. Two routes
 * that match the SAME concrete pathname necessarily have the same segment
 * count in the common case; {@link compareSpecificity} handles the general
 * case for totality.
 *
 * @param path - The route path pattern (e.g. `/users/:id`)
 * @returns The per-segment specificity tiers, in order
 *
 * @example
 * ```ts
 * computeSpecificity('/users/me') // [2, 2]
 * computeSpecificity('/users/:id') // [2, 1]
 * computeSpecificity('/files/*rest') // [2, 0]
 * computeSpecificity('/a:b') // [2] — literal, not param — the classification fix
 * ```
 */
export function computeSpecificity(path: string): readonly number[] {
	const segments = canonicalizePath(path).split('/')
	return segments.map((segment, index) => classifySegment(segment, index === segments.length - 1))
}

/**
 * Compare two route paths by SPECIFICITY — the comparator that picks the
 * most-specific matching route (literal-over-param-over-wildcard,
 * registration-order-independent).
 *
 * @remarks
 * Compares the two paths' {@link computeSpecificity} vectors LEFT-TO-RIGHT and
 * returns a standard `Array.sort` ordering: a NEGATIVE number when `a` is MORE
 * specific than `b` (so a descending-specificity sort puts `a` first),
 * positive when `b` is more specific, `0` when neither out-ranks the other
 * across the compared segments. At the first index where the tiers differ,
 * the higher tier wins; if one vector is a prefix of the other (different
 * segment counts), the LONGER, more-segmented path is treated as more
 * specific (a missing segment ranks below any real one).
 *
 * @param a - The first route path
 * @param b - The second route path
 * @returns A negative number when `a` is more specific, positive when `b` is, else `0`
 *
 * @example
 * ```ts
 * compareSpecificity('/users/me', '/users/:id') // negative — literal wins
 * compareSpecificity('/users/:id', '/users/*rest') // negative — param beats wildcard
 * compareSpecificity('/users/:id', '/users/:id') // 0 — equal specificity
 * ```
 */
export function compareSpecificity(a: string, b: string): number {
	const left = computeSpecificity(a)
	const right = computeSpecificity(b)
	const length = Math.max(left.length, right.length)
	for (let index = 0; index < length; index += 1) {
		// A missing segment ranks below any real one (the shorter path is less specific).
		const tierA = left[index] ?? -1
		const tierB = right[index] ?? -1
		if (tierA !== tierB) return tierB - tierA
	}
	return 0
}

/**
 * Narrow a raw `request.method` string into a typed {@link Method} — total,
 * never throws.
 *
 * @remarks
 * Guarded via {@link import('./constants.js').METHODS} (the seven registrable
 * HTTP methods); any other value (an unknown verb, non-uppercase casing)
 * resolves to `undefined` rather than throwing (§14 guard totality). Pure
 * leaf shared by the `Dispatcher`'s `handle` (§5.1 unknown-verb honesty) and
 * anywhere else a raw method string needs narrowing.
 *
 * @param value - The raw `request.method` string to narrow
 * @returns The matching {@link Method}, or `undefined` when `value` is not one
 *   of the seven registrable methods
 *
 * @example
 * ```ts
 * parseMethod('GET') // 'GET'
 * parseMethod('PURGE') // undefined
 * parseMethod('get') // undefined — case-sensitive
 * ```
 */
export function parseMethod(value: string): Method | undefined {
	if (
		value === 'GET' ||
		value === 'POST' ||
		value === 'PUT' ||
		value === 'PATCH' ||
		value === 'DELETE' ||
		value === 'HEAD' ||
		value === 'OPTIONS'
	)
		return value
	return undefined
}

/**
 * Join a group prefix and a route path into one `/`-prefixed path, normalizing
 * duplicate or missing joining slashes.
 *
 * @remarks
 * {@link import('./types.js').GroupInterface} / {@link import('./types.js').DispatchGroupInterface}
 * compose a prefix with each registered entry's path this way — pure string
 * composition (§4.2.2), no independent state. Both a duplicated slash
 * (`'/api/'` + `'/users'`) and a missing one (`'/api'` + `'users'`) normalize
 * to a single joining slash. An empty `prefix` returns `path` unchanged (after
 * ensuring a leading slash); an empty `path` returns `prefix` unchanged.
 * Pure and total.
 *
 * @param prefix - The group prefix (e.g. `/api`)
 * @param path - The route path being joined under the prefix (e.g. `/users`)
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
