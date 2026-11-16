// ============================================================================
//  Core constants — the centralized-file rule's home for module-scope data used by
//  the matching engine and the fetch dispatcher. Every declaration here is frozen
//  and `export`ed per the centralized-file rule.
// ============================================================================

import { escapeRegExp } from '@orkestrel/contract'

/**
 * Lists the HTTP methods a {@link import('./types.js').DispatcherInterface} registers
 * routes under, in canonical order — a frozen literal tuple, and the single source the
 * {@link import('./types.js').Method} type, {@link HTTP_METHODS}, and `parseMethod` are all
 * derived from.
 *
 * @remarks
 * A frozen tuple of the verbs: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`,
 * `HEAD`, `OPTIONS`. Adding a verb here widens the `Method` type, the
 * {@link HTTP_METHODS} membership set, and the `parseMethod` narrowing together, so
 * the method set cannot drift between them. Prefer {@link HTTP_METHODS} for a
 * membership test; use this tuple where order or literal typing matters.
 *
 * @example
 * ```ts
 * METHOD_LIST[0] // 'GET'
 * METHOD_LIST.includes('GET') // true
 * ```
 */
export const METHOD_LIST = Object.freeze([
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'HEAD',
	'OPTIONS',
] as const)

/**
 * Holds every HTTP method a {@link import('./types.js').DispatcherInterface} registers
 * routes under as a `ReadonlySet` — backs the registration guard (`add` rejects any
 * `method` outside this set).
 *
 * @remarks
 * A `ReadonlySet` built from {@link METHOD_LIST}, so it carries exactly the
 * {@link import('./types.js').Method} literals: `GET`, `POST`, `PUT`,
 * `PATCH`, `DELETE`, `HEAD`, `OPTIONS`. `HEAD` is included even though it is
 * never required at registration (a `GET` route auto-answers `HEAD`) — it is
 * still a valid method to register explicitly. The element type stays `string`
 * so a raw, unnarrowed `request.method` can be tested directly.
 *
 * @example
 * ```ts
 * HTTP_METHODS.has('GET') // true
 * HTTP_METHODS.has('TRACE') // false
 * ```
 */
export const HTTP_METHODS: ReadonlySet<string> = Object.freeze(new Set<string>(METHOD_LIST))

/**
 * Holds the printable ASCII members of the path encode set `encodePath` reads: the URL
 * Standard's path percent-encode set plus `|`, beside every C0 control, U+007F, and greater
 * code point.
 *
 * @remarks
 * Transcribed from URL Standard § 1.3, Percent-encoded bytes (Living Standard, Last Updated
 * 2026-11-14, commit snapshot `47721bbd2d518f249ae63d08b81514c2d13546d8`): the C0 control
 * percent-encode set is the C0 controls and every code point greater than U+007E, the query
 * set adds U+0020, `"`, `#`, `<`, and `>`, and the path set adds `?`, `^`, `` ` ``, `{`, and
 * `}`. The table adds `|` as a declared departure from the standard: Chromium 153 encodes
 * `|` in a path as `%7C` while Node 22 leaves it raw, so with `|` in the table both hosts'
 * requests compare as `%7C`. The router reads this table, never the host's `URL` parser, so
 * every host compares one text.
 *
 * @example
 * ```ts
 * PATH_ENCODE_SET.has('^') // true
 * PATH_ENCODE_SET.has('|') // true — the declared departure
 * PATH_ENCODE_SET.has('[') // false
 * ```
 */
export const PATH_ENCODE_SET: ReadonlySet<string> = Object.freeze(
	new Set<string>([' ', '"', '#', '<', '>', '?', '^', '`', '{', '|', '}']),
)

/**
 * Lists the uppercase percent-escape of every byte value, indexed by the byte, so `encodePath`
 * writes each escape with one lookup.
 *
 * @example
 * ```ts
 * PERCENT_ESCAPES[0x5e] // '%5E'
 * PERCENT_ESCAPES[0xc3] // '%C3'
 * ```
 */
export const PERCENT_ESCAPES: readonly string[] = Object.freeze(
	Array.from(
		{ length: 0x100 },
		(_, byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
	),
)

/**
 * Matches one code point `encodePath` writes as escapes: a C0 control, a member of
 * {@link PATH_ENCODE_SET}, U+007F, or any greater code point.
 *
 * @remarks
 * Built from {@link PATH_ENCODE_SET} when the module loads, as a non-global `u`-flag character
 * class, so a lone surrogate matches as one code point and `test` keeps no state.
 *
 * @example
 * ```ts
 * PATH_ENCODE_PATTERN.test('/café') // true
 * PATH_ENCODE_PATTERN.test('/users') // false
 * ```
 */
export const PATH_ENCODE_PATTERN: RegExp = Object.freeze(
	new RegExp(`[\\0-\\x1F\\x7F-\\u{10FFFF}${escapeRegExp([...PATH_ENCODE_SET].join(''))}]`, 'u'),
)

/**
 * Holds the code points a route pattern must not hold: `\`, tab, line feed, and carriage
 * return, which a URL parser reads as a separator or deletes, so the pattern would name a
 * path other than its text.
 *
 * @example
 * ```ts
 * PATH_REFUSED_SET.has('\\') // true
 * PATH_REFUSED_SET.has('\u000B') // false
 * ```
 */
export const PATH_REFUSED_SET: ReadonlySet<string> = Object.freeze(
	new Set<string>(['\\', '\t', '\n', '\r']),
)

/**
 * Holds the own property names of `Object.prototype` — the names `compilePath` refuses as
 * a param name, so a params record never shadows or drops an inherited key.
 *
 * @remarks
 * Read once when the module loads, from `Object.getOwnPropertyNames(Object.prototype)`:
 * `__proto__`, `constructor`, `hasOwnProperty`, `toString`, `valueOf`, and the rest.
 *
 * @example
 * ```ts
 * PROTOTYPE_KEYS.has('__proto__') // true
 * PROTOTYPE_KEYS.has('id') // false
 * ```
 */
export const PROTOTYPE_KEYS: ReadonlySet<string> = Object.freeze(
	new Set<string>(Object.getOwnPropertyNames(Object.prototype)),
)

/**
 * Names the specificity tier for a **literal** path segment (`/users`) — the highest
 * tier, always outranking a param or wildcard segment at the same position.
 *
 * @remarks
 * Consumed by `computeSpecificity` (the path compiler in `helpers.ts`) when ranking candidate
 * matches left-to-right at the earliest differing segment.
 *
 * @example
 * ```ts
 * TIER_LITERAL > TIER_PARAM // true
 * ```
 */
export const TIER_LITERAL = 2

/**
 * Names the specificity tier for a **param** path segment (`:name`) — ranks below a
 * literal segment and above a wildcard segment at the same position.
 *
 * @remarks
 * Consumed by `computeSpecificity` (the path compiler in `helpers.ts`) alongside {@link TIER_LITERAL}
 * and {@link TIER_WILDCARD}.
 *
 * @example
 * ```ts
 * TIER_PARAM > TIER_WILDCARD // true
 * ```
 */
export const TIER_PARAM = 1

/**
 * Names the specificity tier for a **wildcard** path segment (`*name`) — the lowest
 * tier; a wildcard only ever wins against another wildcard shape (an
 * equal-specificity tie resolved by registration order).
 *
 * @remarks
 * Consumed by `computeSpecificity` (the path compiler in `helpers.ts`).
 *
 * @example
 * ```ts
 * TIER_WILDCARD // 0
 * ```
 */
export const TIER_WILDCARD = 0
