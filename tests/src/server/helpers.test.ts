import type { ServerResponse } from 'node:http'
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { ContractError } from '@orkestrel/contract'
import { captureError, createRecorder, waitForCondition, waitForDelay } from '@orkestrel/test'
import { buildRequest, buildURL, discardBody, readChunk, sendResponse } from '@src/server'
import { createTestBody } from '../../setup.js'
import {
	captureBody,
	collectResponse,
	countResponseListeners,
	createMessage,
	ResponseSend,
	startPausedResponse,
	startServer,
} from '../../setupServer.js'

// The test mirror of `src/server/helpers.ts` — pins each conversion helper on its own:
// `buildURL` on real unconnected messages, `readChunk` on a paused message body, and
// `buildRequest` and `sendResponse` over REAL sockets (no mocks). The composed rows of the
// adapter's contract live in the conformance matrix, `integration.test.ts`.

describe('buildURL', () => {
	it('appends an origin-form target to the Host authority, keeping a leading double slash', () => {
		expect(buildURL(createMessage('/plain?x=1', { host: 'app.local' }, false)).href).toBe(
			'http://app.local/plain?x=1',
		)
		expect(buildURL(createMessage('//evil.example/admin', { host: 'app.local' }, false)).href).toBe(
			'http://app.local//evil.example/admin',
		)
	})

	it('derives https from an encrypted socket and localhost from an absent Host', () => {
		expect(buildURL(createMessage('/x', {}, true)).href).toBe('https://localhost/x')
	})

	it('appends an origin-form target to the WHATWG origin of the origin option, ignoring Host', () => {
		const message = createMessage('/health', { host: 'user@app.local' }, false)

		expect(buildURL(message, 'https://api.example.com/').href).toBe(
			'https://api.example.com/health',
		)
	})

	it('takes an http or https absolute-form target whole, without reading Host', () => {
		const message = createMessage('HTTPS://Other.Example:8443/a?b=1', { host: 'a b' }, false)

		expect(buildURL(message).href).toBe('https://other.example:8443/a?b=1')
	})

	it('refuses the asterisk form, another scheme, userinfo, an empty authority, and no target', () => {
		const refused = [
			'*',
			'ftp://other.example/x',
			'http://user@other.example/',
			'http:///admin',
			'',
		]
		const errors = refused.map((target) =>
			captureError(() => buildURL(createMessage(target, { host: 'app.local' }, false))),
		)
		const absent = captureError(() =>
			buildURL(createMessage(undefined, { host: 'app.local' }, false)),
		)

		for (const error of [...errors, absent]) {
			expect(error).toBeInstanceOf(ContractError)
			expect(error).toMatchObject({ code: 'pattern', context: { path: ['message', 'url'] } })
		}
	})

	it('refuses an origin-form target under a Host that is not a host with an optional port', () => {
		const error = captureError(() =>
			buildURL(createMessage('/x', { host: 'app.local/admin' }, false)),
		)

		expect(error).toBeInstanceOf(ContractError)
		expect(error).toMatchObject({
			code: 'pattern',
			context: { path: ['message', 'headers', 'host'], received: '"app.local/admin"' },
		})
	})
})

