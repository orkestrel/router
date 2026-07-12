import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { createDispatcher } from '../../../src/core/index.js'
import {
	createListener,
	isEncryptedSocket,
	buildRequest,
	sendResponse,
} from '../../../src/server/helpers.js'
import { createRecorder } from '../../setup.js'
import { startServer } from '../../setupServer.js'

// §16 mirror of `src/server/helpers.ts` — pins the whole node adapter over
// REAL sockets (no mocks, §16): `buildRequest` fidelity, client-disconnect →
// `request.signal` abort, `sendResponse` writing, and `createListener`
// end-to-end round-trips through a real `Dispatcher` + `node:http` server.

describe('isEncryptedSocket', () => {
	it('returns true for a value carrying a truthy encrypted property', () => {
		expect(isEncryptedSocket({ encrypted: true })).toBe(true)
	})

	it('returns false for a value with no encrypted property', () => {
		expect(isEncryptedSocket({})).toBe(false)
	})

	it('returns false for non-record values without throwing', () => {
		expect(isEncryptedSocket(null)).toBe(false)
		expect(isEncryptedSocket(undefined)).toBe(false)
		expect(isEncryptedSocket('socket')).toBe(false)
		expect(isEncryptedSocket(42)).toBe(false)
	})
})

describe('buildRequest', () => {
	it('carries the method, pathname, search, and headers over verbatim', async () => {
		const captured = createRecorder<[Request]>()
		const server = await startServer((request, response) => {
			captured.handler(buildRequest(request))
			response.end('ok')
		})
		await fetch(`${server.url}/users/7?x=1`, { headers: { 'X-Test': 'yes' } })
		await server.close()

		expect(captured.count).toBe(1)
		const [request] = captured.calls[0]
		expect(request.method).toBe('GET')
		const url = new URL(request.url)
		expect(url.pathname).toBe('/users/7')
		expect(url.search).toBe('?x=1')
		expect(request.headers.get('x-test')).toBe('yes')
	})

	it('has no body for a GET request', async () => {
		const captured = createRecorder<[Request]>()
		const server = await startServer((request, response) => {
			captured.handler(buildRequest(request))
			response.end('ok')
		})
		await fetch(server.url)
		await server.close()

		const [request] = captured.calls[0]
		expect(request.body).toBeNull()
	})

	it('streams a POST body into the Request so it can be read back whole', async () => {
		const captured = createRecorder<[string]>()
		const server = await startServer((request, response) => {
			void (async () => {
				const built = buildRequest(request)
				captured.handler(await built.text())
				response.end('ok')
			})()
		})
		await fetch(server.url, { method: 'POST', body: 'hello world' })
		await server.close()

		expect(captured.calls[0]).toEqual(['hello world'])
	})

	it('derives the origin host from the Host header, defaulting to localhost when absent', async () => {
		const captured = createRecorder<[Request]>()
		const server = await startServer((request, response) => {
			captured.handler(buildRequest(request))
			response.end('ok')
		})
		await new Promise<void>((resolve) => {
			const socket = net.connect(server.port, '127.0.0.1', () => {
				socket.write('GET /x HTTP/1.0\r\n\r\n')
			})
			socket.on('data', () => {
				socket.end()
				resolve()
			})
		})
		await server.close()

		const [request] = captured.calls[0]
		expect(new URL(request.url).host).toBe('localhost')
	})

	it('honors an explicit origin option over the derived scheme and host', async () => {
		const captured = createRecorder<[Request]>()
		const server = await startServer((request, response) => {
			captured.handler(buildRequest(request, { origin: 'https://api.example.com' }))
			response.end('ok')
		})
		await fetch(`${server.url}/health`)
		await server.close()

		const [request] = captured.calls[0]
		expect(new URL(request.url).origin).toBe('https://api.example.com')
		expect(new URL(request.url).pathname).toBe('/health')
	})

	it('appends each set-cookie value individually rather than joining them', async () => {
		const captured = createRecorder<[Request]>()
		const server = await startServer((request, response) => {
			captured.handler(buildRequest(request))
			response.end('ok')
		})
		await new Promise<void>((resolve) => {
			const socket = net.connect(server.port, '127.0.0.1', () => {
				socket.write(
					'GET /x HTTP/1.1\r\nHost: localhost\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n',
				)
			})
			socket.on('data', () => {
				socket.end()
				resolve()
			})
		})
		await server.close()

		const [request] = captured.calls[0]
		expect(request.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
	})

	it('streams a genuine Transfer-Encoding: chunked request body into the Request intact', async () => {
		const captured = createRecorder<[string]>()
		const server = await startServer((request, response) => {
			void (async () => {
				const built = buildRequest(request)
				captured.handler(await built.text())
				response.end('ok')
			})()
		})
		const body = 'hello chunked world'
		const first = body.slice(0, 5)
		const second = body.slice(5)
		await new Promise<void>((resolve) => {
			const socket = net.connect(server.port, '127.0.0.1', () => {
				socket.write(
					'POST /x HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n' +
						`${first.length.toString(16)}\r\n${first}\r\n` +
						`${second.length.toString(16)}\r\n${second}\r\n` +
						'0\r\n\r\n',
				)
			})
			socket.on('data', () => {
				socket.end()
				resolve()
			})
		})
		await server.close()

		expect(captured.calls[0]).toEqual([body])
	})

	it('aborts request.signal when the client disconnects before the message completes', async () => {
		const recorder = createRecorder<[unknown]>()
		const server = await startServer((incoming, response) => {
			const request = buildRequest(incoming)
			request.signal.addEventListener('abort', () => recorder.handler(request.signal.reason))
			// Never respond — the test disconnects before this handler would finish.
			void response
		})
		await new Promise<void>((resolve) => {
			const socket = net.connect(server.port, '127.0.0.1', () => {
				// Content-Length promises more body than is sent, then the socket is
				// destroyed before the message completes.
				socket.write('POST /x HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\npartial')
			})
			setTimeout(() => {
				socket.destroy()
				setTimeout(resolve, 50)
			}, 20)
		})
		await server.close()

		expect(recorder.count).toBe(1)
	})
})

describe('sendResponse', () => {
	it('writes the status and headers from the Response', async () => {
		const server = await startServer((_request, response) => {
			void sendResponse(new Response('ok', { status: 201, headers: { 'X-Test': 'yes' } }), response)
		})
		const response = await fetch(server.url)
		await server.close()

		expect(response.status).toBe(201)
		expect(response.headers.get('x-test')).toBe('yes')
		expect(await response.text()).toBe('ok')
	})

	it('writes multiple set-cookie headers distinctly', async () => {
		const server = await startServer((_request, response) => {
			const headers = new Headers()
			headers.append('set-cookie', 'a=1')
			headers.append('set-cookie', 'b=2')
			void sendResponse(new Response('ok', { headers }), response)
		})
		const raw = await new Promise<string>((resolve) => {
			const socket = net.connect(server.port, '127.0.0.1', () => {
				socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
			})
			let data = ''
			socket.on('data', (chunk) => {
				data += chunk.toString()
			})
			socket.on('end', () => resolve(data))
		})
		await server.close()

		const cookieLines = raw
			.split('\r\n')
			.filter((line) => line.toLowerCase().startsWith('set-cookie:'))
			.map((line) => line.toLowerCase())
		expect(cookieLines).toEqual(['set-cookie: a=1', 'set-cookie: b=2'])
	})

	it('streams a chunked body across multiple writes', async () => {
		const server = await startServer((_request, response) => {
			const body = new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(new TextEncoder().encode('chunk-1-'))
					await new Promise((resolve) => setTimeout(resolve, 5))
					controller.enqueue(new TextEncoder().encode('chunk-2'))
					controller.close()
				},
			})
			void sendResponse(new Response(body), response)
		})
		const response = await fetch(server.url)
		await server.close()

		expect(await response.text()).toBe('chunk-1-chunk-2')
	})

	it('stops cleanly without throwing when the target is destroyed mid-stream', async () => {
		let settled: 'resolved' | 'rejected' | undefined
		const server = await startServer((_request, response) => {
			const body = new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(new TextEncoder().encode('chunk-1-'))
					await new Promise((resolve) => setTimeout(resolve, 5))
					response.destroy()
					controller.enqueue(new TextEncoder().encode('chunk-2'))
					controller.close()
				},
			})
			void sendResponse(new Response(body), response).then(
				() => {
					settled = 'resolved'
				},
				() => {
					settled = 'rejected'
				},
			)
		})
		await new Promise<void>((resolve) => {
			const socket = net.connect(server.port, '127.0.0.1', () => {
				socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
			})
			socket.on('data', () => {})
			socket.on('close', () => resolve())
			socket.on('error', () => resolve())
			socket.setTimeout(200, () => {
				socket.destroy()
				resolve()
			})
		})
		await new Promise((resolve) => setTimeout(resolve, 30))
		await server.close()

		expect(settled).toBe('resolved')
	}, 10000)

	it('ends the target immediately for a null body', async () => {
		const server = await startServer((_request, response) => {
			void sendResponse(new Response(null, { status: 204 }), response)
		})
		const response = await fetch(server.url)
		await server.close()

		expect(response.status).toBe(204)
		expect(await response.text()).toBe('')
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
