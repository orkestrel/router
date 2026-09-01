// ============================================================================
//  Core coercers — the §5 centralized home for `parse*` narrowing leaves that
//  turn a raw external string into a typed core value or `undefined`. Every
//  declaration here is total and `export`ed per AGENTS §5.
// ============================================================================

import type { Method } from './types.js'
import { METHOD_LIST } from './constants.js'

/**
 * Narrows a raw `request.method` string into a typed {@link Method} — total,
 * never throws.
 *
 * @remarks
 * Consults {@link import('./constants.js').METHOD_LIST} (the one home for the
 * seven registrable HTTP methods), so a verb added there narrows here without
 * a second list to update; any other value (an unknown verb, non-uppercase
 * casing) resolves to `undefined` rather than throwing (§14 guard totality).
 * Pure leaf shared by the `Dispatcher`'s `handle` (§5.1 unknown-verb honesty)
 * and anywhere else a raw method string needs narrowing.
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
	return METHOD_LIST.find((method) => method === value)
}
