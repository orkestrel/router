import { describe, expect, it } from 'vitest'
import { createDispatcher } from '../../../src/core/index.js'
import { createListener, handleListenerRequest } from '../../../src/server/handlers.js'
import { startServer } from '../../setupServer.js'

// The test mirror of `src/server/handlers.ts` — pins the transport boundary
// end-to-end through a real `Dispatcher` and a real `node:http` server: one
// handled exchange, and the listener's matched, unmatched, unmethoded,
// auto-HEAD, auto-OPTIONS, handler-throw, and per-request-state round-trips.

describe('handleListenerRequest', () => {
	it('converts, dispatches, and writes one request through the transport boundary', async () => {
		const dispatcher = createDispatcher<undefined>({
			routes: [{ method: 'GET', path: '/health', handler: () => new Response('ok') }],
		})
		const server = await startServer((request, response) => {
			void handleListenerRequest(dispatcher, () => undefined, request, response)
		})
		const response = await fetch(`${server.url}/health`)
		await server.close()

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('ok')
	})
})

describe('createListener', () => {
	it('round-trips a matched GET route through a real dispatcher and server', async () => {
		const dispatcher = createDispatcher<undefined>({
			routes: [
				{
					method: 'GET',
					path: '/users/:id',
					handler: (_r, c) => Response.json({ id: c.params.id }),
				},
			],
		})
		const server = await startServer(createListener(dispatcher, () => undefined))
		const response = await fetch(`${server.url}/users/7`)
		await server.close()

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ id: '7' })
	})

	it('responds 404 for an unmatched pathname', async () => {
		const dispatcher = createDispatcher<undefined>()
		const server = await startServer(createListener(dispatcher, () => undefined))
		const response = await fetch(`${server.url}/nowhere`)
		await server.close()

		expect(response.status).toBe(404)
	})

	it('responds 405 with an Allow header for a path matched on a different method', async () => {
		const dispatcher = createDispatcher<undefined>({
			routes: [{ method: 'GET', path: '/health', handler: () => new Response('ok') }],
		})
		const server = await startServer(createListener(dispatcher, () => undefined))
		const response = await fetch(`${server.url}/health`, { method: 'POST' })
		await server.close()

		expect(response.status).toBe(405)
		expect(response.headers.get('allow')).toContain('GET')
	})

	it('strips the body for an auto-HEAD request against a GET route', async () => {
		const dispatcher = createDispatcher<undefined>({
			routes: [
				{
					method: 'GET',
					path: '/health',
					handler: () => Response.json({ ok: true }, { headers: { 'x-custom': 'yes' } }),
				},
			],
		})
		const server = await startServer(createListener(dispatcher, () => undefined))
		const response = await fetch(`${server.url}/health`, { method: 'HEAD' })
		await server.close()

		expect(response.status).toBe(200)
		expect(response.headers.get('x-custom')).toBe('yes')
		expect(await response.text()).toBe('')
	})

	it('auto-answers OPTIONS with a 204 and a derived Allow header', async () => {
		const dispatcher = createDispatcher<undefined>({
			routes: [{ method: 'GET', path: '/health', handler: () => new Response('ok') }],
		})
		const server = await startServer(createListener(dispatcher, () => undefined))
		const response = await fetch(`${server.url}/health`, { method: 'OPTIONS' })
		await server.close()

		expect(response.status).toBe(204)
		expect(response.headers.get('allow')).toContain('GET')
	})

	it('destroys the connection with a bare 500 head when a handler throws before sending anything', async () => {
		const dispatcher = createDispatcher<undefined>({
			routes: [
				{
					method: 'GET',
					path: '/boom',
					handler: () => {
						throw new Error('handler exploded')
					},
				},
			],
		})
		const server = await startServer(createListener(dispatcher, () => undefined))
		const response = await fetch(`${server.url}/boom`)
		await server.close()

		expect(response.status).toBe(500)
	})

	it('threads a per-message state value into the route handler', async () => {
		const dispatcher = createDispatcher<{ readonly requestId: string }>({
			routes: [
				{
					method: 'GET',
					path: '/whoami',
					handler: (_r, c) => Response.json({ requestId: c.state.requestId }),
				},
			],
		})
		const server = await startServer(
			createListener(dispatcher, (message) => ({ requestId: message.url ?? '' })),
		)
		const response = await fetch(`${server.url}/whoami`)
		await server.close()

		expect(await response.json()).toEqual({ requestId: '/whoami' })
	})
})
