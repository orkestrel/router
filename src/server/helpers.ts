// ============================================================================
//  Pure conversion between `node:http` and the fetch vocabulary the core
//  `Dispatcher` speaks — no lifecycle and no listener ownership. Every
//  function is exported per the centralized-file rule.
// ============================================================================

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RequestOptions } from './types.js'
import { once } from 'node:events'
import { createAbort } from '@orkestrel/abort'
import { isEncryptedSocket } from './validators.js'

/**
 * Builds a fetch-standard `Request` from a `node:http` `IncomingMessage` — the
 * server-adapter half of the fetch/node conversion seam.
 *
 * @remarks
 * - `method` is carried over verbatim (defaulting to `GET` when absent).
 * - The URL is built against `options.origin` when given, otherwise a scheme
 *   derived from the connection (`https` when {@link isEncryptedSocket}, else
 *   `http`) plus the `Host` header (absent `Host` ⇒ `localhost`).
 * - Every request header is copied; multi-value headers are joined per fetch
 *   semantics (`', '`-joined), except `set-cookie`, whose values are each
 *   appended individually (fetch `Headers` preserves multiple `set-cookie`
 *   entries distinctly).
 * - For a method that carries a body (anything but `GET`/`HEAD`), the message
 *   is pumped chunk by chunk into a DOM-compatible `ReadableStream<Uint8Array>`
 *   (reconciling the DOM + node type worlds under the root config), with
 *   `duplex: 'half'` set as Node's fetch implementation requires for a
 *   streamed request body.
 * - A fresh `@orkestrel/abort` handle backs `request.signal`. It aborts when
 *   the request connection closes before the message finished
 *   (`!message.complete`), or when the paired `options.response` closes before
 *   its response finished (`!response.writableEnded`). A handler awaiting the
 *   signal therefore observes either side of a client disconnect the
 *   fetch-standard way, with zero router-specific API.
 *
 * @param message - The raw `node:http` request
 * @param options - Optional `origin` override and paired `response` for
 *   response-side disconnect tracking ({@link RequestOptions})
 * @returns A fetch `Request` whose `signal` fires on an incomplete request, or
 *   on a response-side client disconnect when `options.response` is provided
 *
 * @example
 * ```ts
 * import { buildRequest } from '@src/server'
 * import http from 'node:http'
 *
 * const server = http.createServer((incoming, response) => {
 * 	const request = buildRequest(incoming, { response })
 * 	console.log(request.method, request.url)
 * })
 * ```
 */
export function buildRequest(message: IncomingMessage, options?: RequestOptions): Request {
	const method = message.method ?? 'GET'
	const host = message.headers.host ?? 'localhost'
	const scheme = isEncryptedSocket(message.socket) ? 'https' : 'http'
	const origin = options?.origin ?? `${scheme}://${host}`
	const url = new URL(message.url ?? '/', origin)

	const headers = new Headers()
	for (const [name, value] of Object.entries(message.headers)) {
		if (value === undefined) continue
		if (name === 'set-cookie') {
			for (const cookie of Array.isArray(value) ? value : [value]) headers.append(name, cookie)
			continue
		}
		headers.set(name, Array.isArray(value) ? value.join(', ') : value)
	}

	const abort = createAbort()
	message.once('close', () => {
		if (!message.complete)
			abort.abort(new Error(`request to ${url.pathname} disconnected before completion`))
	})
	const response = options?.response
	if (response !== undefined)
		response.once('close', () => {
			if (!response.writableEnded)
				abort.abort(new Error(`request to ${url.pathname} disconnected before response completed`))
		})

	const carriesBody = method !== 'GET' && method !== 'HEAD'
	const init: RequestInit = { method, headers, signal: abort.signal }
	if (!carriesBody) return new Request(url, init)

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const chunk of message) controller.enqueue(chunk)
				controller.close()
			} catch (error) {
				controller.error(error)
			}
		},
	})
	const streamed: RequestInit & { readonly duplex: 'half' } = { ...init, body, duplex: 'half' }
	return new Request(url, streamed)
}

/**
 * Writes a fetch-standard `Response` back to a `node:http` `ServerResponse` —
 * the reverse half of the fetch/node conversion seam.
 *
 * @remarks
 * Writes `status`/`statusText`, then every response header (`set-cookie`
 * written through {@link Headers.getSetCookie} so multiple cookies stay distinct
 * instead of collapsing into one comma-joined header), then streams the web
 * body to `target` chunk by chunk (`for await` over `response.body`), ending
 * `target` when the stream completes. When a write reports backpressure, the
 * body pump waits for `drain` before pulling again, unless the target closes,
 * errors, or is destroyed first. A `null` body ends `target` immediately with
 * no further writes. Total error posture: if `target` is destroyed mid-stream
 * (the client disconnected), the write loop stops and `target` is left as-is
 * rather than throwing an unhandled rejection — a destroyed target is not
 * this function's error to surface.
 *
 * @param response - The fetch `Response` to write
 * @param target - The `node:http` response to write it to
 * @returns A promise that resolves after `target` has been ended (or the
 *   stream stopped because `target` was destroyed)
 *
 * @example
 * ```ts
 * import { sendResponse } from '@src/server'
 * import http from 'node:http'
 *
 * const server = http.createServer(async (_incoming, target) => {
 * 	await sendResponse(new Response('ok'), target)
 * })
 * ```
 */
export async function sendResponse(response: Response, target: ServerResponse): Promise<void> {
	target.statusCode = response.status
	target.statusMessage = response.statusText
	for (const [name, value] of response.headers) {
		if (name === 'set-cookie') continue
		target.setHeader(name, value)
	}
	const cookies = response.headers.getSetCookie()
	if (cookies.length > 0) target.setHeader('set-cookie', cookies)

	if (response.body === null) {
		if (!target.destroyed) target.end()
		return
	}
	try {
		for await (const chunk of response.body) {
			if (target.destroyed) return
			if (!target.write(chunk)) {
				if (target.destroyed) return
				const abort = new AbortController()
				try {
					await Promise.race([
						once(target, 'drain', { signal: abort.signal }),
						once(target, 'close', { signal: abort.signal }),
					])
				} finally {
					abort.abort()
				}
				if (target.destroyed) return
			}
		}
		if (!target.destroyed) target.end()
	} catch {
		if (!target.destroyed) target.end()
	}
}
