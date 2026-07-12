import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
	DispatchResult,
	DispatcherEventMap,
	DispatcherInterface,
	Method,
	RouteContext,
	RouteHandler,
} from '../../../src/core/types.js'
import { createDispatcher } from '../../../src/core/factories.js'
import { Dispatcher } from '../../../src/core/Dispatcher.js'
import { createRecorder } from '../../setup.js'

// §16 net-new mirror slice of `src/core/Dispatcher.ts` — U6-scoped: type-level
// surfaces (RouteHandler context typing, TState generic flow, DispatcherInterface
// member shape, factory return type), the emitter event payload shapes, destroy
// idempotence, and the cross-face grammar parity fixture driven through
// `Dispatcher.match`. The full functional dispatch matrix (auto-HEAD, auto-
// OPTIONS, 404/405 responders, handler-throw propagation) is U3's own suite and
// out of this unit's scope.

interface AppState {
	readonly userId: string
}

describe('createDispatcher — factory return type', () => {
	it('returns a Dispatcher instance implementing DispatcherInterface', () => {
		const dispatcher = createDispatcher()
		expect(dispatcher).toBeInstanceOf(Dispatcher)
		dispatcher.destroy()
	})
})

describe('RouteHandler — context typing per Path', () => {
	it('types context.params from the literal Path via PathParams', () => {
		const handler: RouteHandler<'/users/:id/posts/:slug'> = (_request, context) => {
			expectTypeOf(context.params).toEqualTypeOf<{ readonly id: string; readonly slug: string }>()
			return new Response(context.params.id)
		}
		expectTypeOf(handler).toBeFunction()
	})

	it('types context.state from TState', () => {
		const handler: RouteHandler<'/health', AppState> = (_request, context) => {
			expectTypeOf(context.state).toEqualTypeOf<AppState>()
			return new Response(context.state.userId)
		}
		expectTypeOf(handler).toBeFunction()
	})

	it('resolves an empty params record for a parameterless Path', () => {
		expectTypeOf<RouteContext<'/health'>['params']>().toExtend<Record<string, never>>()
		expectTypeOf<Record<string, never>>().toExtend<RouteContext<'/health'>['params']>()
	})
})

describe('Dispatcher — TState generic flow', () => {
	it('threads TState opaquely through add/handle without the dispatcher inspecting it', () => {
		expectTypeOf<DispatcherInterface<AppState>['handle']>().parameter(1).toEqualTypeOf<AppState>()
		expectTypeOf<DispatcherInterface>().toHaveProperty('router')
	})
})

describe('DispatcherInterface — member shape', () => {
	it('exposes router, emitter, add, group, match, handle, destroy', () => {
		expectTypeOf<DispatcherInterface>().toHaveProperty('router')
		expectTypeOf<DispatcherInterface>().toHaveProperty('emitter')
		expectTypeOf<DispatcherInterface['add']>().toBeFunction()
		expectTypeOf<DispatcherInterface['group']>().toBeFunction()
		expectTypeOf<DispatcherInterface['match']>().toBeFunction()
		expectTypeOf<DispatcherInterface['handle']>().toBeFunction()
		expectTypeOf<DispatcherInterface['destroy']>().toBeFunction()
	})

	it('match() returns a status-discriminated DispatchResult', () => {
		expectTypeOf<ReturnType<DispatcherInterface['match']>>().toHaveProperty('status')
	})
})

describe('Dispatcher — emitter event payload shapes (real listeners, no mocks)', () => {
	it('emits `match` with the request method and the winning pattern', async () => {
		const dispatcher = createDispatcher()
		const recorder = createRecorder<DispatcherEventMap['match']>()
		dispatcher.emitter.on('match', recorder.handler)
		dispatcher.add({ method: 'GET', path: '/users/:id', handler: () => new Response('ok') })
		await dispatcher.handle(new Request('http://x/users/7'), undefined)
		expect(recorder.calls).toEqual([['GET', '/users/:id']])
		dispatcher.destroy()
	})

	it('emits `miss` with the method, pathname, and "unmatched" kind on a total miss', async () => {
		const dispatcher = createDispatcher()
		const recorder = createRecorder<DispatcherEventMap['miss']>()
		dispatcher.emitter.on('miss', recorder.handler)
		await dispatcher.handle(new Request('http://x/nope'), undefined)
		expect(recorder.calls).toEqual([['GET', '/nope', 'unmatched']])
		dispatcher.destroy()
	})

	it('emits `miss` with kind "unmethoded" when the path matches but the method does not', async () => {
		const dispatcher = createDispatcher()
		const recorder = createRecorder<DispatcherEventMap['miss']>()
		dispatcher.emitter.on('miss', recorder.handler)
		dispatcher.add({ method: 'GET', path: '/users', handler: () => new Response('ok') })
		await dispatcher.handle(new Request('http://x/users', { method: 'DELETE' }), undefined)
		expect(recorder.calls).toEqual([['DELETE', '/users', 'unmethoded']])
		dispatcher.destroy()
	})
})

