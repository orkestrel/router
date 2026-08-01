// ============================================================================
//  The node adapter — type definitions (the §5 source of truth). This face is
//  deliberately tiny: message-format conversion between `node:http` and the
//  fetch vocabulary the core `Dispatcher` speaks, nothing else (§5.3). No
//  lifecycle, no listener ownership beyond the handler function itself.
// ============================================================================

import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Options for `buildRequest` — URL origin and response-side disconnect tracking.
 *
 * @remarks
 * - `origin` — an explicit scheme + host to build the request URL against
 *   (`https://api.example.com`). Omitted ⇒ derived from the connection: the
 *   socket's `encrypted` presence picks `https`/`http`, and the `Host`
 *   header supplies the host (absent `Host` ⇒ `localhost`).
 * - `response` — the paired `node:http` response. When provided, closing its
 *   connection before `writableEnded` aborts the built request's signal.
 */
export interface RequestOptions {
	readonly origin?: string
	readonly response?: ServerResponse
}

/**
 * A `node:http` request handler — the function `createListener` returns,
 * matching `http.createServer`'s handler signature.
 *
 * @remarks
 * Invoked once per incoming message with the raw `IncomingMessage`/
 * `ServerResponse` pair; never returns a value (writes the response as a
 * side effect).
 */
export type ListenerFunction = (request: IncomingMessage, response: ServerResponse) => void

/**
 * Derives a consumer's opaque per-request `TState` from the raw
 * `IncomingMessage` — the `state` argument `createListener` threads into
 * `dispatcher.handle`.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 */
export type StateFunction<TState> = (message: IncomingMessage) => TState
