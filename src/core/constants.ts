// ============================================================================
//  Core constants — the §5 centralized home for module-scope data used by the
//  matching engine and the fetch dispatcher. Every declaration here is frozen
//  and `export`ed per AGENTS §5.
// ============================================================================

/**
 * The complete set of HTTP methods a {@link import('./types.js').Dispatcher}
 * registers routes under — backs the registration guard (`add` rejects any
 * `method` outside this set) and the auto-`OPTIONS` `Allow` derivation.
 *
 * @remarks
 * A `ReadonlySet` of the seven {@link import('./types.js').Method} literals:
 * `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`. `HEAD` is
 * included even though it is never required at registration (a `GET` route
 * auto-answers `HEAD`) — it is still a valid method to register explicitly.
 *
 * @example
 * ```ts
 * METHODS.has('GET') // true
 * METHODS.has('TRACE') // false
 * ```
 */
export const METHODS: ReadonlySet<string> = Object.freeze(
	new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
)

/**
 * Specificity tier for a **literal** path segment (`/users`) — the highest
 * tier, always outranking a param or wildcard segment at the same position.
 *
 * @remarks
 * Consumed by `pathSpecificity` (U1 `helpers.ts`) when ranking candidate
 * matches left-to-right at the earliest differing segment (§4 precedence).
 *
 * @example
 * ```ts
 * TIER_LITERAL > TIER_PARAM // true
 * ```
 */
export const TIER_LITERAL = 2

/**
 * Specificity tier for a **param** path segment (`:name`) — ranks below a
 * literal segment and above a wildcard segment at the same position.
 *
 * @remarks
 * Consumed by `pathSpecificity` (U1 `helpers.ts`) alongside {@link TIER_LITERAL}
 * and {@link TIER_WILDCARD}.
 *
 * @example
 * ```ts
 * TIER_PARAM > TIER_WILDCARD // true
 * ```
 */
export const TIER_PARAM = 1

/**
 * Specificity tier for a **wildcard** path segment (`*name`) — the lowest
 * tier; a wildcard only ever wins against another wildcard shape (an
 * equal-specificity tie resolved by registration order).
 *
 * @remarks
 * Consumed by `pathSpecificity` (U1 `helpers.ts`).
 *
 * @example
 * ```ts
 * TIER_WILDCARD // 0
 * ```
 */
export const TIER_WILDCARD = 0
