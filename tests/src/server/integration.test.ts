import type { ListenerStep } from '../../setupServer.js'
import { describe, expect, it } from 'vitest'
import { EventEmitter, getEventListeners, once } from 'node:events'
import http from 'node:http'
import { createRecorder, requireValue, waitForCondition, waitForDelay } from '@orkestrel/test'
import { readErrorCode } from '@orkestrel/test/server'
import { createDispatcher } from '@src/core'
import { buildRequest, sendResponse } from '@src/server'
import {
	abandonUpload,
	answerBareHead,
	answerHead,
	answerJSON,
	answerRequest,
	answerTarget,
	answerWithServerListeners,
	buildAnswers,
	cancelPendingUpload,
	cancelUpload,
	connectClient,
	countConstructions,
	createExchangeDispatcher,
	createFailingBody,
	destroyResponse,
	DISPATCH_CASES,
	handleExchange,
	HEAD_REQUESTS,
	holdUpload,
	HOST_CASES,
	IdleBody,
	JSON_EXCHANGES,
	LISTENER_BOUND,
	LISTENER_EVENTS,
	postSequentially,
	readAbortErrorClass,
	readUpload,
	refuseHeader,
	REFUSED_HEADER,
	ResponseSend,
	ROOT_REQUEST,
	SECOND_REQUEST,
	startServer,
	subtractListeners,
	TARGET_CASES,
	traceUpload,
	UPLOAD_CHUNK,
	UPLOAD_COUNT,
	UPLOAD_HEAD,
	UPLOAD_SIZES,
	WARNING_REQUESTS,
} from '../../setupServer.js'

// The HTTP conformance matrix of the node adapter: every row feeds the same bytes to a bare
// `node:http` control and to the adapter, and reads each expectation from the control, the
// raw client's own framing parse, or the fixture's knowledge of whether it disconnected.

for (const [title, rows] of [
	['row S1: the target form decides the URL', TARGET_CASES],
	[
		'row 2: a malformed or repeated Host is refused, and the origin option replaces Host in the URL',
		HOST_CASES,
	],
] as const) {
	describe(`${title}`, () => {
		for (const row of rows) {
			it(`${row.name}`, async () => {
				const control = await startServer(answerTarget)
				const adapter = await startServer((message, response) =>
					answerRequest(message, response, row.origin),
				)
				try {
					const bare = await connectClient(control.port)
					bare.write(row.request)
					const [controlAnswer] = await bare.wait(1, `the control answers ${row.name}`)
					bare.destroy()
					const client = await connectClient(adapter.port)
					client.write(row.request)
					const [adapterAnswer] = await client.wait(1, `the adapter answers ${row.name}`)
					client.destroy()

					const expected = buildAnswers(row)
					expect({ status: controlAnswer?.status, body: controlAnswer?.body }).toEqual(
						expected.control,
					)
					expect({ status: adapterAnswer?.status, body: adapterAnswer?.body }).toEqual(
						expected.adapter,
					)
				} finally {
					await control.close()
					await adapter.close()
				}
			})
		}
	})
}

describe('row S6: an unread body holds no more than the high-water mark', () => {
	it('reads the bare control bytesRead at both upload sizes, and serves a second request on the connection', async () => {
		const payloads: number[] = []
		const statuses: Array<readonly number[]> = []
		for (const build of [false, true]) {
			for (const size of UPLOAD_SIZES) {
				const readings = createRecorder<[bytes: number, aborted: boolean]>()
				const server = await startServer((message, response) => {
					void holdUpload(message, response, readings, build)
				})
				const client = await connectClient(server.port)
				try {
					const head = `POST /upload HTTP/1.1\r\nHost: app.local\r\nContent-Length: ${size}\r\n\r\n`
					client.write(head)
					client.write(new Uint8Array(size).fill(97))
					client.write(SECOND_REQUEST)
					const responses = await client.wait(
						2,
						'the upload and the second request are answered',
						15000,
					)
					const [reading] = requireValue(readings.calls[0], 'the server read the upload')
					payloads.push(reading - Buffer.byteLength(head))
					statuses.push(responses.map((response) => response.status))
					expect(readings.calls[0]?.[1]).toBe(false)
				} finally {
					client.destroy()
					await server.close()
				}
			}
		}
		const [controlSmall, controlLarge, adapterSmall, adapterLarge] = payloads
		const smallest = requireValue(UPLOAD_SIZES[0], 'an upload size')
		// The bare control's stall reading varies by a byte across upload sizes on some hosts.
		expect(requireValue(controlSmall, 'a control reading')).toBeLessThan(smallest)
		expect(requireValue(controlLarge, 'a control reading')).toBeLessThan(smallest)
		expect(adapterSmall).toBe(controlSmall)
		expect(adapterLarge).toBe(controlLarge)
		expect(statuses).toEqual([
			[200, 200],
			[200, 200],
			[200, 200],
			[200, 200],
		])
	}, 30000)
})