describe('Dispatcher — destroy() idempotence', () => {
	it('tears down the emitter and a second call is a no-op', () => {
		const dispatcher = createDispatcher()
		dispatcher.destroy()
		expect(dispatcher.emitter.destroyed).toBe(true)
		expect(() => dispatcher.destroy()).not.toThrow()
		expect(dispatcher.emitter.destroyed).toBe(true)
	})
})

// ── Cross-face grammar parity fixture (§8 "similar surface" pin) ────────────
//
// The SAME table as `core/Router.test.ts` and `browser/Navigator.test.ts` — one
// one `it` case per face — driven here through `Dispatcher.match`, which layers method
// dimensioning over the same underlying `Router` engine.
const CROSS_FACE_TABLE = [
	{ pattern: '/users/:id', request: '/users/7', params: { id: '7' } },
	{ pattern: '/users/me', request: '/users/me', params: {} },
	{ pattern: '/files/*rest', request: '/files/a/b.png', params: { rest: 'a/b.png' } },
	{ pattern: '/about', request: '/about/', params: {} },
] as const

// Narrows a `DispatchResult` to its `'matched'` variant WITHOUT an if-wrapped `expect`
// (the vitest `no-conditional-expect` rule) — throws loudly on the wrong status instead.
function matchedResult<TState>(
	result: DispatchResult<TState>,
): Extract<DispatchResult<TState>, { readonly status: 'matched' }> {
	if (result.status !== 'matched')
		throw new Error(`expected a "matched" DispatchResult, got "${result.status}"`)
	return result
}

describe('Dispatcher — cross-face grammar parity fixture', () => {
	it('resolves every fixture case to its expected pattern + params via match(method, pathname)', () => {
		const dispatcher = createDispatcher()
		dispatcher.add(
			CROSS_FACE_TABLE.map((row): { method: Method; path: string; handler: () => Response } => ({
				method: 'GET',
				path: row.pattern,
				handler: () => new Response('ok'),
			})),
		)
		for (const row of CROSS_FACE_TABLE) {
			const matched = matchedResult(dispatcher.match('GET', row.request))
			expect(matched.match.path).toBe(row.pattern)
			expect(matched.match.params).toEqual(row.params)
		}
		dispatcher.destroy()
	})
})

// ── Behavioral dispatch matrix (PROPOSAL §5.1) ───────────────────────────────

describe('Dispatcher — matched GET route', () => {
	it('returns the handler Response verbatim', async () => {
		const dispatcher = createDispatcher()
		const response = new Response('hello', { status: 201, headers: { 'x-tag': 'a' } })
		dispatcher.add({ method: 'GET', path: '/health', handler: () => response })
		const result = await dispatcher.handle(new Request('http://x/health'), undefined)
		expect(result).toBe(response)
		expect(result.status).toBe(201)
		expect(result.headers.get('x-tag')).toBe('a')
		dispatcher.destroy()
	})
})

describe('Dispatcher — default responders', () => {
	it('responds 405 with an Allow header for an unmethoded pathname', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/users', handler: () => new Response('ok') })
		const response = await dispatcher.handle(
			new Request('http://x/users', { method: 'DELETE' }),
			undefined,
		)
		expect(response.status).toBe(405)
		expect(response.headers.get('allow')).toContain('GET')
		dispatcher.destroy()
	})

	it('responds 404 for a totally unmatched pathname', async () => {
		const dispatcher = createDispatcher()
		const response = await dispatcher.handle(new Request('http://x/nope'), undefined)
		expect(response.status).toBe(404)
		dispatcher.destroy()
	})

	it('lets a custom unmatched responder override the default 404', async () => {
		const dispatcher = createDispatcher({
			unmatched: () => new Response('nothing here', { status: 404, headers: { 'x-custom': 'y' } }),
		})
		const response = await dispatcher.handle(new Request('http://x/nope'), undefined)
		expect(await response.text()).toBe('nothing here')
		expect(response.headers.get('x-custom')).toBe('y')
		dispatcher.destroy()
	})

	it('lets a custom unmethoded responder override the default 405', async () => {
		const dispatcher = createDispatcher({
			unmethoded: (_request, allow) =>
				new Response(`nope, try: ${allow.join(',')}`, { status: 405 }),
		})
		dispatcher.add({ method: 'GET', path: '/users', handler: () => new Response('ok') })
		const response = await dispatcher.handle(
			new Request('http://x/users', { method: 'DELETE' }),
			undefined,
		)
		expect(await response.text()).toContain('GET')
		dispatcher.destroy()
	})
})

