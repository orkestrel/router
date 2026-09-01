// ============================================================================
//  Server guards — the §5 centralized home for the total `is*` narrows the
//  `node:http` conversion seam applies to raw connection values. Every
//  declaration here is total and `export`ed per AGENTS §5.
// ============================================================================

import { isRecord } from '@orkestrel/contract'

/**
 * Determine whether a `node:http` connection socket is TLS-encrypted — the
 * total, never-throwing narrow (AGENTS §14) `buildRequest` uses to pick the
 * derived scheme (`https` vs `http`).
 *
 * @param socket - The connection value to test (typically `message.socket`)
 * @returns `true` when `socket` carries a truthy `encrypted` property (a
 *   `tls.TLSSocket`), `false` for anything else (including `undefined`)
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