describe('row X2: a body cancel is no disconnect', () => {
	it('discards the remainder, answers 413, serves a second request, and never aborts the signal', async () => {
		const requests = createRecorder<[Request]>()
		const server = await startServer((message, response) => {
			void cancelUpload(message, response, requests)
		})
		const client = await connectClient(server.port)
		try {
			client.write(UPLOAD_HEAD)
			await client.upload(UPLOAD_CHUNK, UPLOAD_COUNT, 5)
			client.write(SECOND_REQUEST)
			const responses = await client.wait(2, 'the 413 and the second response arrive', 5000)
			const [request] = requireValue(requests.calls[0], 'the server cancelled the upload')

			expect(responses.map((response) => response.status)).toEqual([413, 200])
			expect(responses[1]?.body).toBe('second')
			expect(client.closed).toBe(false)
			expect(request.signal.aborted).toBe(false)
		} finally {
			client.destroy()
			await server.close()
		}
	})

	it('discards the remainder when the cancel lands while a read waits for the next chunk', async () => {
		const requests = createRecorder<[Request]>()
		const server = await startServer((message, response) => {
			void cancelPendingUpload(message, response, requests)
		})
		const client = await connectClient(server.port)
		try {
			client.write(UPLOAD_HEAD)
			client.write(UPLOAD_CHUNK)
			await waitForCondition(
				'the server cancels while the upload pauses',
				() => requests.count === 1,
			)
			await client.upload(UPLOAD_CHUNK, UPLOAD_COUNT - 1, 5)
			client.write(SECOND_REQUEST)
			const responses = await client.wait(2, 'the 413 and the second response arrive', 6000)
			const [request] = requireValue(requests.calls[0], 'the server cancelled the upload')

			expect(responses.map((response) => response.status)).toEqual([413, 200])
			expect(request.signal.aborted).toBe(false)
		} finally {
			client.destroy()
			await server.close()
		}
	}, 10000)

	it('discards an unfinished body after the response, so the connection serves a second request', async () => {
		const requests = createRecorder<[Request]>()
		const server = await startServer((message, response) => {
			void abandonUpload(message, response, requests)
		})
		const client = await connectClient(server.port)
		try {
			client.write(UPLOAD_HEAD)
			await client.upload(UPLOAD_CHUNK, UPLOAD_COUNT, 5)
			client.write(SECOND_REQUEST)
			const responses = await client.wait(2, 'both responses arrive', 5000)
			const [request] = requireValue(requests.calls[0], 'the server read the upload')

			expect(responses.map((response) => response.status)).toEqual([200, 200])
			expect(request.signal.aborted).toBe(false)
		} finally {
			client.destroy()
			await server.close()
		}
	})

	it('aborts the signal when the client disconnects mid-upload (control)', async () => {
		const requests = createRecorder<[Request]>()
		const server = await startServer((message, response) => {
			void readUpload(message, response, requests)
		})
		const client = await connectClient(server.port)
		try {
			client.write(UPLOAD_HEAD)
			client.write(UPLOAD_CHUNK)
			await waitForCondition('the server reads the first chunk', () => requests.count === 1)
			const [request] = requireValue(requests.calls[0], 'the server read the upload')
			expect(request.signal.aborted).toBe(false)
			client.destroy()
			await waitForCondition('the request signal aborts', () => request.signal.aborted)

			expect(String(request.signal.reason)).toContain('disconnected before')
		} finally {
			client.destroy()
			await server.close()
		}
	})
})

