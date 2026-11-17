// ============================================================================
//  Server guards — the centralized-file rule's home for the total `is*` narrows the
//  `node:http` conversion seam applies to raw connection values. Every
//  declaration here is total and `export`ed per the centralized-file rule.
// ============================================================================

import { holds, isObject, isString } from '@orkestrel/contract'

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
	return holds(() => isObject(socket) && 'encrypted' in socket && socket.encrypted === true)
}

/**
 * Checks whether a value is an HTTP authority a server accepts: a host with an optional port, and no userinfo.
 *
 * @remarks
 * The grammar is RFC 9110's `uri-host [ ":" port ]`: an IP literal in brackets or a
 * registered name of unreserved, percent-encoded, and sub-delimiter characters, then an
 * optional port. The value must also parse as a WHATWG `http:` authority, which refuses a
 * malformed IP literal and a port above 65535. A path, a query, a fragment, userinfo, and
 * whitespace are refused.
 *
 * @param value - The value to test (typically a `Host` header or an absolute-form authority)
 * @returns True if `value` is a host with an optional port; false otherwise
 *
 * @example
 * ```ts
 * import { isAuthority } from '@orkestrel/router/server'
 *
 * isAuthority('app.local:8080') // true
 * isAuthority('user@app.local') // false
 * ```
 */
export function isAuthority(value: unknown): value is string {
	return (
		isString(value) &&
		/^(?:\[[0-9A-Fa-f:.]+\]|(?:[A-Za-z0-9\-._~!$&'()*+,;=]|%[0-9A-Fa-f]{2})+)(?::[0-9]*)?$/.test(
			value,
		) &&
		URL.canParse(`http://${value}`)
	)
}
