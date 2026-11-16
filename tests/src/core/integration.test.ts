import { once as waitFor } from 'node:events'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import { ContractError, isContractError } from '@orkestrel/contract'
import { captureError, collect, createRecorder } from '@orkestrel/test'
import { compilePath, createDispatcher, createRouter, encodePath, matchPath } from '@src/core'
import {
	ACCEPTED_PATHS,
	ENCODER_PAIRS,
	MATRIX_METHODS,
	MATRIX_TABLES,
	PATH_ENCODED,
	PATH_REFUSED,
	REFUSED_PATHS,
	buildEncoderSamples,
	buildMatrixOrders,
	buildMatrixRequests,
	buildTextRequests,
	CASE_ROWS,
	COST_PATHS,
	createMatrixHandler,
	describeRefusedPoints,
	dispatchReference,
	encodeReferencePath,
	filterDistinctPaths,
	measureDispatchCost,
	orderRoutes,
	parseReference,
	readMatrixOutcome,
	selectReference,
} from '../../setup.js'

// The router path matrix: `Router.match` and `Dispatcher.handle` against the reference grammar in
// `tests/setup.ts`, over every table, request form, method, case rule, and registration order.

describe('router path matrix — the encoder', () => {
	it('F1: writes each declared pair', () => {
		const drift = ENCODER_PAIRS.flatMap(([text, expected]) => {
			const actual = encodePath(text)
			return actual === expected ? [] : [{ text, expected, actual }]
		})
		expect(drift).toEqual([])
	})

	it('F2: agrees with the reference encoder over a seeded domain, never throws, and is idempotent', () => {
		const samples = buildEncoderSamples(20261116)
		const drift = samples.flatMap((text) => {
			const error = captureError(() => encodePath(text))
			if (error !== undefined)
				return [{ text, once: String(error), expected: '', twice: '', stray: [] }]
			const once = encodePath(text)
			const expected = encodeReferencePath(text)
			const stray = [...once].filter(
				(char) => PATH_ENCODED.includes(char) || char < ' ' || char > '~',
			)
			return once === expected && encodePath(once) === once && stray.length === 0
				? []
				: [{ text, once, expected, twice: encodePath(once), stray }]
		})
		expect(samples.length).toBeGreaterThan(0)
		expect(drift).toEqual([])
	})

	it('F6: the host rewrites exactly the refused code points beyond the encode set', () => {
		const ascii = Array.from({ length: 0x80 }, (_, code) => String.fromCharCode(code))
		const rewritten = ascii.filter((char) => {
			const url = new URL('http://x/')
			url.pathname = `/a${char}b`
			return encodePath(url.pathname) !== encodePath(`/a${char}b`)
		})
		expect(rewritten.toSorted()).toEqual([...PATH_REFUSED].toSorted())
	})
})

describe('router path matrix — Router.match', () => {
	it('F3: the host parses every URL-door request path back to itself', () => {
		const drift = MATRIX_TABLES.flatMap((table) =>
			buildMatrixRequests(table).flatMap((request) => {
				const pathname = new URL(`http://x${request.path}`).pathname
				return pathname === request.path ? [] : [{ path: request.path, pathname }]
			}),
		)
		expect(drift).toEqual([])
	})

	for (const table of MATRIX_TABLES) {
		const distinct = filterDistinctPaths(table.routes)
		const requests = [
			...buildMatrixRequests(table).map((request) => ({ ...request, door: 'url' })),
			...buildTextRequests(table).map((request) => ({ ...request, door: 'text' })),
		]
		for (const sensitive of [true, false]) {
			for (const order of buildMatrixOrders(distinct.length)) {
				it(`F3: answers the reference on ${table.label}, sensitive ${sensitive}, ${order.label}`, () => {
					const routes = orderRoutes(distinct, order.indices)
					const router = createRouter<string>({ sensitive })
					router.add(routes.map((route) => ({ path: route.path, meta: route.path })))
					const drift = requests.flatMap((request) => {
						const text =
							request.door === 'url' ? new URL(`http://x${request.path}`).pathname : request.path
						const match = selectReference(routes, request.path, sensitive)
						const expected =
							match === undefined ? undefined : { path: match.path, params: match.params }
						const hit = router.match(text)
						const actual =
							hit === undefined ? undefined : { path: hit.path, params: { ...hit.params } }
						return JSON.stringify(actual) === JSON.stringify(expected)
							? []
							: [{ door: request.door, form: request.form, text, expected, actual }]
					})
					expect(drift).toEqual([])
				})
			}
		}
	}
})