describe('readChunk', () => {
	it('returns a buffered chunk, then undefined after the message is complete and drained', async () => {
		const message = createMessage('/upload', {}, false)
		message.push(Buffer.from('ab'))
		const signal = new AbortController().signal

		const chunk = await readChunk(message, signal)
		expect(chunk === undefined ? undefined : Buffer.from(chunk).toString()).toBe('ab')
		message.complete = true
		message.push(null)
		expect(await readChunk(message, signal)).toBeUndefined()
	})

	it('waits for a chunk that arrives after the call', async () => {
		const message = createMessage('/upload', {}, false)
		const pending = readChunk(message, new AbortController().signal)
		message.push(Buffer.from('later'))
		const chunk = await pending

		expect(chunk === undefined ? undefined : Buffer.from(chunk).toString()).toBe('later')
	})

	it('throws when the message closes before it completed, while waiting or before the call', async () => {
		const message = createMessage('/upload', {}, false)
		const signal = new AbortController().signal
		const pending = readChunk(message, signal)
		message.destroy()

		await expect(pending).rejects.toThrow('request body closed before it completed')
		await expect(readChunk(message, signal)).rejects.toThrow(
			'request body closed before it completed',
		)
	})

	it('throws the abort reason when the signal aborts, while waiting or before the call', async () => {
		const message = createMessage('/upload', {}, false)
		const controller = new AbortController()
		const pending = readChunk(message, controller.signal)
		controller.abort(new Error('discarded'))

		await expect(pending).rejects.toThrow('discarded')
		await expect(readChunk(message, controller.signal)).rejects.toThrow('discarded')
		expect(message.listenerCount('readable')).toBe(0)
		expect(message.listenerCount('close')).toBe(0)
	})

	it('refuses a message that carries a text encoding', async () => {
		const message = createMessage('/upload', {}, false)
		message.setEncoding('utf8')
		message.push(Buffer.from('ab'))

		await expect(readChunk(message, new AbortController().signal)).rejects.toBeInstanceOf(
			ContractError,
		)
	})
})