describe('Dispatcher — auto-HEAD (§5.1)', () => {
	it('answers a HEAD request with only a GET route using the GET handler status+headers and a null body', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({
			method: 'GET',
			path: '/health',
			handler: () => Response.json({ ok: true }, { status: 200, headers: { 'x-tag': 'get' } }),
		})
		const response = await dispatcher.handle(
			new Request('http://x/health', { method: 'HEAD' }),
			undefined,
		)
		expect(response.status).toBe(200)
		expect(response.headers.get('x-tag')).toBe('get')
		expect(response.body).toBeNull()
		dispatcher.destroy()
	})

	it('lets an explicit HEAD route win over the auto-HEAD substitution', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('get body') })
		dispatcher.add({
			method: 'HEAD',
			path: '/health',
			handler: () => new Response(null, { status: 204, headers: { 'x-tag': 'head' } }),
		})
		const response = await dispatcher.handle(
			new Request('http://x/health', { method: 'HEAD' }),
			undefined,
		)
		expect(response.status).toBe(204)
		expect(response.headers.get('x-tag')).toBe('head')
		dispatcher.destroy()
	})
})

describe('Dispatcher — auto-OPTIONS', () => {
	it('auto-answers OPTIONS with 204 and a derived Allow header', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
		const response = await dispatcher.handle(
			new Request('http://x/health', { method: 'OPTIONS' }),
			undefined,
		)
		expect(response.status).toBe(204)
		expect(response.headers.get('allow')).toContain('GET')
		dispatcher.destroy()
	})

	it('lets an explicit OPTIONS route override the auto-OPTIONS responder', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
		dispatcher.add({
			method: 'OPTIONS',
			path: '/health',
			handler: () => new Response('custom options', { status: 200 }),
		})
		const response = await dispatcher.handle(
			new Request('http://x/health', { method: 'OPTIONS' }),
			undefined,
		)
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('custom options')
		dispatcher.destroy()
	})

	it('derives an Allow header including HEAD when only GET is registered', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
		const response = await dispatcher.handle(
			new Request('http://x/health', { method: 'OPTIONS' }),
			undefined,
		)
		const allow = (response.headers.get('allow') ?? '').split(', ')
		expect(allow).toContain('GET')
		expect(allow).toContain('HEAD')
		expect(allow).toContain('OPTIONS')
		dispatcher.destroy()
	})
})

describe('Dispatcher — registration boundary guard (§14)', () => {
	it('throws TypeError when handler is not a function', () => {
		const dispatcher = createDispatcher()
		// A malformed handler, arriving the way it would from an untyped boundary (parsed JSON) —
		// `JSON.parse` returns `any`, so assigning it to the declared function-typed field below
		// needs no `as` (the value is genuinely a runtime string).
		const malformedHandler: RouteHandler = JSON.parse('"not-a-function"')
		expect(() =>
			dispatcher.add({ method: 'GET', path: '/health', handler: malformedHandler }),
		).toThrow(TypeError)
		dispatcher.destroy()
	})

	it('throws TypeError when method is outside the registrable set', () => {
		const dispatcher = createDispatcher()
		// A method sourced from an untyped boundary (parsed JSON) — assigned to the declared
		// `Method` type below with no `as` (the value is genuinely a runtime `'TRACE'` string
		// outside the registrable set).
		const badMethod: Method = JSON.parse('"TRACE"')
		expect(() =>
			dispatcher.add({ method: badMethod, path: '/health', handler: () => new Response('ok') }),
		).toThrow(TypeError)
		dispatcher.destroy()
	})
})