describe('row S3: a failing body reads as aborted', () => {
	it('reads a destroyed bare response as incomplete (instrument control)', async () => {
		const server = await startServer(destroyResponse)
		const client = await connectClient(server.port)
		try {
			client.write(ROOT_REQUEST)
			const [response] = await client.wait(1, 'the bare response is destroyed')

			expect(client.closed).toBe(true)
			expect(response?.body).toBe('partial')
			expect(response?.complete).toBe(false)
		} finally {
			await server.close()
		}
	})

	it('completes a healthy stream (control)', async () => {
		const send = new ResponseSend()
		const server = await startServer((_message, response) => {
			void send.execute(new Response('whole'), response)
		})
		const client = await connectClient(server.port)
		try {
			client.write(ROOT_REQUEST)
			const [response] = await client.wait(1, 'the healthy response completes')
			await send.done

			expect(response?.complete).toBe(true)
			expect(response?.body).toBe('whole')
			expect(send.settled).toBe(true)
			expect(send.failure).toBeUndefined()
		} finally {
			client.destroy()
			await server.close()
		}
	})

	it('destroys the target and rejects when the body source fails after the headers', async () => {
		const send = new ResponseSend()
		const server = await startServer((_message, response) => {
			void send.execute(new Response(createFailingBody('partial')), response)
		})
		const client = await connectClient(server.port)
		try {
			client.write(ROOT_REQUEST)
			const [response] = await client.wait(1, 'the failing response ends')
			await send.done

			expect(client.closed).toBe(true)
			expect(response?.status).toBe(200)
			expect(response?.body).toBe('partial')
			expect(response?.complete).toBe(false)
			expect(send.settled).toBe(false)
			expect(String(send.failure)).toContain('the body source failed')
		} finally {
			await server.close()
		}
	})

	it('reads the header Node refuses on a bare response (control)', async () => {
		const refusals = createRecorder<[string | undefined]>()
		const server = await startServer((message, response) =>
			refuseHeader(message, response, refusals),
		)
		try {
			await fetch(server.url)

			expect(refusals.calls).toEqual([['ERR_INVALID_CHAR']])
		} finally {
			await server.close()
		}
	})

	it('destroys the target and rejects when Node refuses a header', async () => {
		const send = new ResponseSend()
		const server = await startServer((_message, response) => {
			void send.execute(
				new Response('never', { headers: Object.fromEntries([REFUSED_HEADER]) }),
				response,
			)
		})
		const client = await connectClient(server.port)
		try {
			client.write(ROOT_REQUEST)
			const responses = await client.wait(1, 'the connection closes')
			await send.done

			expect(client.closed).toBe(true)
			expect(responses).toEqual([])
			expect(send.settled).toBe(false)
			expect(readErrorCode(send.failure)).toBe('ERR_INVALID_CHAR')
		} finally {
			await server.close()
		}
	})
})

describe('row L: the adapter holds a fixed few listeners per exchange and removes them when it ends', () => {
	for (const [path, count] of [
		['/full', UPLOAD_COUNT],
		['/full', UPLOAD_COUNT * 4],
		['/cancel', UPLOAD_COUNT],
	] as const) {
		it(`counts at most the bound at every step of a ${path} upload of ${count} chunks, and none after the response closed`, async () => {
			const steps = createRecorder<[step: ListenerStep]>()
			const server = await startServer((message, response) => {
				void traceUpload(message, response, steps)
			})
			const client = await connectClient(server.port)
			try {
				client.write(
					`POST ${path} HTTP/1.1\r\nHost: app.local\r\nContent-Length: ${UPLOAD_CHUNK.byteLength * count}\r\n\r\n`,
				)
				await client.upload(UPLOAD_CHUNK, count, 1)
				await waitForCondition('the trace reaches the closed response', () => steps.count === 5, {
					budget: 5000,
				})
				const [entry, ...rest] = steps.calls.map(([step]) => step)
				const first = requireValue(entry, 'the entry step')
				const shares = rest.map((step) => ({
					step: step.step,
					message: subtractListeners(step.message, first.message),
					response: subtractListeners(step.response, first.response),
				}))
				const over = shares.flatMap((share) =>
					LISTENER_EVENTS.flatMap((name) =>
						[share.message, share.response].some((counts) => (counts[name] ?? 0) > LISTENER_BOUND)
							? [`${share.step} ${name}`]
							: [],
					),
				)
				const closed = requireValue(shares.at(-1), 'the closed step')

				expect(over).toEqual([])
				expect(closed.step).toBe('closed')
				expect(closed.response).toEqual({
					close: 0,
					error: 0,
					end: 0,
					aborted: 0,
					readable: 0,
					finish: 0,
				})
			} finally {
				client.destroy()
				await server.close()
			}
		}, 10000)
	}

	it('prints no MaxListenersExceededWarning over many keep-alive requests beside a server that adds two close listeners', async () => {
		const warnings = createRecorder<[warning: Error]>()
		process.on('warning', warnings.handler)
		const server = await startServer((message, response) => {
			void answerWithServerListeners(message, response)
		})
		try {
			await postSequentially(server.url, WARNING_REQUESTS)
			await waitForDelay(10)

			expect(
				warnings.calls
					.map(([warning]) => warning.name)
					.filter((name) => name === 'MaxListenersExceededWarning'),
			).toEqual([])
		} finally {
			process.off('warning', warnings.handler)
			await server.close()
		}
	}, 30000)
})