describe('router path matrix — registration order', () => {
	for (const table of MATRIX_TABLES) {
		const distinct = filterDistinctPaths(table.routes)
		const requests = buildMatrixRequests(table)
		for (const sensitive of [true, false]) {
			it(`picks one winner in every order unless the top two rank equal on ${table.label}, sensitive ${sensitive}`, () => {
				const routers = buildMatrixOrders(distinct.length).map((order) => {
					const routes = orderRoutes(distinct, order.indices)
					const router = createRouter<string>({ sensitive })
					router.add(routes.map((route) => ({ path: route.path, meta: route.path })))
					return { order, routes, router }
				})
				const drift = requests.flatMap((request) => {
					const tied = routers.some(
						({ routes }) => selectReference(routes, request.path, sensitive)?.tied === true,
					)
					const winners = new Set(routers.map(({ router }) => router.match(request.path)?.path))
					return tied || winners.size === 1 ? [] : [{ path: request.path, winners: [...winners] }]
				})
				expect(drift).toEqual([])
			})
		}
	}
})

describe('router path matrix — Dispatcher.handle', () => {
	for (const table of MATRIX_TABLES) {
		const requests = buildMatrixRequests(table)
		for (const sensitive of [true, false]) {
			for (const order of buildMatrixOrders(table.routes.length)) {
				it(`answers the reference on ${table.label}, sensitive ${sensitive}, ${order.label}`, async () => {
					const routes = orderRoutes(table.routes, order.indices)
					const cancels = createRecorder<readonly unknown[]>()
					const handler = createMatrixHandler(cancels)
					const dispatcher = createDispatcher({ sensitive })
					dispatcher.add(routes.map((route) => ({ ...route, handler })))
					const cells = requests.flatMap((request) =>
						MATRIX_METHODS.map((method) => ({ request, method })),
					)
					const drift = await cells.reduce<
						Promise<ReadonlyArray<{ readonly method: string; readonly path: string }>>
					>(async (previous, { request, method }) => {
						const earlier = await previous
						const expected = dispatchReference(routes, method, request.path, sensitive)
						const before = cancels.count
						const response = await dispatcher.handle(
							new Request(`http://x${request.path}`, { method }),
							undefined,
						)
						const actual = await readMatrixOutcome(response, cancels.count - before)
						return JSON.stringify(actual) === JSON.stringify(expected)
							? earlier
							: [...earlier, { method, path: request.path, expected, actual }]
					}, Promise.resolve([]))
					dispatcher.destroy()
					expect(drift).toEqual([])
				})
			}
		}
	}
})

describe('router path matrix — registration refusals', () => {
	it('refuses every refused shape at compilePath, Router.add, and Dispatcher.add', () => {
		const accepted = REFUSED_PATHS.filter((path) => {
			const router = createRouter<string>()
			const dispatcher = createDispatcher()
			const errors = [
				captureError(() => compilePath(path)),
				captureError(() => router.add({ path, meta: path })),
				captureError(() =>
					dispatcher.add({ method: 'GET', path, handler: () => new Response(null) }),
				),
			]
			return !errors.every((error) => isContractError(error))
		})
		expect(REFUSED_PATHS.filter((path) => parseReference(path) !== undefined)).toEqual([])
		expect(accepted).toEqual([])
	})

	it('accepts the neighbour of every refused shape', () => {
		expect(ACCEPTED_PATHS.filter((path) => parseReference(path) === undefined)).toEqual([])
		const router = createRouter<string>()
		expect(() => router.add(ACCEPTED_PATHS.map((path) => ({ path, meta: path })))).not.toThrow()
		expect(router.count).toBe(ACCEPTED_PATHS.length)
	})
})

