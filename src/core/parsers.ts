// ============================================================================
//  Core coercers — the centralized-file rule's home for `parse*` narrowing leaves that
//  turn a raw external string into a typed core value or `undefined`. Every
//  declaration here is total and `export`ed per the centralized-file rule.
// ============================================================================

import type { Method } from './types.js'
import { METHOD_LIST } from './constants.js'

/**
 * Narrows a raw `request.method` string into a typed {@link Method} — total,
 * never throws.
 *
 * @remarks
 * Consults {@link import('./constants.js').METHOD_LIST} (the one home for the
 * registrable HTTP methods), so a verb added there narrows here without
 * a second list to update; any other value (an unknown verb, non-uppercase
 * casing) resolves to `undefined` rather than throwing (total guard behavior).
 * Pure leaf shared by the `Dispatcher`'s `handle` (honest about an unknown verb)
 * and anywhere else a raw method string needs narrowing.
 *
 * @param value - The raw `request.method` string to narrow
 * @returns The matching {@link Method}, or `undefined` when `value` is not a
 *   registrable method
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
