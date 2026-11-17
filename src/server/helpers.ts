// ============================================================================
//  Pure conversion between `node:http` and the fetch vocabulary the core
//  `Dispatcher` speaks — no lifecycle and no listener ownership. Every
//  function is exported per the centralized-file rule.
// ============================================================================

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RequestOptions } from './types.js'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { ReadableStream as WebReadableStream } from 'node:stream/web'
import { createAbort } from '@orkestrel/abort'
import { ContractError, isArray, isError, preview } from '@orkestrel/contract'
import { isAuthority, isEncryptedSocket } from './validators.js'

/**
 * Builds the URL of a `node:http` request from its request target, by the target's form.
 *
 * @remarks
 * - A `Host` header is checked first, for every target form and whether or not
 *   `origin` is given (RFC 9112 section 3.2): more than one `Host` field line, or a
 *   value that fails {@link isAuthority}, is refused.
 * - An origin-form target (one that opens with `/`) is appended to the origin, so
 *   `//evil.example/admin` keeps the origin's authority and its pathname stays
 *   `//evil.example/admin`. The origin is the WHATWG origin of `origin` when given;
 *   otherwise `https` or `http` by {@link isEncryptedSocket}, then the `Host` header
 *   (absent `Host` ⇒ `localhost`).
 * - An absolute-form target takes its own authority, for `http:` and `https:` only.
 * - The asterisk form and every other form are refused.
 *
 * @param message - The raw `node:http` request
 * @param origin - The scheme and authority that replace the `Host` header in the URL
 * @returns The parsed request URL
 * @throws {@link ContractError} Thrown when the message carries more than one `Host` field
 *   line or a `Host` that fails {@link isAuthority}, or when the target is not origin-form
 *   or an `http:` or `https:` absolute-form target whose authority passes {@link isAuthority}
 *
 * @example
 * ```ts
 * import { buildURL } from '@orkestrel/router/server'
 * import http from 'node:http'
 *
 * const server = http.createServer((message, response) => {
 * 	response.end(buildURL(message).pathname)
 * })
 * ```
 */