describe('Dispatcher — unknown verb', () => {
	it('routes an unknown method (e.g. PURGE) against an unregistered path to unmatched, never a throw', async () => {
		const dispatcher = createDispatcher()
		let response: Response | undefined
		await expect(async () => {
			response = await dispatcher.handle(
				new Request('http://x/nope', { method: 'PURGE' }),
				undefined,
			)
		}).not.toThrow()
		expect(response?.status).toBe(404)
		dispatcher.destroy()
	})

	it('responds 405 with the raw verb in Allow-territory when the path has a GET route', async () => {
		const dispatcher = createDispatcher()
		const recorder = createRecorder<DispatcherEventMap['miss']>()
		dispatcher.emitter.on('miss', recorder.handler)
		dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
		const response = await dispatcher.handle(
			new Request('http://x/health', { method: 'PURGE' }),
			undefined,
		)
		expect(response.status).toBe(405)
		expect(response.headers.get('allow')).toContain('GET')
		expect(recorder.calls).toEqual([['PURGE', '/health', 'unmethoded']])
		dispatcher.destroy()
	})

	it('emits miss with the raw verb and "unmatched" kind for an unregistered path', async () => {
		const dispatcher = createDispatcher()
		const recorder = createRecorder<DispatcherEventMap['miss']>()
		dispatcher.emitter.on('miss', recorder.handler)
		const response = await dispatcher.handle(
			new Request('http://x/nope', { method: 'PURGE' }),
			undefined,
		)
		expect(response.status).toBe(404)
		expect(recorder.calls).toEqual([['PURGE', '/nope', 'unmatched']])
		dispatcher.destroy()
	})
})

describe('Dispatcher — handler throw propagation', () => {
	it('propagates a handler throw to the caller of handle', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({
			method: 'GET',
			path: '/boom',
			handler: () => {
				throw new Error('handler exploded')
			},
		})
		await expect(dispatcher.handle(new Request('http://x/boom'), undefined)).rejects.toThrow(
			'handler exploded',
		)
		dispatcher.destroy()
	})
})

describe('Dispatcher — state pass-through', () => {
	it('threads a typed TState value into context.state unmodified', async () => {
		const dispatcher = createDispatcher<AppState>()
		let seen: AppState | undefined
		dispatcher.add({
			method: 'GET',
			path: '/health',
			handler: (_request, context) => {
				seen = context.state
				return new Response('ok')
			},
		})
		await dispatcher.handle(new Request('http://x/health'), { userId: 'u1' })
		expect(seen).toEqual({ userId: 'u1' })
		dispatcher.destroy()
	})
})

describe('Dispatcher — params/pattern/url correctness', () => {
	it('resolves params, pattern, and url on a param route', async () => {
		const dispatcher = createDispatcher()
		let context: RouteContext<string> | undefined
		dispatcher.add({
			method: 'GET',
			path: '/users/:id',
			handler: (_request, c) => {
				context = c
				return new Response('ok')
			},
		})
		await dispatcher.handle(new Request('http://x/users/42?tab=posts'), undefined)
		expect(context?.params).toEqual({ id: '42' })
		expect(context?.pattern).toBe('/users/:id')
		expect(context?.url.pathname).toBe('/users/42')
		expect(context?.url.searchParams.get('tab')).toBe('posts')
		dispatcher.destroy()
	})
})

describe('Dispatcher — group + nested group registration', () => {
	it('registers routes through a group and a nested group with prefixes composed', async () => {
		const dispatcher = createDispatcher()
		const api = dispatcher.group('/api')
		const v1 = api.group('/v1')
		api.add({ method: 'GET', path: '/status', handler: () => new Response('api status') })
		v1.add({ method: 'GET', path: '/users', handler: () => new Response('v1 users') })

		const statusResponse = await dispatcher.handle(new Request('http://x/api/status'), undefined)
		expect(await statusResponse.text()).toBe('api status')

		const usersResponse = await dispatcher.handle(new Request('http://x/api/v1/users'), undefined)
		expect(await usersResponse.text()).toBe('v1 users')
		dispatcher.destroy()
	})
})

describe('Dispatcher — per-method dedup', () => {
	it('lets GET and POST on the same path coexist', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/items', handler: () => new Response('get') })
		dispatcher.add({ method: 'POST', path: '/items', handler: () => new Response('post') })

		const getResponse = await dispatcher.handle(new Request('http://x/items'), undefined)
		expect(await getResponse.text()).toBe('get')

		const postResponse = await dispatcher.handle(
			new Request('http://x/items', { method: 'POST' }),
			undefined,
		)
		expect(await postResponse.text()).toBe('post')
		dispatcher.destroy()
	})

	it('replaces the prior handler when a second GET is registered on the same canonical path', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/items', handler: () => new Response('first') })
		dispatcher.add({ method: 'GET', path: '/items', handler: () => new Response('second') })

		const response = await dispatcher.handle(new Request('http://x/items'), undefined)
		expect(await response.text()).toBe('second')
		dispatcher.destroy()
	})
})
