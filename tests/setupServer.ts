import type { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { RecorderInterface } from '@orkestrel/test'
import type { DispatcherInterface } from '@src/core'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { TLSSocket } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { attempt } from '@orkestrel/contract'
import { requireValue, resolveRoot, waitForCondition, waitForDelay } from '@orkestrel/test'
import { createLoopback, readErrorCode } from '@orkestrel/test/server'
import { createDispatcher } from '@src/core'
import { buildRequest, sendResponse } from '@src/server'
import { createTestBody } from './setup.js'

// ── Server-only setup (the scoped test-project setup and no-mocks rules) ─────
//
// Loaded after `setup.ts` for the `src:server` test project. Holds `node:*`
// helpers for the server face's real-socket tests (no mocks — a real
// `node:http` server on an ephemeral port, closed by every caller), and the
// tables of the HTTP conformance matrix in `tests/src/server/integration.test.ts`.

/** Names the workspace root, anchored from this setup file's own location. */
export const WORKSPACE_ROOT = fileURLToPath(resolveRoot(import.meta))

/** Represents a running test server bound to an ephemeral port, with its base `url` and a `close` teardown. */
export interface TestServerInterface {
	readonly url: string
	readonly port: number
	close(): Promise<void>
}

/** Represents a paused real HTTP response and the request/server resources that own it. */
export interface PausedResponseInterface {
	readonly server: TestServerInterface
	readonly request: http.ClientRequest
	readonly response: IncomingMessage
}

/** Records listener totals at the `sendResponse` backpressure race seams. */
export interface ResponseListenerSnapshot {
	readonly drain: number
	readonly close: number
	readonly error: number
}

/** Represents one HTTP/1.1 response the raw client framed off the wire. */
export interface RawResponse {
	readonly status: number
	readonly headers: Readonly<Record<string, string>>
	readonly body: string
	/** True when the framing reached its end: the whole `Content-Length`, or the last chunk. */
	readonly complete: boolean
}

/** Represents a response body the raw client framed, and where its framing stopped. */
export interface FramedBody {
	readonly body: string
	readonly complete: boolean
	readonly end: number
}

/** Represents one row of the request-target and `Host` tables of the conformance matrix. */
export interface TargetCase {
	readonly name: string
	/** Holds the raw request bytes both arms are fed. */
	readonly request: string
	/** Holds the target a bare `node:http` server delivers, or `undefined` where Node answers 400 itself. */
	readonly target: string | undefined
	/** Holds the `Host` value a bare `node:http` server delivers. */
	readonly host: string | undefined
	/** Holds the `RequestOptions.origin` the adapter arm passes. */
	readonly origin: string | undefined
	/** Holds the URL the adapter must build, or `undefined` where it must refuse. */
	readonly url: string | undefined
}

/** Represents the status and body one arm answers a target row with. */
export interface TargetAnswer {
	readonly status: number
	readonly body: string
}

/** Represents what the bare control and the adapter must each answer for one target row. */
export interface TargetAnswers {
	readonly control: TargetAnswer
	readonly adapter: TargetAnswer
}

/** Represents the listener count per counted event on one emitter. */
export type ListenerCounts = Readonly<Record<string, number>>

/** Represents one step of the listener trace: its name and the counts on the message and the response. */
export interface ListenerStep {
	readonly step: string
	readonly message: ListenerCounts
	readonly response: ListenerCounts
}

/** Represents the per-request state the exchange dispatcher threads into its handlers. */
export interface ExchangeState {
	readonly requestId: string
}

/** Represents one row of the dispatch table driven through the three-call composition. */
export interface DispatchCase {
	readonly name: string
	readonly method: string
	readonly path: string
	readonly status: number
	readonly allow: boolean
	/** Holds the `x-custom` header value the route's response carries onto the wire. */
	readonly custom: string | undefined
	readonly body: string
}

/** Lists the request-target rows: the target form decides the URL (row S1). */
export const TARGET_CASES: readonly TargetCase[] = Object.freeze([
	{
		name: 'a plain origin-form path (control)',
		request: 'GET /plain/path HTTP/1.1\r\nHost: app.local\r\n\r\n',
		target: '/plain/path',
		host: 'app.local',
		origin: undefined,
		url: 'http://app.local/plain/path',
	},
	{
		name: 'an origin-form path opening with two slashes',
		request: 'GET //evil.example/admin HTTP/1.1\r\nHost: app.local\r\n\r\n',
		target: '//evil.example/admin',
		host: 'app.local',
		origin: undefined,
		url: 'http://app.local//evil.example/admin',
	},
	{
		name: 'an http absolute-form target',
		request: 'GET http://other.example/admin HTTP/1.1\r\nHost: app.local\r\n\r\n',
		target: 'http://other.example/admin',
		host: 'app.local',
		origin: undefined,
		url: 'http://other.example/admin',
	},
	{
		name: 'an absolute-form target with an upper-case scheme and host',
		request: 'GET HTTP://Other.Example/admin HTTP/1.1\r\nHost: app.local\r\n\r\n',
		target: 'HTTP://Other.Example/admin',
		host: 'app.local',
		origin: undefined,
		url: 'http://other.example/admin',
	},
	{
		name: 'an https absolute-form target with a port and a query',
		request: 'GET https://other.example:8443/admin?q=1 HTTP/1.1\r\nHost: app.local\r\n\r\n',
		target: 'https://other.example:8443/admin?q=1',
		host: 'app.local',
		origin: undefined,
		url: 'https://other.example:8443/admin?q=1',
	},
	{
		name: 'an absolute-form target that the origin option does not override',
		request: 'GET http://other.example/admin HTTP/1.1\r\nHost: app.local\r\n\r\n',
		target: 'http://other.example/admin',
		host: 'app.local',
		origin: 'https://api.example.com',
		url: 'http://other.example/admin',
	},
	{
		name: 'the asterisk form',
		request: 'OPTIONS * HTTP/1.1\r\nHost: app.local\r\n\r\n',
		target: '*',
		host: 'app.local',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'an absolute-form target with an ftp scheme',
		request: 'GET ftp://other.example/x HTTP/1.1\r\nHost: app.local\r\n\r\n',
		target: 'ftp://other.example/x',
		host: 'app.local',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'an absolute-form target carrying userinfo',
		request: 'GET http://user:pass@other.example/admin HTTP/1.1\r\nHost: app.local\r\n\r\n',
		target: 'http://user:pass@other.example/admin',
		host: 'app.local',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'an absolute-form target with an empty authority',
		request: 'GET http:///admin HTTP/1.1\r\nHost: app.local\r\n\r\n',
		target: 'http:///admin',
		host: 'app.local',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'an authority with no scheme, which Node answers itself',
		request: 'GET evil.example/admin HTTP/1.1\r\nHost: app.local\r\n\r\n',
		target: undefined,
		host: undefined,
		origin: undefined,
		url: undefined,
	},
	{
		name: 'an absolute-form target over HTTP/1.0 with no Host (control)',
		request: 'GET http://other.example/admin HTTP/1.0\r\n\r\n',
		target: 'http://other.example/admin',
		host: undefined,
		origin: undefined,
		url: 'http://other.example/admin',
	},
	{
		name: 'an absolute-form target beside a malformed Host',
		request: 'GET http://other.example/admin HTTP/1.1\r\nHost: user@app.local\r\n\r\n',
		target: 'http://other.example/admin',
		host: 'user@app.local',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'an absolute-form target beside two Host field lines',
		request: 'GET http://other.example/admin HTTP/1.1\r\nHost: a.local\r\nHost: b.local\r\n\r\n',
		target: 'http://other.example/admin',
		host: 'a.local',
		origin: undefined,
		url: undefined,
	},
])

/** Lists the `Host` rows: a host with an optional port, overridden by the origin option (row 2). */
export const HOST_CASES: readonly TargetCase[] = Object.freeze([
	{
		name: 'a valid Host (control)',
		request: 'GET /path HTTP/1.1\r\nHost: app.local\r\n\r\n',
		target: '/path',
		host: 'app.local',
		origin: undefined,
		url: 'http://app.local/path',
	},
	{
		name: 'a Host with a port',
		request: 'GET /path HTTP/1.1\r\nHost: app.local:8080\r\n\r\n',
		target: '/path',
		host: 'app.local:8080',
		origin: undefined,
		url: 'http://app.local:8080/path',
	},
	{
		name: 'an IPv6 literal Host with a port',
		request: 'GET /path HTTP/1.1\r\nHost: [::1]:8080\r\n\r\n',
		target: '/path',
		host: '[::1]:8080',
		origin: undefined,
		url: 'http://[::1]:8080/path',
	},
	{
		name: 'an IPv4 Host',
		request: 'GET /path HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
		target: '/path',
		host: '127.0.0.1',
		origin: undefined,
		url: 'http://127.0.0.1/path',
	},
	{
		name: 'an HTTP/1.0 request with no Host',
		request: 'GET /path HTTP/1.0\r\n\r\n',
		target: '/path',
		host: undefined,
		origin: undefined,
		url: 'http://localhost/path',
	},
	{
		name: 'a Host carrying a path',
		request: 'GET /path HTTP/1.1\r\nHost: app.local/admin\r\n\r\n',
		target: '/path',
		host: 'app.local/admin',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'a Host carrying a backslash path',
		request: 'GET /path HTTP/1.1\r\nHost: app.local\\admin\r\n\r\n',
		target: '/path',
		host: 'app.local\\admin',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'a Host carrying userinfo',
		request: 'GET /path HTTP/1.1\r\nHost: user@app.local\r\n\r\n',
		target: '/path',
		host: 'user@app.local',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'a Host carrying a space',
		request: 'GET /path HTTP/1.1\r\nHost: app local\r\n\r\n',
		target: '/path',
		host: 'app local',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'a Host with an out-of-range port',
		request: 'GET /path HTTP/1.1\r\nHost: app.local:65536\r\n\r\n',
		target: '/path',
		host: 'app.local:65536',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'a Host carrying a query',
		request: 'GET /path HTTP/1.1\r\nHost: app.local?x\r\n\r\n',
		target: '/path',
		host: 'app.local?x',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'a Host carrying a fragment',
		request: 'GET /path HTTP/1.1\r\nHost: app.local#x\r\n\r\n',
		target: '/path',
		host: 'app.local#x',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'an empty Host',
		request: 'GET /path HTTP/1.1\r\nHost:\r\n\r\n',
		target: '/path',
		host: '',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'a valid Host the origin option overrides',
		request: 'GET /path HTTP/1.1\r\nHost: app.local\r\n\r\n',
		target: '/path',
		host: 'app.local',
		origin: 'https://api.example.com',
		url: 'https://api.example.com/path',
	},
	{
		name: 'a malformed Host beside the origin option',
		request: 'GET /path HTTP/1.1\r\nHost: user@app.local\r\n\r\n',
		target: '/path',
		host: 'user@app.local',
		origin: 'https://api.example.com',
		url: undefined,
	},
	{
		name: 'two Host field lines',
		request: 'GET /path HTTP/1.1\r\nHost: a.local\r\nHost: b.local\r\n\r\n',
		target: '/path',
		host: 'a.local',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'one Host value on two field lines',
		request: 'GET /path HTTP/1.1\r\nHost: a.local\r\nHost: a.local\r\n\r\n',
		target: '/path',
		host: 'a.local',
		origin: undefined,
		url: undefined,
	},
	{
		name: 'two Host field lines beside the origin option',
		request: 'GET /path HTTP/1.1\r\nHost: a.local\r\nHost: b.local\r\n\r\n',
		target: '/path',
		host: 'a.local',
		origin: 'https://api.example.com',
		url: undefined,
	},
])

/** Lists the upload sizes the unread-body row reads `socket.bytesRead` at (row S6). */
export const UPLOAD_SIZES: readonly number[] = Object.freeze([4 * 1024 * 1024, 32 * 1024 * 1024])

/** Holds how many 1 KiB chunks the body a `HEAD` request is answered with offers. */
export const HEAD_BODY_COUNT = 10_000

/** Holds a `HEAD` request and a `GET` after it on one connection. */
export const HEAD_REQUESTS =
	'HEAD / HTTP/1.1\r\nHost: app.local\r\n\r\nGET /second HTTP/1.1\r\nHost: app.local\r\n\r\n'

/** Lists the events whose listeners the listener row counts on the message and the response. */
export const LISTENER_EVENTS: readonly string[] = Object.freeze([
	'close',
	'error',
	'end',
	'aborted',
])

/**
 * Holds the most listeners the adapter may add for one event to the message or the response at any step of one exchange.
 *
 * @remarks
 * Written 2026-11-16 before the row ran: one `close` per exchange on each side, plus the
 * one `close` and the `error` listeners a pending chunk read or a body pipe holds while
 * it runs. A count that grows with the chunk count breaks it.
 */
export const LISTENER_BOUND = 3

/** Holds how many keep-alive requests the warning row sends. */
export const WARNING_REQUESTS = 1000

/** Holds the request calls the retention row reads per arm. */
export const RETENTION_CALLS = 20_000

/**
 * Holds the bytes per call a run-lived option signal may keep for closed exchanges.
 *
 * @remarks
 * Read 2026-11-16 on Node v22.23.5 through `measureRetention`, 8 rounds per tree on
 * `af49292` and on R2b: the no-signal noise read −0.4 to 0.0 B per call, and one run-lived
 * signal read 385.0 to 1,425.5 B per call. The bound sits 20 times above the noise spread
 * and 48 times below the smallest defect reading.
 */
export const RETENTION_BOUND = 8

/** Holds one chunk of the paced upload the cancel rows send (row X2). */
export const UPLOAD_CHUNK: Uint8Array = new Uint8Array(16 * 1024).fill(98)

/** Holds how many chunks the paced upload sends. */
export const UPLOAD_COUNT = 30

/** Holds the request head of the paced upload the cancel rows send. */
export const UPLOAD_HEAD = `POST /upload HTTP/1.1\r\nHost: app.local\r\nContent-Length: ${UPLOAD_CHUNK.byteLength * UPLOAD_COUNT}\r\n\r\n`

/** Holds the request the cancel rows send on the same connection after the upload. */
export const SECOND_REQUEST = 'GET /second HTTP/1.1\r\nHost: app.local\r\n\r\n'

/** Holds the plain request the response rows send. */
export const ROOT_REQUEST = 'GET / HTTP/1.1\r\nHost: app.local\r\n\r\n'

/** Holds a response header value that fetch admits and Node refuses (a control character). */
export const REFUSED_HEADER: readonly [name: string, value: string] = Object.freeze([
	'x-trace',
	'a\u0001b',
])

/** Lists the transport rows the three-call composition answers. */
export const DISPATCH_CASES: readonly DispatchCase[] = Object.freeze([
	{
		name: 'a matched GET route with a param and per-request state',
		method: 'GET',
		path: '/users/7',
		status: 200,
		allow: false,
		custom: undefined,
		body: '{"id":"7","requestId":"/users/7"}',
	},
	{
		name: 'an unmatched pathname',
		method: 'GET',
		path: '/nowhere',
		status: 404,
		allow: false,
		custom: undefined,
		body: 'Not Found',
	},
	{
		name: 'a path matched on a different method',
		method: 'POST',
		path: '/health',
		status: 405,
		allow: true,
		custom: undefined,
		body: 'Method Not Allowed',
	},
	{
		name: 'an auto-HEAD against a GET route',
		method: 'HEAD',
		path: '/health',
		status: 200,
		allow: false,
		custom: 'yes',
		body: '',
	},
	{
		name: 'an auto-OPTIONS',
		method: 'OPTIONS',
		path: '/health',
		status: 204,
		allow: true,
		custom: undefined,
		body: '',
	},
	{
		name: 'a handler throw before headers, answered by the consumer boundary',
		method: 'GET',
		path: '/boom',
		status: 500,
		allow: false,
		custom: undefined,
		body: '',
	},
])

/**
 * Builds what each arm must answer for one target row, from the row's declared target and URL.
 *
 * @remarks
 * Where Node answers 400 itself, both arms read Node's empty 400. Otherwise the control
 * echoes the delivered target and `Host`, and the adapter answers the declared URL, or 400
 * with the `pattern` refusal code where the row declares no URL.
 *
 * @param row - The target or `Host` row
 * @returns The control's and the adapter's expected answers
 */
export function buildAnswers(row: TargetCase): TargetAnswers {
	if (row.target === undefined)
		return { control: { status: 400, body: '' }, adapter: { status: 400, body: '' } }
	const control = { status: 200, body: JSON.stringify({ target: row.target, host: row.host }) }
	if (row.url === undefined)
		return { control, adapter: { status: 400, body: JSON.stringify({ refused: 'pattern' }) } }
	return { control, adapter: { status: 200, body: JSON.stringify({ url: row.url }) } }
}

/**
 * Starts a real `node:http` server on an ephemeral port for a test.
 *
 * @remarks
 * Binds `listener` to `127.0.0.1:0` (OS-assigned free port) through
 * `createLoopback`, with `url`/`port` derived from the bound loopback and a
 * `close()` that tears the server down. Every caller MUST call `close()`
 * (typically in the test itself or an `afterEach`) to avoid leaking sockets
 * across tests.
 *
 * @param listener - The `node:http` request listener to serve
 * @param options - Optional native server settings for the real fixture
 * @returns A {@link TestServerInterface} bound and ready to receive requests
 *
 * @example
 * ```ts
 * import { startServer } from '../setupServer.js'
 *
 * const server = await startServer((_request, response) => response.end('ok'))
 * const response = await fetch(server.url)
 * await server.close()
 * ```
 */
export async function startServer(
	listener: http.RequestListener,
	options?: http.ServerOptions,
): Promise<TestServerInterface> {
	const server =
		options === undefined ? http.createServer(listener) : http.createServer(options, listener)
	const loopback = await createLoopback(server)
	return { url: loopback.url, port: loopback.port, close: () => loopback.destroy() }
}

/**
 * Requests a real fixture server response and pauses its client-side body.
 *
 * @param listener - The `node:http` request listener to serve
 * @param options - Optional native server settings for the real fixture
 * @returns The running server, client request, and paused incoming response
 */
export async function startPausedResponse(
	listener: http.RequestListener,
	options?: http.ServerOptions,
): Promise<PausedResponseInterface> {
	const server = await startServer(listener, options)
	const ready = Promise.withResolvers<IncomingMessage>()
	const request = http.get(server.url, (response) => {
		response.pause()
		ready.resolve(response)
	})
	request.once('error', ready.reject)
	try {
		return { server, request, response: await ready.promise }
	} catch (error) {
		request.destroy()
		await server.close()
		throw error
	}
}

/**
 * Counts listeners installed on the response events used by pressure waits.
 *
 * @param response - The real server response to inspect
 * @returns Current `drain`, `close`, and `error` listener totals
 */
export function countResponseListeners(response: ServerResponse): ResponseListenerSnapshot {
	return {
		drain: response.listenerCount('drain'),
		close: response.listenerCount('close'),
		error: response.listenerCount('error'),
	}
}

/** Receives a drain event without changing state. */
export function handleDrain(): void {}

/** Records a real request body and ends its response. */
export async function captureBody(
	request: IncomingMessage,
	response: ServerResponse,
	captured: RecorderInterface<[string]>,
): Promise<void> {
	const built = buildRequest(request)
	captured.handler(await built.text())
	response.end('ok')
}

/** Observes completion and failure of a real response send. */
export class ResponseSend {
	#settled = false
	#failure: unknown
	readonly #done = Promise.withResolvers<void>()

	get settled(): boolean {
		return this.#settled
	}

	get failure(): unknown {
		return this.#failure
	}

	get done(): Promise<void> {
		return this.#done.promise
	}

	async execute(response: Response, target: ServerResponse): Promise<void> {
		try {
			await sendResponse(response, target)
			this.#settled = true
		} catch (error) {
			this.#failure = error
		} finally {
			this.#done.resolve()
		}
	}
}

/** Collects a resumed response and releases its socket resources. */
export async function collectResponse(
	paused: PausedResponseInterface,
	target: ServerResponse,
	received: Promise<Buffer>,
	sent: Promise<void>,
): Promise<readonly [Buffer, ReturnType<typeof countResponseListeners>]> {
	try {
		paused.response.resume()
		const output = await received
		await sent
		return [output, countResponseListeners(target)]
	} finally {
		paused.response.destroy()
		paused.request.destroy()
		await paused.server.close()
	}
}

/**
 * Decodes a chunked body from raw response bytes, stopping where its framing stops.
 *
 * @remarks
 * The last chunk ends at the blank line after its trailer section, which may hold fields.
 *
 * @param bytes - The raw bytes the client read
 * @param offset - Where the next chunk-size line starts
 * @returns The decoded body, whether the last chunk arrived, and the offset after it
 */
export function decodeChunks(bytes: Buffer, offset: number): FramedBody {
	const line = bytes.indexOf('\r\n', offset)
	if (line < 0) return { body: '', complete: false, end: bytes.length }
	const size = Number.parseInt(bytes.subarray(offset, line).toString('latin1'), 16)
	if (size === 0) {
		const trailer = bytes.indexOf('\r\n\r\n', line)
		return trailer < 0
			? { body: '', complete: false, end: bytes.length }
			: { body: '', complete: true, end: trailer + 4 }
	}
	const data = line + 2 + size
	const part = bytes.subarray(line + 2, Math.min(data, bytes.length)).toString()
	if (bytes.length < data + 2) return { body: part, complete: false, end: bytes.length }
	const rest = decodeChunks(bytes, data + 2)
	return { body: part + rest.body, complete: rest.complete, end: rest.end }
}

/**
 * Frames HTTP/1.1 responses from the raw bytes a client read, by `Content-Length`, chunked, or close-delimited framing.
 *
 * @remarks
 * Frames each body by RFC 9112 section 6.3: a response to `HEAD`, and a 1xx, 204, or 304
 * response, ends at the blank line whatever its framing headers say; then chunked, then
 * `Content-Length`; any other response runs to the end of the connection, so it is
 * complete only after the connection closed. An interim 1xx response answers the same
 * request as the response after it. The last response is returned incomplete when its
 * framing has not ended.
 *
 * @param bytes - The raw bytes the client read
 * @param closed - If `true`, the connection closed after `bytes`; if `false`, it is open
 * @param methods - The request methods the responses answer, in order; a missing one reads as `GET`
 * @param offset - Where the next status line starts
 * @returns Each response, in wire order
 */
export function parseResponses(
	bytes: Buffer,
	closed: boolean,
	methods: readonly string[],
	offset = 0,
): readonly RawResponse[] {
	const head = bytes.indexOf('\r\n\r\n', offset)
	if (head < 0) return []
	const [line = '', ...fields] = bytes.subarray(offset, head).toString('latin1').split('\r\n')
	const status = Number(line.split(' ')[1])
	const headers = Object.fromEntries(
		fields.map((field) => {
			const colon = field.indexOf(':')
			return [field.slice(0, colon).trim().toLowerCase(), field.slice(colon + 1).trim()]
		}),
	)
	const start = head + 4
	const framed = frameBody(bytes, start, status, headers, closed, methods[0] === 'HEAD')
	const response = { status, headers, body: framed.body, complete: framed.complete }
	const rest = status < 200 ? methods : methods.slice(1)
	return framed.complete
		? [response, ...parseResponses(bytes, closed, rest, framed.end)]
		: [response]
}

/**
 * Frames one response body that starts at `start`, by the framing its status and headers declare.
 *
 * @param bytes - The raw bytes the client read
 * @param start - Where the body starts
 * @param status - The response status
 * @param headers - The response headers, keyed in lower case
 * @param closed - If `true`, the connection closed after `bytes`; if `false`, it is open
 * @param head - If `true`, the response answers a `HEAD` request; if `false`, any other method
 * @returns The body, whether its framing ended, and the offset after it
 */
export function frameBody(
	bytes: Buffer,
	start: number,
	status: number,
	headers: Readonly<Record<string, string>>,
	closed: boolean,
	head: boolean,
): FramedBody {
	if (head || status < 200 || status === 204 || status === 304)
		return { body: '', complete: true, end: start }
	if (headers['transfer-encoding'] === 'chunked') return decodeChunks(bytes, start)
	const length = headers['content-length']
	if (length !== undefined)
		return {
			body: bytes.subarray(start, start + Number(length)).toString(),
			complete: bytes.length >= start + Number(length),
			end: start + Number(length),
		}
	return { body: bytes.subarray(start).toString(), complete: closed, end: bytes.length }
}

/** Drives one raw TCP connection to a fixture server and frames what it reads. */
export class RawClient {
	readonly #socket: Socket
	readonly #methods: readonly string[]
	readonly #chunks: Buffer[] = []

	constructor(socket: Socket, methods: readonly string[]) {
		this.#socket = socket
		this.#methods = methods
		socket.on('data', (chunk: Buffer) => {
			this.#chunks.push(chunk)
		})
		socket.on('error', () => undefined)
	}

	/** Lists every response read so far, the last one incomplete while its framing is open. */
	get responses(): readonly RawResponse[] {
		return parseResponses(Buffer.concat(this.#chunks), this.closed, this.#methods)
	}

	/** Reports whether the connection closed. */
	get closed(): boolean {
		return this.#socket.closed
	}

	/** Writes raw request bytes. */
	write(data: string | Uint8Array): void {
		this.#socket.write(data)
	}

	/** Writes `count` copies of `chunk`, waiting `interval` milliseconds after each, while the socket is open. */
	async upload(chunk: Uint8Array, count: number, interval: number): Promise<void> {
		if (count === 0 || this.#socket.destroyed) return
		this.#socket.write(chunk)
		await waitForDelay(interval)
		await this.upload(chunk, count - 1, interval)
	}

	/** Waits until `count` complete responses arrived or the connection closed, then returns what it read. */
	async wait(count: number, description: string, budget = 2000): Promise<readonly RawResponse[]> {
		await waitForCondition(
			description,
			() => this.closed || this.responses.filter((response) => response.complete).length >= count,
			{ budget },
		)
		return this.responses
	}

	/** Closes the connection from the client side. */
	destroy(): void {
		this.#socket.destroy()
	}
}

/**
 * Opens a raw TCP connection to a fixture server on `127.0.0.1`.
 *
 * @param port - The fixture server's port
 * @param methods - The request methods the client sends, in order, which frame each response; a missing one reads as `GET`
 * @returns A connected {@link RawClient}
 */
export async function connectClient(
	port: number,
	methods: readonly string[] = [],
): Promise<RawClient> {
	const socket = net.connect(port, '127.0.0.1')
	await once(socket, 'connect')
	return new RawClient(socket, methods)
}

/**
 * Creates an unconnected `IncomingMessage` carrying a target and no header, for the conversion helpers.
 *
 * @remarks
 * Node derives `headers` and `headersDistinct` only from the lines its parser read, so a
 * message that must carry headers comes from {@link receiveMessage}.
 *
 * @param target - The request target, or `undefined` for a message with none
 * @param encrypted - If `true`, the message rides a TLS socket; if `false`, a plain socket
 * @returns The message, with nothing pushed into its body
 */
export function createMessage(target: string | undefined, encrypted: boolean): IncomingMessage {
	const message = new http.IncomingMessage(
		encrypted ? new TLSSocket(new net.Socket()) : new net.Socket(),
	)
	if (target !== undefined) message.url = target
	return message
}

/**
 * Feeds raw request bytes to a real `node:http` server and returns the message its parser built.
 *
 * @param request - The raw request bytes, a head with no body
 * @returns The parsed message, after its server and connection closed
 */
export async function receiveMessage(request: string): Promise<IncomingMessage> {
	const received = Promise.withResolvers<IncomingMessage>()
	const server = await startServer((message) => received.resolve(message))
	const client = await connectClient(server.port)
	try {
		client.write(request)
		return await received.promise
	} finally {
		client.destroy()
		await server.close()
	}
}

/**
 * Answers a `HEAD` request with a long body through `sendResponse`, and records how many
 * chunks the body had given when a zero-delay timer set beside the send fired; answers
 * any other request with `second`.
 *
 * @param message - The `HEAD` request, or the second request on the connection
 * @param response - Its response
 * @param readings - Records the pull count the timer read
 * @param send - Observes the send
 */
export async function answerHead(
	message: IncomingMessage,
	response: ServerResponse,
	readings: RecorderInterface<[pulls: number]>,
	send: ResponseSend,
): Promise<void> {
	if (message.method !== 'HEAD') {
		response.end('second')
		return
	}
	const source = createTestBody(new Uint8Array(1024).fill(99), HEAD_BODY_COUNT)
	setTimeout(() => readings.handler(source.pulls), 0)
	await send.execute(new Response(source.body), response)
}

/** Writes a body to a bare `HEAD` response, which Node drops, and answers any other request with `second`. */
export function answerBareHead(message: IncomingMessage, response: ServerResponse): void {
	if (message.method !== 'HEAD') {
		response.end('second')
		return
	}
	response.writeHead(200, { 'content-length': '7' })
	response.end('ignored')
}

/**
 * Returns the V8 collector, exposing it through `v8.setFlagsFromString` when the process started without it.
 *
 * @returns A function that runs a full collection
 */
export function readCollector(): () => void {
	setFlagsFromString('--expose-gc')
	const collect: unknown = runInNewContext('gc')
	if (typeof collect !== 'function') throw new Error('the V8 collector is not exposed')
	return () => void collect()
}

/**
 * Reads the heap bytes per `buildRequest` call that a run-lived signal alone keeps alive.
 *
 * @remarks
 * Builds `calls` requests whose messages complete and close while one run-lived signal
 * stays alive, reads the settled heap, lets the signal become unreachable, and reads the
 * settled heap again. The difference over `calls` is what the signal held for the closed
 * exchanges; the requests, messages, and bodies are garbage before either reading. With
 * `link` false the calls pass no signal, which reads the instrument's own noise.
 *
 * @param calls - The requests to build
 * @param link - If `true`, every call passes the run-lived signal as `RequestOptions.signal`; if `false`, none does
 * @returns The bytes per call freed when the signal became unreachable
 */
export async function measureRetention(calls: number, link: boolean): Promise<number> {
	const collect = readCollector()
	const held = await readHeldHeap(calls, link, collect)
	await settleHeap(collect)
	return (held - process.memoryUsage().heapUsed) / calls
}

/**
 * Builds `calls` closed requests beside one run-lived signal and reads the settled heap while that signal is alive.
 *
 * @param calls - The requests to build
 * @param link - If `true`, every call passes the signal; if `false`, none does
 * @param collect - The V8 collector
 * @returns The used heap bytes, read while the signal is still reachable
 */
export async function readHeldHeap(
	calls: number,
	link: boolean,
	collect: () => void,
): Promise<number> {
	const shutdown = new AbortController()
	buildClosedRequests(calls, link ? shutdown.signal : undefined)
	await settleHeap(collect)
	return shutdown.signal.aborted ? Number.NaN : process.memoryUsage().heapUsed
}

/**
 * Runs full collections with real turns between them, so closes, finalizers, and weak references settle.
 *
 * @param collect - The V8 collector
 */
export async function settleHeap(collect: () => void): Promise<void> {
	collect()
	await waitForDelay(10)
	collect()
	await waitForDelay(10)
	collect()
}

/**
 * Builds requests over unconnected messages that complete and are destroyed, so each one's exchange ends.
 *
 * @param count - The requests to build
 * @param signal - The `RequestOptions.signal` every call passes, or `undefined` for none
 */
export function buildClosedRequests(count: number, signal: AbortSignal | undefined): void {
	const socket = new net.Socket()
	Array.from({ length: count }).forEach(() => {
		const message = new http.IncomingMessage(socket)
		message.url = '/x'
		message.complete = true
		buildRequest(message, signal === undefined ? undefined : { signal })
		message.destroy()
	})
}

/**
 * Counts the listeners of each event in {@link LISTENER_EVENTS} on one emitter.
 *
 * @param emitter - The message or the response
 * @returns The count per event
 */
export function countListeners(emitter: EventEmitter): ListenerCounts {
	return Object.fromEntries(LISTENER_EVENTS.map((name) => [name, emitter.listenerCount(name)]))
}

/**
 * Subtracts the counts Node itself held at the handler's entry, leaving the adapter's share.
 *
 * @param counts - The counts at a later step
 * @param entry - The counts at the handler's entry
 * @returns The count per event the adapter added
 */
export function subtractListeners(counts: ListenerCounts, entry: ListenerCounts): ListenerCounts {
	return Object.fromEntries(
		LISTENER_EVENTS.map((name) => [name, (counts[name] ?? 0) - (entry[name] ?? 0)]),
	)
}

/**
 * Traces the listener counts on the message and the response through one upload exchange:
 * at entry, after `buildRequest`, after a full read (`/full`) or a cancel after one chunk
 * (`/cancel`), while a body is sent, and after the response closed. Answers any other
 * request with `second`.
 *
 * @param message - The upload request
 * @param response - Its response
 * @param steps - Records each step
 */
export async function traceUpload(
	message: IncomingMessage,
	response: ServerResponse,
	steps: RecorderInterface<[step: ListenerStep]>,
): Promise<void> {
	if (message.method !== 'POST') {
		response.end('second')
		return
	}
	steps.handler({
		step: 'entry',
		message: countListeners(message),
		response: countListeners(response),
	})
	const request = buildRequest(message, { response })
	steps.handler({
		step: 'built',
		message: countListeners(message),
		response: countListeners(response),
	})
	const reader = requireValue(request.body, 'an upload carries a body').getReader()
	if (message.url === '/cancel') {
		await reader.read()
		await reader.cancel('over the limit')
		steps.handler({
			step: 'cancelled',
			message: countListeners(message),
			response: countListeners(response),
		})
	} else {
		await readBytes(reader, Number.POSITIVE_INFINITY)
		steps.handler({
			step: 'read',
			message: countListeners(message),
			response: countListeners(response),
		})
	}
	const source = createTestBody(new Uint8Array(1024).fill(97), 64)
	const sending = sendResponse(new Response(source.body), response)
	steps.handler({
		step: 'sending',
		message: countListeners(message),
		response: countListeners(response),
	})
	await sending
	await waitForCondition('the response closes', () => response.closed)
	steps.handler({
		step: 'closed',
		message: countListeners(message),
		response: countListeners(response),
	})
}

/**
 * Answers a request through the three calls with a body, after adding the two `close` listeners a consuming server adds.
 *
 * @param message - The request
 * @param response - Its response
 */
export async function answerWithServerListeners(
	message: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	response.once('close', () => undefined)
	response.once('close', () => undefined)
	const request = buildRequest(message, { response })
	await request.arrayBuffer()
	await sendResponse(new Response(createTestBody(new Uint8Array(256).fill(97), 4).body), response)
}

/**
 * Sends `count` small POST requests one after another, reading each response whole, over fetch's keep-alive connections.
 *
 * @param url - The fixture server's URL
 * @param count - The requests left to send
 */
export async function postSequentially(url: string, count: number): Promise<void> {
	if (count <= 0) return
	await (await fetch(url, { method: 'POST', body: 'payload' })).arrayBuffer()
	await postSequentially(url, count - 1)
}

/** Answers with the target and `Host` a bare `node:http` server delivers, touching nothing else. */
export function answerTarget(message: IncomingMessage, response: ServerResponse): void {
	response.end(JSON.stringify({ target: message.url, host: message.headers.host }))
}

/** Answers with the URL `buildRequest` builds, or 400 with the refusal's code. */
export function answerRequest(
	message: IncomingMessage,
	response: ServerResponse,
	origin: string | undefined,
): void {
	const built = attempt(() =>
		buildRequest(message, origin === undefined ? { response } : { response, origin }),
	)
	if (built.success) response.end(JSON.stringify({ url: built.value.url }))
	else response.writeHead(400).end(JSON.stringify({ refused: readErrorCode(built.error) }))
}

/**
 * Holds an upload unread until the server socket stops reading it, then records `bytesRead`.
 *
 * @param message - The upload request, or the second request on the connection
 * @param response - Its response
 * @param readings - Records `bytesRead` and whether the request signal aborted
 * @param build - If `true`, builds the adapter's `Request` and leaves its body unread; if `false`, touches nothing
 */
export async function holdUpload(
	message: IncomingMessage,
	response: ServerResponse,
	readings: RecorderInterface<[bytes: number, aborted: boolean]>,
	build: boolean,
): Promise<void> {
	if (message.url === '/second') {
		response.end('second')
		return
	}
	const request = build ? buildRequest(message, { response }) : undefined
	const length = Number(message.headers['content-length'])
	await waitForCondition(
		'the server socket stops reading the upload',
		() => message.socket.isPaused() || message.socket.bytesRead >= length,
		{ budget: 5000 },
	)
	readings.handler(message.socket.bytesRead, request?.signal.aborted ?? false)
	response.writeHead(200, { 'content-length': '0' }).end()
}

/** Reads one chunk of an upload, cancels the body, and answers 413; answers the second request with 200. */
export async function cancelUpload(
	message: IncomingMessage,
	response: ServerResponse,
	requests: RecorderInterface<[Request]>,
): Promise<void> {
	if (message.url === '/second') {
		response.end('second')
		return
	}
	const request = buildRequest(message, { response })
	const reader = requireValue(request.body, 'an upload carries a body').getReader()
	await reader.read()
	await reader.cancel('over the limit')
	requests.handler(request)
	response.writeHead(413, { 'content-length': '0' }).end()
}

/**
 * Reads from a body reader until at least `count` bytes arrived or the body ended.
 *
 * @param reader - The body reader
 * @param count - The bytes left to read
 */
export async function readBytes(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	count: number,
): Promise<void> {
	if (count <= 0) return
	const { done, value } = await reader.read()
	if (done) return
	await readBytes(reader, count - value.byteLength)
}

/**
 * Reads the first upload chunk, cancels the body while its next read waits, and answers 413
 * only after the cancel alone drained the upload; answers the second request with 200.
 */
export async function cancelPendingUpload(
	message: IncomingMessage,
	response: ServerResponse,
	requests: RecorderInterface<[Request]>,
): Promise<void> {
	if (message.url === '/second') {
		response.end('second')
		return
	}
	const request = buildRequest(message, { response })
	const reader = requireValue(request.body, 'an upload carries a body').getReader()
	await readBytes(reader, UPLOAD_CHUNK.byteLength)
	const pending = reader.read()
	await reader.cancel('over the limit')
	await pending
	requests.handler(request)
	await waitForCondition('the cancel drains the upload', () => message.complete, { budget: 5000 })
	response.writeHead(413, { 'content-length': '0' }).end()
}

/** Reads one chunk of an upload and answers 200 without cancelling; answers the second request with 200. */
export async function abandonUpload(
	message: IncomingMessage,
	response: ServerResponse,
	requests: RecorderInterface<[Request]>,
): Promise<void> {
	if (message.url === '/second') {
		response.end('second')
		return
	}
	const request = buildRequest(message, { response })
	await requireValue(request.body, 'an upload carries a body').getReader().read()
	requests.handler(request)
	response.writeHead(200, { 'content-length': '0' }).end()
}

/** Reads one chunk of an upload, records the request, and never answers. */
export async function readUpload(
	message: IncomingMessage,
	response: ServerResponse,
	requests: RecorderInterface<[Request]>,
): Promise<void> {
	const request = buildRequest(message, { response })
	await requireValue(request.body, 'an upload carries a body').getReader().read()
	requests.handler(request)
}

/**
 * Creates a response body that sends `text`, then fails on its next pull.
 *
 * @param text - The text sent before the failure
 * @returns The failing body
 */
export function createFailingBody(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start: (controller) => controller.enqueue(new TextEncoder().encode(text)),
		pull: (controller) => controller.error(new Error('the body source failed')),
	})
}

/** Represents a response body that sends a head, then waits for a release while recording its cancel. */
export class IdleBody {
	readonly #gate = Promise.withResolvers<string>()
	readonly #cancels: RecorderInterface<[unknown]>
	readonly #body: ReadableStream<Uint8Array>

	constructor(head: string, cancels: RecorderInterface<[unknown]>) {
		this.#cancels = cancels
		const encoder = new TextEncoder()
		const gate = this.#gate.promise
		this.#body = new ReadableStream<Uint8Array>({
			start: (controller) => controller.enqueue(encoder.encode(head)),
			pull: async (controller) => {
				controller.enqueue(encoder.encode(await gate))
				controller.close()
			},
			cancel: (reason) => this.#cancels.handler(reason),
		})
	}

	get body(): ReadableStream<Uint8Array> {
		return this.#body
	}

	/** Sends `tail` and ends the body. */
	release(tail: string): void {
		this.#gate.resolve(tail)
	}
}

