import type { IncomingMessage, ServerResponse } from 'node:http'
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { createDispatcher } from '../../../src/core/index.js'
import { buildRequest, sendResponse } from '../../../src/server/helpers.js'
import { createListener } from '../../../src/server/handlers.js'
import { createRecorder, waitForCondition } from '@orkestrel/test'
import { createTestBody } from '../../setup.js'
import { countResponseListeners, startPausedResponse, startServer } from '../../setupServer.js'

// §16 mirror of `src/server/helpers.ts` — pins the conversion pair over REAL
// sockets (no mocks, §16): `buildRequest` fidelity, client-disconnect →
// `request.signal` abort, and `sendResponse` writing, including backpressure
// and a destroyed target.

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
		const call = captured.calls[0]
		if (call === undefined) throw new Error('expected one captured request')
		const [request] = call
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

		const request = captured.calls[0]?.[0]
		if (request === undefined) throw new Error('expected one captured request')
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

		const request = captured.calls[0]?.[0]
		if (request === undefined) throw new Error('expected one captured request')
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

		const request = captured.calls[0]?.[0]
		if (request === undefined) throw new Error('expected one captured request')
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

		const request = captured.calls[0]?.[0]
		if (request === undefined) throw new Error('expected one captured request')
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
		const reason = recorder.calls[0]?.[0]
		expect(reason).toBeInstanceOf(Error)
		if (!(reason instanceof Error)) throw new Error('expected the incomplete request abort reason')
		expect(reason.message).toBe('request to /x disconnected before completion')
	})

	it('aborts request.signal when a real client disconnects after sending a complete request', async () => {
		const entered = Promise.withResolvers<Request>()
		const completed = createRecorder<[boolean]>()
		const dispatcher = createDispatcher<IncomingMessage>({
			routes: [
				{
					method: 'POST',
					path: '/stream',
					handler: async (request, context) => {
						await request.text()
						completed.handler(context.state.complete)
						entered.resolve(request)
						await new Promise<void>((resolve) =>
							request.signal.addEventListener('abort', () => resolve(), { once: true }),
						)
						return new Response(null, { status: 204 })
					},
				},
			],
		})
		const server = await startServer(createListener(dispatcher, (message) => message))
		const socket = net.connect(server.port, '127.0.0.1', () => {
			socket.write('POST /stream HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\ndone')
		})
		const request = await entered.promise
		// The body was fully received before the client left, so ONLY the response-close
		// path can abort this signal — `!message.complete` is false and cannot fire.
		expect(completed.calls).toEqual([[true]])
		const aborted = new Promise<void>((resolve) =>
			request.signal.addEventListener('abort', () => resolve(), { once: true }),
		)
		socket.destroy()
		// Park on the real abort rather than asserting into the race: the response's own
		// `close` lands a turn after the socket dies.
		await aborted
		await server.close()

		expect(request.signal.aborted).toBe(true)
		const reason = request.signal.reason
		expect(reason).toBeInstanceOf(Error)
		if (!(reason instanceof Error)) throw new Error('expected the response disconnect abort reason')
		expect(reason.message).toBe('request to /stream disconnected before response completed')
	})

	it('does not abort or retain its response close listener after a normal response', async () => {
		const captured = createRecorder<[Request]>()
		const closed = Promise.withResolvers<number>()
		const server = await startServer((incoming, response) => {
			captured.handler(buildRequest(incoming, { response }))
			response.once('close', () => closed.resolve(response.listenerCount('close')))
			response.end('ok')
		})
		const response = await fetch(server.url)
		expect(await response.text()).toBe('ok')
		const listeners = await closed.promise
		await server.close()

		const request = captured.calls[0]?.[0]
		if (request === undefined) throw new Error('expected one captured request')
		expect(request.signal.aborted).toBe(false)
		expect(listeners).toBe(0)
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

	it('delivers byte-identical chunks on the fast path', async () => {
		const expected = Uint8Array.from([0, 1, 127, 128, 254, 255, 10, 13])
		const server = await startServer((_request, response) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(expected.slice(0, 3))
					controller.enqueue(expected.slice(3))
					controller.close()
				},
			})
			void sendResponse(new Response(body), response)
		})
		const response = await fetch(server.url)
		await server.close()

		expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected)
	})

	it('pauses body pulls under socket pressure, cleans each wait, and completes after drain', async () => {
		const chunk = new Uint8Array(64 * 1024).fill(97)
		const count = 512
		const length = chunk.byteLength * count
		let settled = false
		let failure: unknown
		const sent = Promise.withResolvers<void>()
		const targetReady =
			Promise.withResolvers<
				readonly [
					target: ServerResponse,
					baseline: ReturnType<typeof countResponseListeners>,
					source: ReturnType<typeof createTestBody>,
				]
			>()
		const paused = await startPausedResponse(
			(_request, response) => {
				const source = createTestBody(chunk, count)
				targetReady.resolve([response, countResponseListeners(response), source])
				void sendResponse(
					new Response(source.body, { headers: { 'content-length': String(length) } }),
					response,
				).then(
					() => {
						settled = true
						sent.resolve()
					},
					(error) => {
						failure = error
						sent.resolve()
					},
				)
			},
			{ highWaterMark: 1024 },
		)
		const { server, request, response: incoming } = paused
		const [target, baseline, source] = await targetReady.promise
		await waitForCondition(
			'the paused response is parked under pressure',
			() =>
				source.pulls > 2 && countResponseListeners(target).drain - baseline.drain === 1 && !settled,
		)
		const pressuredPulls = source.pulls
		const pressuredSettled = settled
		const pressured = countResponseListeners(target)
		const chunks: Buffer[] = []
		const received = Promise.withResolvers<Buffer>()
		incoming.on('data', (part: Buffer) => chunks.push(part))
		incoming.once('end', () => received.resolve(Buffer.concat(chunks)))
		incoming.once('error', received.reject)
		let output: Buffer | undefined
		let final = baseline
		try {
			incoming.resume()
			output = await received.promise
			await sent.promise
			final = countResponseListeners(target)
		} finally {
			incoming.destroy()
			request.destroy()
			await server.close()
		}

		expect(pressuredPulls).toBeGreaterThan(2)
		expect(pressuredPulls).toBeLessThan(count)
		expect(pressuredSettled).toBe(false)
		expect(pressured.drain - baseline.drain).toBe(1)
		expect(pressured.close - baseline.close).toBe(1)
		expect(pressured.error - baseline.error).toBe(2)
		expect(source.pulls).toBe(count)
		expect(settled).toBe(true)
		expect(failure).toBeUndefined()
		expect(final).toEqual(baseline)
		if (output === undefined) throw new Error('expected the complete pressured response body')
		expect(output.byteLength).toBe(length)
		expect(output.every((byte) => byte === 97)).toBe(true)
	}, 10000)

	it('settles and removes pressure listeners when the consumer disconnects before drain', async () => {
		const chunk = new Uint8Array(64 * 1024).fill(97)
		const count = 512
		let settled = false
		let failure: unknown
		const targetReady =
			Promise.withResolvers<
				readonly [
					target: ServerResponse,
					baseline: ReturnType<typeof countResponseListeners>,
					source: ReturnType<typeof createTestBody>,
				]
			>()
		const paused = await startPausedResponse(
			(_request, response) => {
				const source = createTestBody(chunk, count)
				targetReady.resolve([response, countResponseListeners(response), source])
				void sendResponse(new Response(source.body), response).then(
					() => {
						settled = true
					},
					(error) => {
						failure = error
					},
				)
			},
			{ highWaterMark: 1024 },
		)
		const { server, request, response: incoming } = paused
		const [target, baseline, source] = await targetReady.promise
		await waitForCondition(
			'the disconnected response is parked under pressure',
			() => source.pulls > 2 && countResponseListeners(target).drain - baseline.drain === 1,
		)
		const pressuredPulls = source.pulls
		const pressured = countResponseListeners(target)
		const closed = Promise.withResolvers<void>()
		incoming.once('close', () => closed.resolve())
		incoming.destroy()
		await closed.promise
		request.destroy()
		await server.close()
		await waitForCondition('the disconnected send settles', () => settled || failure !== undefined)

		expect(pressuredPulls).toBeGreaterThan(2)
		expect(pressuredPulls).toBeLessThan(count)
		expect(pressured.drain - baseline.drain).toBe(1)
		expect(pressured.close - baseline.close).toBe(1)
		expect(pressured.error - baseline.error).toBe(2)
		expect(settled).toBe(true)
		expect(failure).toBeUndefined()
		const final = countResponseListeners(target)
		expect(final.drain).toBeLessThanOrEqual(baseline.drain)
		expect(final.close).toBeLessThanOrEqual(baseline.close)
		expect(final.error).toBeLessThanOrEqual(baseline.error)
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