describe('router path matrix — the declared path text', () => {
	it('F4: Router.entries and matchPath read raw path text', () => {
		const router = createRouter<string>()
		router.add({ path: '/café', meta: 'cafe' })
		expect(router.entries('/café').map((entry) => entry.path)).toEqual(['/café'])
		expect(matchPath(compilePath('/café'), '/café')).toEqual({})
		expect(matchPath(compilePath('/files/:name'), '/files/a b')).toEqual({ name: 'a b' })
	})

	it('F5: refuses `\\`, tab, line feed, and carriage return with code pattern at every door', () => {
		const refused = REFUSED_PATHS.filter((path) => describeRefusedPoints(path).length > 0)
		const drift = refused.flatMap((path) => {
			const compiled = captureError(() => compilePath(path))
			const routed = captureError(() => createRouter<string>().add({ path, meta: path }))
			const dispatched = captureError(() =>
				createDispatcher().add({ method: 'GET', path, handler: () => new Response(null) }),
			)
			const limit = isContractError(compiled) ? String(compiled.context?.limit) : ''
			const message = isContractError(compiled) ? compiled.message : ''
			const coded = [compiled, routed, dispatched].every(
				(error) => isContractError(error) && error.code === 'pattern',
			)
			const named = describeRefusedPoints(path).every((point) => limit.includes(point))
			const clean = ![...`${message}${limit}`].some((char) => char < ' ' || char === '\u007F')
			return coded && named && clean ? [] : [{ path, compiled: String(compiled), limit }]
		})
		expect(refused).toHaveLength(9)
		expect(drift).toEqual([])
	})

	it('F7: folds ASCII letters only under sensitive false', () => {
		const folded = createRouter<string>({ sensitive: false })
		const exact = createRouter<string>({ sensitive: true })
		folded.add({ path: '/café', meta: 'cafe' })
		exact.add({ path: '/café', meta: 'cafe' })
		const drift = CASE_ROWS.flatMap(([text, hitFolded, hitExact]) => {
			const actual = [folded.match(text) !== undefined, exact.match(text) !== undefined]
			return actual[0] === hitFolded && actual[1] === hitExact ? [] : [{ text, actual }]
		})
		expect(drift).toEqual([])
	})

	it('F8: answers `/^w` through a raw `^` and through `%5E`', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/^w', handler: () => new Response('caret') })
		const raw = await dispatcher.handle(new Request('http://x/^w'), undefined)
		const escaped = await dispatcher.handle(new Request('http://x/%5Ew'), undefined)
		const refused = await dispatcher.handle(
			new Request('http://x/%5Ew', { method: 'POST' }),
			undefined,
		)
		expect([raw.status, escaped.status, refused.status]).toEqual([200, 200, 405])
		dispatcher.destroy()
	})

	it('F10: keys one canonical pattern once, the later handler answering', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/café', handler: () => new Response('raw') })
		dispatcher.add({ method: 'GET', path: '/caf%C3%A9', handler: () => new Response('encoded') })
		const response = await dispatcher.handle(new Request('http://x/café'), undefined)
		expect(dispatcher.router.count).toBe(1)
		expect(await response.text()).toBe('encoded')
		dispatcher.destroy()
	})

	it('F11: a refused batch registers nothing at any door', () => {
		const good = { path: '/ok', meta: 'ok' }
		const bad = { path: '/a\\b', meta: 'bad' }
		const router = createRouter<string>()
		const grouped = createRouter<string>()
		const dispatcher = createDispatcher()
		const nested = createDispatcher()
		const errors = [
			captureError(() => router.add([good, bad])),
			captureError(() => grouped.group('/g').add([good, bad])),
			captureError(() =>
				dispatcher.add([
					{ method: 'GET', path: '/ok', handler: () => new Response('ok') },
					{ method: 'GET', path: '/a\\b', handler: () => new Response('ok') },
				]),
			),
			captureError(() =>
				nested.group('/g').add([
					{ method: 'GET', path: '/ok', handler: () => new Response('ok') },
					{ method: 'GET', path: '/a\\b', handler: () => new Response('ok') },
				]),
			),
		]
		expect(errors.every((error) => isContractError(error))).toBe(true)
		expect([router.count, grouped.count, dispatcher.router.count, nested.router.count]).toEqual([
			0, 0, 0, 0,
		])
		expect([router.match('/ok'), grouped.match('/g/ok')]).toEqual([undefined, undefined])
	})

	it('F13: ranks a suffix by its encoded length in every order', () => {
		const routes = [
			{ path: '/e/:aé', meta: 'accent' },
			{ path: '/e/:b%A9', meta: 'escape' },
		]
		const drift = [routes, routes.toReversed()].flatMap((order) => {
			const router = createRouter<string>()
			router.add(order)
			return ['/e/report%C3%A9', '/e/reporté'].flatMap((text) => {
				const hit = router.match(text)
				return hit?.path === '/e/:aé' && hit.params['a'] === 'report' ? [] : [{ text, hit }]
			})
		})
		expect(drift).toEqual([])
	})

	it('F14: keeps escapes as sent: no lowercase-hex hit when sensitive, and `%25` is not `%`', () => {
		const router = createRouter<string>()
		router.add([
			{ path: '/café', meta: 'cafe' },
			{ path: '/100%', meta: 'percent' },
		])
		expect(router.match('/caf%c3%a9')).toBeUndefined()
		expect(router.match('/100%25')).toBeUndefined()
		expect(router.match('/100%')?.meta).toBe('percent')
	})
})

