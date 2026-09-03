// ============================================================================
//  Core constants — the centralized-file rule's home for module-scope data used by
//  the matching engine and the fetch dispatcher. Every declaration here is frozen
//  and `export`ed per the centralized-file rule.
// ============================================================================

/**
 * Lists the HTTP methods a {@link import('./types.js').DispatcherInterface}
 * registers routes under, in canonical order — the single source the
 * {@link import('./types.js').Method} type, {@link METHODS}, and
 * `parseMethod` are all derived from.
 *
 * @remarks
 * A frozen tuple of the verbs: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`,
 * `HEAD`, `OPTIONS`. Adding a verb here widens the `Method` type, the
 * {@link METHODS} membership set, and the `parseMethod` narrowing together, so
 * the method set cannot drift between them. Prefer {@link METHODS} for a
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
 * Holds the complete set of HTTP methods a
 * {@link import('./types.js').DispatcherInterface} registers routes under —
 * backs the registration guard (`add` rejects any `method` outside this set)
 * and the auto-`OPTIONS` `Allow` derivation.
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
 * METHODS.has('GET') // true
 * METHODS.has('TRACE') // false
 * ```
 */
export const METHODS: ReadonlySet<string> = Object.freeze(new Set<string>(METHOD_LIST))

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
