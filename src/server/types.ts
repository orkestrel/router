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
 *   (`https://api.example.com`). It overrides the `Host` header. Omitted ⇒ derived
 *   from the connection: the socket's `encrypted` presence picks `https`/`http`,
 *   and the `Host` header supplies the authority (absent `Host` ⇒ `localhost`).
 * - `response` — the paired `node:http` response. When provided, closing its
 *   connection before `writableEnded` aborts the built request's signal, and its
 *   `finish` discards whatever request body is left unread.
 * - `signal` — a caller's signal; aborting it aborts the built request's signal.
 */
export interface RequestOptions {
	readonly origin?: string
	readonly response?: ServerResponse
	readonly signal?: AbortSignal
}