describe('router path matrix — the encoder cost on untrusted text', () => {
	it('A1: costs a run of `^` within its canonical length of a run of `a`, and grows as the run does', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add(
			COST_PATHS.map((path) => ({
				method: 'GET' as const,
				path,
				handler: () => new Response('ok'),
			})),
		)
		const short = await measureDispatchCost(dispatcher, '^'.repeat(3000))
		const caret = await measureDispatchCost(dispatcher, '^'.repeat(12000))
		const letterShort = await measureDispatchCost(dispatcher, 'a'.repeat(3000))
		const letter = await measureDispatchCost(dispatcher, 'a'.repeat(12000))
		const again = await measureDispatchCost(dispatcher, 'a'.repeat(12000))
		const noise = Math.max(letter, again) / Math.min(letter, again)
		// Three canonical characters per `^`, each at most five `a`-run steps (scan, match, lookup, write).
		expect(caret / letter).toBeLessThan(3 * 5 * noise)
		expect(caret / short).toBeLessThan((2 * letter) / letterShort)
		dispatcher.destroy()
	})
})

describe('router path matrix — a `|` literal on Node', () => {
	it('A2: answers `/a|b` with 200 through Node fetch and a raw socket', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/a|b', handler: () => new Response('pipe') })
		const server = createServer((message, response) => {
			void dispatcher
				.handle(new Request(`http://127.0.0.1${message.url ?? '/'}`), undefined)
				.then((answer) => {
					response.writeHead(answer.status, { connection: 'close' })
					response.end()
				})
		})
		server.listen(0, '127.0.0.1')
		await waitFor(server, 'listening')
		const address = server.address()
		const port = typeof address === 'object' && address !== null ? address.port : 0
		const fetched = await fetch(`http://127.0.0.1:${port}/a|b`)
		const socket = connect(port, '127.0.0.1')
		await waitFor(socket, 'connect')
		socket.end('GET /a|b HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
		const raw = (await collect<Buffer>(socket)).map((chunk) => chunk.toString('latin1')).join('')
		server.close()
		await waitFor(server, 'close')
		expect([fetched.status, raw.split('\r\n')[0]]).toEqual([200, 'HTTP/1.1 200 OK'])
	})
})

