// ============================================================================
//  Server request handlers — the §5 centralized home for the functions that
//  run one `node:http` exchange through a core `Dispatcher`, plus the listener
//  the whole server face hands to `http.createServer` (§5.3). Every function
//  is exported per AGENTS §5.
// ============================================================================

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DispatcherInterface } from '@src/core'
import type { ListenerFunction, StateFunction } from './types.js'
import { buildRequest, sendResponse } from './helpers.js'

/**
 * Handles one `node:http` request through a core dispatcher and writes its
 * fetch-standard response.
 *
 * @remarks
 * This is the named asynchronous orchestration behind {@link createListener}.
 * A rejected dispatch is treated only as a transport-level last resort: write
 * a bare `500` before headers, or destroy a response whose headers have
 * already started.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param dispatcher - The core dispatcher to run
 * @param state - Derives the consumer state from the incoming message
 * @param request - The raw `node:http` request
 * @param response - The raw `node:http` response
 * @returns A promise that settles after the response is written or closed
 *
 * @example
 * ```ts
 * const server = http.createServer((request, response) => {
 * 	void handleListenerRequest(dispatcher, () => undefined, request, response)
 * })
 * ```
 */
export async function handleListenerRequest<TState>(
	dispatcher: DispatcherInterface<TState>,
	state: StateFunction<TState>,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	try {
		const converted = buildRequest(request, { response })
		const result = await dispatcher.handle(converted, state(request))
		await sendResponse(result, response)
	} catch (error) {
		if (!response.headersSent && !response.destroyed) {
			response.writeHead(500)
			response.end()
		} else if (!response.destroyed) {
			response.destroy(error instanceof Error ? error : new Error(String(error)))
		}
	}
}

/**
 * Creates a `node:http` request listener over a core {@link DispatcherInterface} —
 * the whole server face's entry point (§5.3): converts the incoming message to
 * a fetch `Request`, hands it to the dispatcher with the consumer's per-request
 * `state`, and writes the resulting `Response` back.
 *
 * @remarks
 * A rejected `dispatcher.handle` (a route handler throw — the dispatcher
 * never invents an error boundary, §5.1) is this listener's transport-level
 * LAST RESORT, distinct from an application error boundary: when nothing has
 * been sent yet, it destroys the connection with a bare `500` head (never
 * leaking a hanging socket); once headers are already sent, it destroys the
 * connection outright. The router still owns no error POLICY — a consumer
 * that wants mapped error responses installs its own boundary around
 * `dispatcher.handle` (the future `@orkestrel/server` seam, §7).
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param dispatcher - The core dispatcher to run each converted request through
 * @param state - Derives the consumer's per-request `state` from the raw message
 * @returns A `(request, response) => void` listener, passable directly to
 *   `http.createServer`
 *
 * @example
 * ```ts
 * import { createListener } from '@src/server'
 * import { createDispatcher } from '@src/core'
 * import http from 'node:http'
 *
 * const dispatcher = createDispatcher()
 * dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
 * http.createServer(createListener(dispatcher, () => undefined)).listen(0)
 * ```
 */
export function createListener<TState>(
	dispatcher: DispatcherInterface<TState>,
	state: StateFunction<TState>,
): ListenerFunction {
	return (request, response) => {
		void handleListenerRequest(dispatcher, state, request, response)
	}
}
