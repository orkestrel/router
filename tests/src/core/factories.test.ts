import { describe, expect, expectTypeOf, it } from 'vitest'
import type { DispatcherInterface, RouterInterface } from '../../../src/core/types.js'
import { createDispatcher, createRouter } from '../../../src/core/factories.js'
import { Dispatcher } from '../../../src/core/Dispatcher.js'
import { Router } from '../../../src/core/Router.js'
import { createRecorder } from '../../setup.js'

// §16 mirror of `src/core/factories.ts` — `createRouter`/`createDispatcher` round-trips
// (instances satisfy their interfaces, options forwarded) plus their return-type assertions.

interface PageMeta {
	readonly page: string
}

describe('createRouter — round-trip', () => {
	it('returns a Router instance implementing RouterInterface', () => {
		const router = createRouter<PageMeta>()
		expect(router).toBeInstanceOf(Router)
		const check: RouterInterface<PageMeta> = router
		expect(check).toBe(router)
	})

	it('forwards seed entries so they resolve immediately', () => {
		const router = createRouter<PageMeta>({
			entries: [{ path: '/users/:id', meta: { page: 'profile' } }],
		})
		expect(router.match('/users/7')).toEqual({
			path: '/users/:id',
			params: { id: '7' },
			meta: { page: 'profile' },
			name: undefined,
		})
	})

	it('forwards `sensitive` to the underlying matching', () => {
		const router = createRouter<PageMeta>({ sensitive: false })
		router.add({ path: '/Users', meta: { page: 'list' } })
		expect(router.match('/users')?.meta.page).toBe('list')
	})

	it('forwards `key` so a later registration replaces an earlier one in place', () => {
		const router = createRouter<PageMeta>({ key: (entry) => entry.path })
		router.add({ path: '/users', meta: { page: 'first' } })
		router.add({ path: '/users', meta: { page: 'second' } })
		expect(router.count).toBe(1)
		expect(router.match('/users')?.meta.page).toBe('second')
	})

	it('returns RouterInterface — a factory return type assertion', () => {
		expectTypeOf(createRouter<PageMeta>()).toEqualTypeOf<RouterInterface<PageMeta>>()
	})
})

interface AppState {
	readonly userId: string
}

describe('createDispatcher — round-trip', () => {
	it('returns a Dispatcher instance implementing DispatcherInterface', () => {
		const dispatcher = createDispatcher<AppState>()
		expect(dispatcher).toBeInstanceOf(Dispatcher)
		const check: DispatcherInterface<AppState> = dispatcher
		expect(check).toBe(dispatcher)
		dispatcher.destroy()
	})

	it('forwards seed routes so they resolve immediately', async () => {
		const dispatcher = createDispatcher<AppState>({
			routes: [{ method: 'GET', path: '/health', handler: () => new Response('ok') }],
		})
		const response = await dispatcher.handle(new Request('http://x/health'), { userId: 'u1' })
		expect(await response.text()).toBe('ok')
		dispatcher.destroy()
	})

	it('forwards `sensitive` to the underlying router', async () => {
		const dispatcher = createDispatcher<AppState>({
			sensitive: false,
			routes: [{ method: 'GET', path: '/Users', handler: () => new Response('ok') }],
		})
		const response = await dispatcher.handle(new Request('http://x/users'), { userId: 'u1' })
		expect(response.status).toBe(200)
		dispatcher.destroy()
	})

	it('forwards `on` hooks so listeners fire from construction', async () => {
		const recorder = createRecorder<readonly [method: string, pattern: string]>()
		const dispatcher = createDispatcher<AppState>({
			routes: [{ method: 'GET', path: '/health', handler: () => new Response('ok') }],
			on: { match: recorder.handler },
		})
		await dispatcher.handle(new Request('http://x/health'), { userId: 'u1' })
		expect(recorder.calls).toEqual([['GET', '/health']])
		dispatcher.destroy()
	})

	it('returns DispatcherInterface — a factory return type assertion', () => {
		const dispatcher = createDispatcher<AppState>()
		expectTypeOf(dispatcher).toEqualTypeOf<DispatcherInterface<AppState>>()
		dispatcher.destroy()
	})
})
