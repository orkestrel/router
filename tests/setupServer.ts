import type { IncomingMessage, ServerResponse } from 'node:http'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolveRoot } from '@orkestrel/test'
import { createLoopback } from '@orkestrel/test/server'

// ── Server-only setup (AGENTS §16.1 / §17.6) ─────────────────────────────────
//
// Loaded after `setup.ts` for the `src:server` test project. Holds `node:*`
// helpers for the server face's real-socket tests (§8/§16: no mocks — a real
// `node:http` server on an ephemeral port, closed by every caller).

/** The workspace root, anchored from this setup file's own location. */
export const WORKSPACE_ROOT = fileURLToPath(resolveRoot(import.meta))

/** A running test server bound to an ephemeral port, with its base `url` and a `close` teardown. */
export interface TestServerInterface {
	readonly url: string
	readonly port: number
	close(): Promise<void>
}

/** A paused real HTTP response and the request/server resources that own it. */
export interface PausedResponseInterface {
	readonly server: TestServerInterface
	readonly request: http.ClientRequest
	readonly response: IncomingMessage
}

/** Listener totals at the `sendResponse` backpressure race seams. */
export interface ResponseListenerSnapshot {
	readonly drain: number
	readonly close: number
	readonly error: number
}

/**
 * Start a real `node:http` server on an ephemeral port for a test.
 *
 * @remarks
 * Binds `listener` to `127.0.0.1:0` (OS-assigned free port) via
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
 * Request a real fixture server response and pause its client-side body.
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
 * Count listeners installed on the response events used by pressure waits.
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