describe('row W: the normal path builds no abort exception', () => {
	it('counts the DOMException a no-reason abort builds and the AbortError a losing wait builds (instrument control)', async () => {
		const AbortError = await readAbortErrorClass()
		const counts = await countConstructions({ DOMException, AbortError }, async () => {
			new AbortController().abort()
			await once(new EventEmitter(), 'never', { signal: AbortSignal.abort('stopped') }).catch(
				() => undefined,
			)
		})

		expect(counts).toEqual({ DOMException: 1, AbortError: 1 })
	})

	it('builds no DOMException and no AbortError across a GET and a POST with a JSON body read whole', async () => {
		const AbortError = await readAbortErrorClass()
		const sent = createRecorder<[method: string]>()
		const server = await startServer((message, response) => {
			void answerJSON(message, response, sent)
		})
		const client = await connectClient(server.port, ['GET', 'POST'])
		try {
			const counts = await countConstructions({ DOMException, AbortError }, async () => {
				for (const request of JSON_EXCHANGES) client.write(request)
				await client.wait(JSON_EXCHANGES.length, 'both exchanges are answered')
				await waitForCondition('both sends settle', () => sent.count === JSON_EXCHANGES.length)
			})

			expect(sent.calls).toEqual([['GET'], ['POST']])
			expect(client.responses.map((response) => [response.status, response.body])).toEqual([
				[200, '{"ok":true}'],
				[200, '{"items":["tent","stove"]}'],
			])
			expect(counts).toEqual({ DOMException: 0, AbortError: 0 })
		} finally {
			client.destroy()
			await server.close()
		}
	})
})

describe('row F5: a bodiless response cancels its body unread', () => {
	it('drops the body Node writes to a bare HEAD response, and frames the next response (control)', async () => {
		const server = await startServer(answerBareHead)
		const client = await connectClient(server.port, ['HEAD', 'GET'])
		try {
			client.write(HEAD_REQUESTS)
			const responses = await client.wait(2, 'the HEAD and the GET are answered')

			expect(
				responses.map((response) => [
					response.status,
					response.headers['content-length'],
					response.body,
				]),
			).toEqual([
				[200, '7', ''],
				[200, '6', 'second'],
			])
		} finally {
			client.destroy()
			await server.close()
		}
	})

	it('answers HEAD without pulling the body, so a timer set beside the send fires first', async () => {
		const readings = createRecorder<[pulls: number]>()
		const send = new ResponseSend()
		const server = await startServer((message, response) => {
			void answerHead(message, response, readings, send)
		})
		const client = await connectClient(server.port, ['HEAD', 'GET'])
		try {
			client.write(HEAD_REQUESTS)
			const responses = await client.wait(2, 'the HEAD and the GET are answered', 5000)
			await send.done
			await waitForCondition('the timer fires', () => readings.count === 1)
			const [pulls] = requireValue(readings.calls[0], 'the timer read the pulls')

			expect(responses.map((response) => [response.status, response.body])).toEqual([
				[200, ''],
				[200, 'second'],
			])
			expect(pulls).toBeLessThanOrEqual(1)
			expect(send.settled).toBe(true)
		} finally {
			client.destroy()
			await server.close()
		}
	}, 10000)
})

