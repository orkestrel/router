import { describe, expect, it } from 'vitest'
import { ContractError, isContractError } from '@orkestrel/contract'
import { captureError, createRecorder } from '@orkestrel/test'
import { compilePath, createDispatcher, createRouter } from '@src/core'
import {
	ACCEPTED_PATHS,
	MATRIX_METHODS,
	MATRIX_TABLES,
	PATH_ENCODED,
	REFUSED_PATHS,
	buildMatrixOrders,
	buildMatrixRequests,
	createMatrixHandler,
	dispatchReference,
	encodeReference,
	filterDistinctPaths,
	orderRoutes,
	parseReference,
	readMatrixOutcome,
	selectReference,
} from '../../setup.js'

// The router path matrix: `Router.match` and `Dispatcher.handle` against the reference grammar in
// `tests/setup.ts`, over every table, request form, method, case rule, and registration order.

describe('router path matrix — the reference encoder', () => {
	it('encodes every printable ASCII character and a non-ASCII sample as the URL parser does', () => {
		const printable = Array.from({ length: 0x5f }, (_, index) => String.fromCharCode(0x20 + index))
		const sample = [
			...printable.filter((char) => char !== '/' && char !== '\\'),
			'é',
			'日',
			'\u0001',
		]
		const drift = sample.flatMap((char) => {
			const url = new URL('http://x/')
			url.pathname = `/_${char}_`
			const parsed = url.pathname.slice(2, -1)
			return parsed === encodeReference(char) ? [] : [{ char, parsed }]
		})
		expect(drift).toEqual([])
		expect(PATH_ENCODED).toContain('?')
	})
})

describe('router path matrix — Router.match', () => {
	for (const table of MATRIX_TABLES) {
		const distinct = filterDistinctPaths(table.routes)
		const requests = buildMatrixRequests(table)
		for (const sensitive of [true, false]) {
			for (const order of buildMatrixOrders(distinct.length)) {
				it(`answers the reference on ${table.label}, sensitive ${sensitive}, ${order.label}`, () => {
					const routes = orderRoutes(distinct, order.indices)
					const router = createRouter<string>({ sensitive })
					router.add(routes.map((route) => ({ path: route.path, meta: route.path })))
					const drift = requests.flatMap((request) => {
						const pathname = new URL(`http://x${request.path}`).pathname
						const match = selectReference(routes, pathname, sensitive)
						const expected =
							match === undefined ? undefined : { path: match.path, params: match.params }
						const hit = router.match(pathname)
						const actual =
							hit === undefined ? undefined : { path: hit.path, params: { ...hit.params } }
						return JSON.stringify(actual) === JSON.stringify(expected)
							? []
							: [{ form: request.form, pathname, expected, actual }]
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
					const pathname = new URL(`http://x${request.path}`).pathname
					const tied = routers.some(
						({ routes }) => selectReference(routes, pathname, sensitive)?.tied === true,
					)
					const winners = new Set(routers.map(({ router }) => router.match(pathname)?.path))
					return tied || winners.size === 1 ? [] : [{ pathname, winners: [...winners] }]
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
						const pathname = new URL(`http://x${request.path}`).pathname
						const expected = dispatchReference(routes, method, pathname, sensitive)
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