describe('router path matrix — hand-declared rows', () => {
	it('W1: refuses a final `*name` carrying a suffix, and captures the bare `*name`', () => {
		expect(() => compilePath('/files/*rest.json')).toThrow(ContractError)
		const router = createRouter<string>()
		router.add({ path: '/files/*rest', meta: 'rest' })
		expect(router.match('/files/a.json')?.params).toEqual({ rest: 'a.json' })
	})

	it('W2: ranks `:name.json` above `:name` in both registration orders', () => {
		const forward = createRouter<string>()
		forward.add([
			{ path: '/files/:name', meta: 'plain' },
			{ path: '/files/:name.json', meta: 'json' },
		])
		const backward = createRouter<string>()
		backward.add([
			{ path: '/files/:name.json', meta: 'json' },
			{ path: '/files/:name', meta: 'plain' },
		])
		expect(forward.match('/files/report.json')).toEqual({
			path: '/files/:name.json',
			params: { name: 'report' },
			meta: 'json',
		})
		expect(backward.match('/files/report.json')).toEqual(forward.match('/files/report.json'))
		expect(forward.match('/files/report')?.meta).toBe('plain')
	})

	it('W2: gives a remaining tie to the earlier registration', () => {
		const router = createRouter<string>()
		router.add([
			{ path: '/t/:a.js', meta: 'first' },
			{ path: '/t/:b.js', meta: 'second' },
		])
		expect(router.match('/t/x.js')?.meta).toBe('first')
	})

	it('W3: refuses a param named for a prototype key, and keeps an ordinary name', () => {
		expect(() => compilePath('/x/:__proto__')).toThrow(ContractError)
		expect(() => compilePath('/x/:constructor')).toThrow(ContractError)
		const router = createRouter<string>()
		router.add({ path: '/x/:proto', meta: 'x' })
		expect(router.match('/x/value')?.params).toEqual({ proto: 'value' })
	})

	it('W4: refuses a duplicate param name', () => {
		expect(() => compilePath('/a/:id/b/:id')).toThrow(ContractError)
	})

	it('W5: matches a non-ASCII and a space literal through Dispatcher.handle and the encoded match input', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add([
			{ method: 'GET', path: '/café', handler: () => new Response('cafe') },
			{ method: 'GET', path: '/a b', handler: () => new Response('space') },
		])
		const cafe = await dispatcher.handle(new Request('http://x/café'), undefined)
		const space = await dispatcher.handle(new Request('http://x/a b'), undefined)
		expect([cafe.status, await cafe.text()]).toEqual([200, 'cafe'])
		expect([space.status, await space.text()]).toEqual([200, 'space'])
		expect(dispatcher.router.match('/caf%C3%A9')?.path).toBe('/café')
		dispatcher.destroy()
	})

	it('W6: keeps an encoded unreserved letter a miss against its literal', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/users', handler: () => new Response('users') })
		const encoded = await dispatcher.handle(new Request('http://x/us%65rs'), undefined)
		const plain = await dispatcher.handle(new Request('http://x/users'), undefined)
		expect([encoded.status, plain.status]).toEqual([404, 200])
		dispatcher.destroy()
	})

	it('W7: hands a decoded capture over as opaque text', () => {
		const router = createRouter<string>()
		router.add({ path: '/files/*rest', meta: 'files' })
		expect(router.match('/files/..%2F..%2Fetc%2Fpasswd')?.params).toEqual({
			rest: '../../etc/passwd',
		})
		expect(router.match('/files/a%00b')?.params).toEqual({ rest: 'a\u0000b' })
	})

	it('W9: carries OPTIONS in the Allow header of a 405', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/users', handler: () => new Response('ok') })
		const refused = await dispatcher.handle(
			new Request('http://x/users', { method: 'POST' }),
			undefined,
		)
		const options = await dispatcher.handle(
			new Request('http://x/users', { method: 'OPTIONS' }),
			undefined,
		)
		expect([refused.status, refused.headers.get('allow')]).toEqual([405, 'GET, HEAD, OPTIONS'])
		expect([options.status, options.headers.get('allow')]).toEqual([204, 'GET, HEAD, OPTIONS'])
		dispatcher.destroy()
	})

	it('W10: cancels the GET body behind an auto-HEAD answer', async () => {
		const cancels = createRecorder<readonly unknown[]>()
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/users', handler: createMatrixHandler(cancels) })
		const head = await dispatcher.handle(
			new Request('http://x/users', { method: 'HEAD' }),
			undefined,
		)
		expect(head.body).toBeNull()
		expect(cancels.count).toBe(1)
		const get = await dispatcher.handle(new Request('http://x/users'), undefined)
		expect(await get.json()).toEqual({ pattern: '/users', params: {} })
		expect(cancels.count).toBe(1)
		dispatcher.destroy()
	})
})
