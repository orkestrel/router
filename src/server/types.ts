// ============================================================================
//  The node adapter — type definitions (the types.ts source of truth). This face is
//  deliberately tiny: message-format conversion between `node:http` and the
//  fetch vocabulary the core `Dispatcher` speaks, nothing else. No
//  lifecycle and no listener ownership.
// ============================================================================

import type { ServerResponse } from 'node:http'

/**
 * Represents the options for `buildRequest` — URL origin, response-side disconnect tracking, and a linked cancellation signal.
 *
 * @remarks
 * - `origin` — the scheme and authority an origin-form target is appended to
 *   (`https://api.example.com`). It replaces the `Host` header in the URL, and a
 *   `Host` header that is present must still be valid. Omitted ⇒ derived
 *   from the connection: the socket's `encrypted` presence picks `https`/`http`,
 *   and the `Host` header supplies the authority (absent `Host` ⇒ `localhost`).
 * - `response` — the paired `node:http` response. When provided, closing its
 *   connection before `writableEnded` aborts the built request's signal, and its
 *   `finish` discards whatever request body is left unread.
 * - `signal` — a caller's signal; aborting it before the exchange ends aborts the
 *   built request's signal with the same reason. The exchange ends when `response`
 *   closes, or, without one, when the message closes.
 */
export interface RequestOptions {
	readonly origin?: string
	readonly response?: ServerResponse
	readonly signal?: AbortSignal
}