describe('discardBody', () => {
	it('ends a pending read and leaves the message flowing, so Node drains the rest', async () => {
		const message = createMessage('/upload', {}, false)
		const discard = new AbortController()
		const pending = readChunk(message, discard.signal)
		discardBody(message, discard)

		await expect(pending).rejects.toThrow('This operation was aborted')
		await waitForCondition('the message flows', () => message.readableFlowing === true)
		message.push(Buffer.from('dropped'))
		await waitForCondition('the message drops the pushed bytes', () => message.readableLength === 0)
	})

	it('leaves the message paused when it resumes before the pending read ends (control)', async () => {
		const message = createMessage('/upload', {}, false)
		const discard = new AbortController()
		const pending = readChunk(message, discard.signal)
		message.resume()
		discard.abort()

		await expect(pending).rejects.toThrow('This operation was aborted')
		message.push(Buffer.from('kept'))
		await waitForDelay(10)
		expect(message.readableFlowing).not.toBe(true)
		expect(message.readableLength).toBe(4)
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
			void captureBody(request, response, captured)
		})
		await fetch(server.url, { method: 'POST', body: 'hello world' })
		await server.close()

		expect(captured.calls[0]).toEqual(['hello world'])
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
			void captureBody(request, response, captured)
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
		const entered = Promise.withResolvers<void>()
		const aborted = Promise.withResolvers<void>()
		const server = await startServer((incoming, response) => {
			const request = buildRequest(incoming)
			request.signal.addEventListener('abort', () => {
				recorder.handler(request.signal.reason)
				aborted.resolve()
			})
			// Never respond — the test disconnects before this handler would finish.
			void response
			entered.resolve()
		})
		const socket = net.connect(server.port, '127.0.0.1', () => {
			// Content-Length promises more body than is sent, then the socket is
			// destroyed before the message completes.
			socket.write('POST /x HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\npartial')
		})
		// Park on the server having read the partial message, then on the real abort — no fixed
		// delay, so the case measures the abort behaviour rather than host timing.
		await entered.promise
		socket.destroy()
		await aborted.promise
		await server.close()

		expect(recorder.count).toBe(1)
		const reason = recorder.calls[0]?.[0]
		expect(reason).toBeInstanceOf(Error)
		if (!(reason instanceof Error)) throw new Error('expected the incomplete request abort reason')
		expect(reason.message).toBe('request to /x disconnected before completion')
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

	it('throws before attaching any listener when the target is refused', () => {
		const message = createMessage('*', { host: 'app.local' }, false)

		expect(() => buildRequest(message)).toThrow(ContractError)
		expect(message.listenerCount('close')).toBe(0)
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
			const chunks: string[] = []
			socket.on('data', (chunk) => {
				chunks.push(chunk.toString())
			})
			socket.on('end', () => resolve(chunks.join('')))
		})
		await server.close()

		const cookieLines = raw
			.split('\r\n')
			.filter((line) => line.toLowerCase().startsWith('set-cookie:'))
			.map((line) => line.toLowerCase())
		expect(cookieLines).toEqual(['set-cookie: a=1', 'set-cookie: b=2'])
	})

	it('delivers byte-identical chunks', async () => {
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

	it('pauses body pulls under socket pressure and completes after drain, adding no listener per drain wait', async () => {
		const chunk = new Uint8Array(64 * 1024).fill(97)
		const count = 512
		const length = chunk.byteLength * count
		const send = new ResponseSend()
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
				void send.execute(
					new Response(source.body, { headers: { 'content-length': String(length) } }),
					response,
				)
			},
			{ highWaterMark: 1024 },
		)
		const { response: incoming } = paused
		const [target, baseline, source] = await targetReady.promise
		await waitForCondition(
			'the paused response is parked under pressure',
			() =>
				source.pulls > 2 &&
				countResponseListeners(target).drain - baseline.drain === 1 &&
				!send.settled,
		)
		const pressuredPulls = source.pulls
		const pressuredSettled = send.settled
		const pressured = countResponseListeners(target)
		const chunks: Buffer[] = []
		const received = Promise.withResolvers<Buffer>()
		incoming.on('data', (part: Buffer) => chunks.push(part))
		incoming.once('end', () => received.resolve(Buffer.concat(chunks)))
		incoming.once('error', received.reject)
		const [output, final] = await collectResponse(paused, target, received.promise, send.done)

		expect(pressuredPulls).toBeGreaterThan(2)
		expect(pressuredPulls).toBeLessThan(count)
		expect(pressuredSettled).toBe(false)
		expect(source.pulls).toBe(count)
		expect(send.settled).toBe(true)
		expect(send.failure).toBeUndefined()
		expect(final.drain).toBeLessThanOrEqual(pressured.drain)
		expect(final.close).toBeLessThanOrEqual(pressured.close)
		expect(final.error).toBeLessThanOrEqual(pressured.error)
		if (output === undefined) throw new Error('expected the complete pressured response body')
		expect(output.byteLength).toBe(length)
		expect(output.every((byte) => byte === 97)).toBe(true)
	}, 10000)

	it('resolves and cancels the body when the consumer disconnects under pressure', async () => {
		const chunk = new Uint8Array(64 * 1024).fill(97)
		const count = 512
		const send = new ResponseSend()
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
				void send.execute(new Response(source.body), response)
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
		await send.done

		expect(pressuredPulls).toBeGreaterThan(2)
		expect(source.pulls).toBeLessThan(count)
		expect(send.settled).toBe(true)
		expect(send.failure).toBeUndefined()
		const final = countResponseListeners(target)
		expect(final.drain).toBeLessThanOrEqual(pressured.drain)
		expect(final.close).toBeLessThanOrEqual(pressured.close)
		expect(final.error).toBeLessThanOrEqual(pressured.error)
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

	it('destroys the target and rejects for a body that is not a ReadableStream', async () => {
		const send = new ResponseSend()
		const destroyed = createRecorder<[boolean]>()
		const server = await startServer((_request, response) => {
			const foreign = Object.defineProperty(new Response(null), 'body', { value: {} })
			void send.execute(foreign, response).then(() => destroyed.handler(response.destroyed))
		})
		await expect(fetch(server.url)).rejects.toThrow('fetch failed')
		await send.done
		await server.close()

		expect(send.failure).toBeInstanceOf(ContractError)
		expect(send.failure).toMatchObject({ code: 'placement' })
		expect(destroyed.calls).toEqual([[true]])
	})
})