/** Answers with a partial body and then destroys the socket: the bare control for an aborted response. */
export function destroyResponse(_message: IncomingMessage, response: ServerResponse): void {
	response.write('partial')
	setImmediate(() => response.destroy())
}

/** Sets a header Node refuses on a bare response, recording the refusal, then answers 200. */
export function refuseHeader(
	_message: IncomingMessage,
	response: ServerResponse,
	refusals: RecorderInterface<[string | undefined]>,
): void {
	const [name, value] = REFUSED_HEADER
	const result = attempt(() => response.setHeader(name, value))
	refusals.handler(result.success ? undefined : readErrorCode(result.error))
	response.end('ok')
}

/**
 * Creates the dispatcher the transport rows run: a param route with state, a plain route, and a throwing route.
 *
 * @returns A dispatcher over the exchange routes
 */
export function createExchangeDispatcher(): DispatcherInterface<ExchangeState> {
	return createDispatcher<ExchangeState>({
		routes: [
			{
				method: 'GET',
				path: '/users/:id',
				handler: (_request, context) =>
					Response.json({ id: context.params.id, requestId: context.state.requestId }),
			},
			{
				method: 'GET',
				path: '/health',
				handler: () => Response.json({ ok: true }, { headers: { 'x-custom': 'yes' } }),
			},
			{
				method: 'GET',
				path: '/boom',
				handler: () => {
					throw new Error('the handler failed')
				},
			},
		],
	})
}

/**
 * Runs one exchange through the three-call composition the guide shows: `buildRequest`,
 * `Dispatcher.handle`, and `sendResponse`, with the consumer's own error policy.
 *
 * @param dispatcher - The dispatcher to run
 * @param state - The per-request state
 * @param message - The raw request
 * @param target - The raw response
 */
export async function handleExchange<TState>(
	dispatcher: DispatcherInterface<TState>,
	state: TState,
	message: IncomingMessage,
	target: ServerResponse,
): Promise<void> {
	try {
		const request = buildRequest(message, { response: target })
		const response = await dispatcher.handle(request, state)
		await sendResponse(response, target)
	} catch {
		if (!target.headersSent && !target.destroyed) target.writeHead(500).end()
	}
}
