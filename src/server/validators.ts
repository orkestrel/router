// ============================================================================
//  Server guards — the centralized-file rule's home for the total `is*` narrows the
//  `node:http` conversion seam applies to raw connection values. Every
//  declaration here is total and `export`ed per the centralized-file rule.
// ============================================================================

import { isRecord } from '@orkestrel/contract'

/**
 * Determines whether a `node:http` connection socket is TLS-encrypted — the
 * total, never-throwing narrow `buildRequest` uses to pick the
 * derived scheme (`https` vs `http`).
 *
 * @param socket - The connection value to test (typically `message.socket`)
 * @returns True if `socket` carries a truthy `encrypted` property (a
 *   `tls.TLSSocket`); false otherwise, including for `undefined`
 *
 * @example
 * ```ts
 * import { isEncryptedSocket } from '@src/server'
 *
 * isEncryptedSocket({ encrypted: true }) // true
 * isEncryptedSocket({}) // false
 * ```
 */
export function isEncryptedSocket(socket: unknown): socket is { readonly encrypted: true } {
	return isRecord(socket) && socket.encrypted === true
}