describe('row S4: an idle body cancels on disconnect', () => {
	it('cancels a body that waits for its next chunk when the client disconnects, and resolves', async () => {
		const cancels = createRecorder<[unknown]>()
		const idle = new IdleBody('head', cancels)
		const send = new ResponseSend()
		const server = await startServer((_message, response) => {
			void send.execute(new Response(idle.body), response)
		})
		const client = await connectClient(server.port)
		try {
			client.write(ROOT_REQUEST)
			await waitForCondition(
				'the client reads the head',
				() => client.responses[0]?.body === 'head',
			)
			client.destroy()
			await waitForCondition('the idle body is cancelled', () => cancels.count === 1)
			await send.done

			expect(send.settled).toBe(true)
			expect(send.failure).toBeUndefined()
		} finally {
			idle.release('late')
			await server.close()
		}
	})

	it('keeps the body while the client stays connected (control)', async () => {
		const cancels = createRecorder<[unknown]>()
		const idle = new IdleBody('head', cancels)
		const send = new ResponseSend()
		const server = await startServer((_message, response) => {
			void send.execute(new Response(idle.body), response)
		})
		const client = await connectClient(server.port)
		try {
			client.write(ROOT_REQUEST)
			await waitForCondition(
				'the client reads the head',
				() => client.responses[0]?.body === 'head',
			)
			await waitForDelay(100)
			expect(cancels.count).toBe(0)
			idle.release('tail')
			const [response] = await client.wait(1, 'the released body completes')
			await send.done

			expect(response?.body).toBe('headtail')
			expect(response?.complete).toBe(true)
			expect(send.settled).toBe(true)
		} finally {
			client.destroy()
			await server.close()
		}
	})
})

describe('row 7: the request signal aborts on a peer disconnect or on the option signal, and on nothing else', () => {
	it('aborts when the option signal aborts while the exchange is open, with its reason', async () => {
		const parent = new AbortController()
		const requests = createRecorder<[Request, http.ServerResponse]>()
		const server = await startServer((message, response) => {
			requests.handler(buildRequest(message, { response, signal: parent.signal }), response)
		})
		const client = await connectClient(server.port)
		try {
			client.write(ROOT_REQUEST)
			await waitForCondition('the server builds the request', () => requests.count === 1)
			const [request, response] = requireValue(requests.calls[0], 'the server built a request')
			const reason = new Error('the server is stopping')
			expect(request.signal.aborted).toBe(false)
			parent.abort(reason)
			response.end('ok')
			const [answer] = await client.wait(1, 'the response arrives')

			expect(request.signal.aborted).toBe(true)
			expect(request.signal.reason).toBe(reason)
			expect(answer?.body).toBe('ok')
			expect(getEventListeners(parent.signal, 'abort')).toEqual([])
		} finally {
			client.destroy()
			await server.close()
		}
	})

	it('leaves no listener on the option signal and does not abort after the exchange ends', async () => {
		const parent = new AbortController()
		const requests = createRecorder<[Request]>()
		const closed = Promise.withResolvers<void>()
		const server = await startServer((message, response) => {
			requests.handler(buildRequest(message, { response, signal: parent.signal }))
			response.once('close', () => closed.resolve())
			response.end('ok')
		})
		try {
			expect(await (await fetch(server.url)).text()).toBe('ok')
			await closed.promise
			const [request] = requireValue(requests.calls[0], 'the server built a request')
			const listeners = getEventListeners(parent.signal, 'abort')
			parent.abort('shutdown')

			expect(listeners).toEqual([])
			expect(request.signal.aborted).toBe(false)
		} finally {
			await server.close()
		}
	})

	it('is born aborted with the very reason object when the option signal already aborted', async () => {
		const stopped = AbortSignal.abort()
		const requests = createRecorder<[Request]>()
		const server = await startServer((message, response) => {
			requests.handler(buildRequest(message, { response, signal: stopped }))
			response.end('ok')
		})
		try {
			await fetch(server.url)
			const [request] = requireValue(requests.calls[0], 'the server built a request')

			expect(request.signal.aborted).toBe(true)
			expect(request.signal.reason).toBeInstanceOf(DOMException)
			expect(request.signal.reason).toBe(stopped.reason)
		} finally {
			await server.close()
		}
	})

	it('keeps its own disconnect reason when the client disconnects before the option signal aborts', async () => {
		const parent = new AbortController()
		const requests = createRecorder<[Request]>()
		const server = await startServer((message, response) => {
			requests.handler(buildRequest(message, { response, signal: parent.signal }))
		})
		const client = await connectClient(server.port)
		try {
			client.write('GET /stream HTTP/1.1\r\nHost: app.local\r\n\r\n')
			await waitForCondition('the server builds the request', () => requests.count === 1)
			const [request] = requireValue(requests.calls[0], 'the server built a request')
			client.destroy()
			await waitForCondition('the request signal aborts', () => request.signal.aborted)
			const reason: unknown = request.signal.reason
			const listeners = getEventListeners(parent.signal, 'abort')
			parent.abort(new Error('the server is stopping'))

			expect(request.signal.reason).toBe(reason)
			expect(String(reason)).toContain('disconnected before response completed')
			expect(listeners).toEqual([])
		} finally {
			await server.close()
		}
	})

	it('does not abort after a body read to its end and a finished response', async () => {
		const requests = createRecorder<[Request, string]>()
		const closed = Promise.withResolvers<void>()
		const server = await startServer(async (message, response) => {
			const request = buildRequest(message, { response })
			const text = await request.text()
			requests.handler(request, text)
			response.once('close', () => closed.resolve())
			response.end('ok')
		})
		try {
			await fetch(server.url, { method: 'POST', body: 'payload' })
			await closed.promise
			const [request, text] = requireValue(requests.calls[0], 'the server read the body')

			expect(text).toBe('payload')
			expect(request.signal.aborted).toBe(false)
		} finally {
			await server.close()
		}
	})

	it('aborts when the client disconnects after a complete request, before the response', async () => {
		const requests = createRecorder<[Request]>()
		const server = await startServer((message, response) => {
			requests.handler(buildRequest(message, { response }))
		})
		const client = await connectClient(server.port)
		try {
			client.write('GET /stream HTTP/1.1\r\nHost: app.local\r\n\r\n')
			await waitForCondition('the server builds the request', () => requests.count === 1)
			const [request] = requireValue(requests.calls[0], 'the server built a request')
			client.destroy()
			await waitForCondition('the request signal aborts', () => request.signal.aborted)

			expect(String(request.signal.reason)).toContain('disconnected before response completed')
		} finally {
			await server.close()
		}
	})
})