export function buildURL(message: IncomingMessage, origin?: string): URL {
	// A scan of the raw names, not `headersDistinct`, which rebuilds every header per request.
	const lines = message.rawHeaders.filter(
		(name, index) => index % 2 === 0 && name.length === 4 && name.toLowerCase() === 'host',
	).length
	if (lines > 1)
		throw new ContractError('a request must carry at most one Host header', {
			code: 'pattern',
			context: {
				path: ['message', 'headers', 'host'],
				limit: 'one Host field line',
				received: preview(lines),
			},
		})
	const host = message.headers.host
	if (host !== undefined && !isAuthority(host))
		throw new ContractError('a Host header must be a host with an optional port', {
			code: 'pattern',
			context: {
				path: ['message', 'headers', 'host'],
				limit: 'uri-host [ ":" port ]',
				received: preview(host),
			},
		})
	const target = message.url ?? ''
	if (target.startsWith('/')) {
		if (origin !== undefined) return new URL(`${new URL(origin).origin}${target}`)
		const authority = host ?? 'localhost'
		return new URL(
			`${isEncryptedSocket(message.socket) ? 'https' : 'http'}://${authority}${target}`,
		)
	}
	const authority = /^https?:\/\/([^/?#]*)/i.exec(target)?.[1]
	if (authority !== undefined && isAuthority(authority)) return new URL(target)
	throw new ContractError('a request target must be origin-form or http or https absolute-form', {
		code: 'pattern',
		context: {
			path: ['message', 'url'],
			limit: 'origin-form, or absolute-form with an http or https scheme and a host',
			received: preview(target),
		},
	})
}

/**
 * Reads the next chunk of a `node:http` request body, waiting for one to arrive.
 *
 * @remarks
 * Reads one buffered chunk from the paused message, and only then waits for the next
 * `readable` event. Resolves `undefined` after the message is complete and drained.
 *
 * @param message - The raw `node:http` request, read in paused mode
 * @param signal - Aborts a pending wait
 * @returns The next chunk, or `undefined` at the end of the body
 * @throws Thrown when `signal` aborts, or when the message closes before it completed
 *   (the peer disconnected); the error's `cause` carries the message's own error
 *
 * @example
 * ```ts
 * import { readChunk } from '@orkestrel/router/server'
 * import http from 'node:http'
 *
 * const server = http.createServer(async (message, response) => {
 * 	const chunk = await readChunk(message, AbortSignal.timeout(1000))
 * 	response.end(String(chunk?.byteLength ?? 0))
 * })
 * ```
 */
export async function readChunk(
	message: IncomingMessage,
	signal: AbortSignal,
): Promise<Uint8Array | undefined> {
	signal.throwIfAborted()
	const chunk: unknown = message.read()
	if (chunk instanceof Uint8Array) return chunk
	if (chunk !== null)
		throw new ContractError('a request body chunk must be bytes', {
			code: 'literal',
			context: { path: ['message'], limit: 'a message with no encoding', received: preview(chunk) },
		})
	if (message.complete) return undefined
	if (message.destroyed)
		throw new Error('request body closed before it completed', { cause: message.errored })
	const wait = createAbort({ signal })
	// Either outcome only ends the wait: the next call reads the abort, the close, or the chunk.
	await Promise.race([
		once(message, 'readable', { signal: wait.signal }),
		once(message, 'close', { signal: wait.signal }),
	]).then(
		() => wait.abort(),
		() => wait.abort(),
	)
	return readChunk(message, signal)
}

/**
 * Discards the unread rest of a `node:http` request body in place, leaving the connection reusable.
 *
 * @remarks
 * Aborts `discard` first, which ends a pending {@link readChunk} wait and removes its
 * `readable` listener, and only then resumes the message, so Node reads the rest of
 * the body off the socket and drops it. A `readable` listener still attached at the
 * resume would keep the message paused and stall the connection.
 *
 * @param message - The raw `node:http` request
 * @param discard - The controller whose signal every {@link readChunk} call on `message` waits under
 *
 * @example
 * ```ts
 * import { discardBody } from '@orkestrel/router/server'
 * import http from 'node:http'
 *
 * const server = http.createServer((message, response) => {
 * 	discardBody(message, new AbortController())
 * 	response.end('ignored the body')
 * })
 * ```
 */
export function discardBody(message: IncomingMessage, discard: AbortController): void {
	discard.abort()
	message.resume()
}

/**
 * Builds a fetch-standard `Request` from a `node:http` `IncomingMessage` — the
 * server-adapter half of the fetch/node conversion seam.
 *
 * @remarks
 * - `method` is carried over verbatim (defaulting to `GET` when absent).
 * - The URL comes from {@link buildURL}, which refuses a malformed target or `Host`
 *   by throwing, before any listener is attached.
 * - Every request header is copied; multi-value headers are joined per fetch
 *   semantics (`', '`-joined), except `set-cookie`, whose values are each
 *   appended individually.
 * - For a method that carries a body (anything but `GET`/`HEAD`), the body is a
 *   pull-based `ReadableStream<Uint8Array>` with a high-water mark of 0: it reads the
 *   message only when its reader reads, through {@link readChunk}, so an unread body
 *   holds no more than the message's own buffer whatever the upload size. A cancel
 *   discards the remainder in place, leaving the connection reusable, and so does the
 *   `finish` of `options.response`.
 * - A fresh `@orkestrel/abort` handle backs `request.signal`. It aborts when the peer
 *   disconnects: the message closes before it completed, or `options.response`
 *   closes before it ended. It also aborts when `options.signal` aborts, and on
 *   nothing else.
 *
 * @param message - The raw `node:http` request
 * @param options - Optional `origin` override, paired `response`, and linked `signal`
 *   ({@link RequestOptions})
 * @returns A fetch `Request` over the message
 * @throws {@link ContractError} Thrown when {@link buildURL} refuses the target or the
 *   `Host` header; a `TypeError` when fetch refuses the method
 *
 * @example
 * ```ts
 * import { buildRequest } from '@orkestrel/router/server'
 * import http from 'node:http'
 *
 * const server = http.createServer((incoming, response) => {
 * 	const request = buildRequest(incoming, { response })
 * 	response.end(`${request.method} ${request.url}`)
 * })
 * ```
 */
export function buildRequest(message: IncomingMessage, options?: RequestOptions): Request {
	const url = buildURL(message, options?.origin)
	const method = message.method ?? 'GET'

	const headers = new Headers()
	for (const [name, value] of Object.entries(message.headers)) {
		if (value === undefined) continue
		if (name === 'set-cookie') {
			for (const cookie of isArray(value) ? value : [value]) headers.append(name, cookie)
			continue
		}
		headers.set(name, isArray(value) ? value.join(', ') : value)
	}

	const parent = options?.signal
	const abort = createAbort(parent === undefined ? undefined : { signal: parent })
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

	const init: RequestInit = { method, headers, signal: abort.signal }
	if (method === 'GET' || method === 'HEAD') return new Request(url, init)

	const discard = new AbortController()
	if (response !== undefined) response.once('finish', () => discardBody(message, discard))
	const body = new ReadableStream<Uint8Array>(
		{
			pull: async (controller) => {
				const chunk = await readChunk(message, discard.signal)
				if (chunk === undefined) controller.close()
				else controller.enqueue(chunk)
			},
			cancel: () => discardBody(message, discard),
		},
		{ highWaterMark: 0 },
	)
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
 * instead of collapsing into one comma-joined header), then pipes the body to
 * `target` through `Readable.fromWeb`, which honors backpressure and ends `target`
 * when the body completes; every listener it adds to `target` is removed when the
 * exchange ends. A `null` body ends `target` with no further writes. A
 * response to a `HEAD` request, and a 1xx, 204, or 304 response, carries no body on
 * the wire (RFC 9112 section 6.3), so its body is cancelled unread and `target` ends.
 * When the peer closes first, the body is cancelled, even while it waits for its
 * next chunk, and the promise resolves. When Node refuses a header or the body
 * fails, `target` is destroyed, so the client reads an aborted response rather
 * than a complete one, and the promise rejects.
 *
 * @param response - The fetch `Response` to write
 * @param target - The `node:http` response to write it to
 * @returns A promise that resolves when `target` finished or the peer closed
 * @throws Thrown when Node refuses a header, the body fails, or the body is no unlocked
 *   `ReadableStream` (a {@link ContractError}), after `target` is destroyed
 *
 * @example
 * ```ts
 * import { sendResponse } from '@orkestrel/router/server'
 * import http from 'node:http'
 *
 * const server = http.createServer(async (_incoming, target) => {
 * 	await sendResponse(new Response('ok'), target)
 * })
 * ```
 */
export async function sendResponse(response: Response, target: ServerResponse): Promise<void> {
	const body = response.body
	const status = response.status
	const bodiless = target.req.method === 'HEAD' || status < 200 || status === 204 || status === 304
	const source =
		body instanceof WebReadableStream && !bodiless && !body.locked
			? Readable.fromWeb(body)
			: undefined
	try {
		target.statusCode = status
		target.statusMessage = response.statusText
		for (const [name, value] of response.headers) {
			if (name === 'set-cookie') continue
			target.setHeader(name, value)
		}
		const cookies = response.headers.getSetCookie()
		if (cookies.length > 0) target.setHeader('set-cookie', cookies)
		if (body !== null && !(body instanceof WebReadableStream && (bodiless || source !== undefined)))
			throw new ContractError('a response body must be an unlocked ReadableStream', {
				code: 'placement',
				context: {
					path: ['response', 'body'],
					limit: 'unlocked ReadableStream',
					received: preview(body),
				},
			})
		if (body !== null && bodiless) await body.cancel()
		if (source === undefined) await finished(target.end(), { cleanup: true })
		else {
			source.once('error', (error) => target.destroy(error))
			source.pipe(target)
			// One `finish` and one `close` wait, removed when either settles; `pipeline` and
			// `finished` leave or double their listeners on a `ServerResponse`.
			const wait = new AbortController()
			await Promise.race([
				once(target, 'finish', { signal: wait.signal }),
				once(target, 'close', { signal: wait.signal }),
			]).finally(() => wait.abort())
			if (!target.writableFinished && source.errored !== null) throw source.errored
			if (!target.writableFinished) source.destroy()
		}
	} catch (error) {
		const failure: unknown = source?.errored ?? error
		source?.destroy()
		if (isError(failure) && 'code' in failure && failure.code === 'ERR_STREAM_PREMATURE_CLOSE')
			return
		target.destroy()
		if (body instanceof WebReadableStream && !body.locked) await body.cancel(failure)
		throw failure
	}
}