describe('row 8: the three-call composition replaces the listener', () => {
	it('publishes no listener from the server face', async () => {
		const face = await import('@src/server')

		expect(Object.keys(face)).not.toContain('createListener')
		expect(Object.keys(face)).not.toContain('handleListenerRequest')
	})

	for (const row of DISPATCH_CASES) {
		it(`${row.name}`, async () => {
			const dispatcher = createExchangeDispatcher()
			const server = await startServer((message, target) => {
				void handleExchange(dispatcher, { requestId: message.url ?? '' }, message, target)
			})
			try {
				const response = await fetch(`${server.url}${row.path}`, { method: row.method })

				expect(response.status).toBe(row.status)
				expect(response.headers.get('allow')?.includes('GET') ?? false).toBe(row.allow)
				expect(response.headers.get('x-custom') ?? undefined).toBe(row.custom)
				expect(await response.text()).toBe(row.body)
			} finally {
				await server.close()
				dispatcher.destroy()
			}
		})
	}

	it('serves the guide fence (Composing a server)', async () => {
		const dispatcher = createDispatcher<{ readonly requestId: string }>()
		dispatcher.add({
			method: 'GET',
			path: '/users/:id',
			handler: (_request, context) =>
				Response.json({ id: context.params.id, requestId: context.state.requestId }),
		})

		const server = http.createServer(async (message, target) => {
			try {
				const request = buildRequest(message, { response: target })
				const response = await dispatcher.handle(request, { requestId: crypto.randomUUID() })
				await sendResponse(response, target)
			} catch {
				if (!target.headersSent && !target.destroyed) target.writeHead(500).end() // this consumer's own error policy
			}
		})
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		try {
			const address = server.address()
			const port = typeof address === 'object' && address !== null ? address.port : 0
			const answer = await (await fetch(`http://127.0.0.1:${port}/users/7`)).json()

			expect(answer).toEqual({ id: '7', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
		} finally {
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
			dispatcher.destroy()
		}
	})
})
