import type { NavigatorInterface, NavigatorOptions } from '../../../src/browser/types.js'
import type { RouterMatch } from '../../../src/core/types.js'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { createNavigator, Navigator } from '../../../src/browser/index.js'
import { createRecorder, waitForDelay } from '../../setup.js'
import {
	createAnchor,
	createDeferred,
	drainNavigators,
	safeClick,
	setHash,
	settleHash,
	settleHistory,
} from '../../setupBrowser.js'

// §16 mirror of `src/browser/Navigator.ts` — pinned in a real Chromium (the
// `src:browser` project) against real `location.hash` / `history` + real DOM
// events (§16.2, no mocks). Covers hash mode, history mode (base stripping +
// link interception), the guard matrix (sync veto, async allow/veto, supersede,
// throw), the `navigate` event payload, lifecycle idempotence, and the pure
// `match` lookup.

interface PageMeta {
	readonly page: string
}

// Every navigator started in a test is tracked and destroyed after it, so no
// `hashchange`/`popstate`/click listener leaks across cases (the §16.1 teardown
// shape). `location.hash` and `history` are reset before each case.
const navigators: NavigatorInterface<PageMeta>[] = []

beforeEach(async () => {
	drainNavigators(navigators)
	settleHistory('/')
	await settleHash()
})

afterEach(() => {
	drainNavigators(navigators)
})

function start(
	routes: readonly { readonly path: string; readonly meta: PageMeta }[],
	options?: Omit<Partial<NavigatorOptions<PageMeta>>, 'routes'>,
): NavigatorInterface<PageMeta> {
	const navigator = createNavigator<PageMeta>({ routes, ...options })
	navigators.push(navigator)
	navigator.start()
	return navigator
}

describe('Navigator — hash mode: resolves current hash + navigate lifecycle', () => {
	it('resolves the current hash on start()', async () => {
		await setHash('#/tokens')
		const navigator = start([
			{ path: '/tokens', meta: { page: 'tokens' } },
			{ path: '/palette', meta: { page: 'palette' } },
		])
		expect(navigator.active?.path).toBe('/tokens')
		expect(navigator.active?.meta).toEqual({ page: 'tokens' })
	})

	it('re-resolves on a real hashchange', async () => {
		const navigator = start([
			{ path: '/tokens', meta: { page: 'tokens' } },
			{ path: '/palette', meta: { page: 'palette' } },
		])
		window.location.hash = '#/palette'
		await waitForDelay()
		expect(navigator.active?.path).toBe('/palette')
	})

	it('extracts :param captures into active', async () => {
		await setHash('#/users/7')
		const navigator = start([{ path: '/users/:id', meta: { page: 'user' } }])
		expect(navigator.active?.params).toEqual({ id: '7' })
	})

	it('prefers a literal over a param (order-independent)', async () => {
		await setHash('#/users/me')
		const navigator = start([
			{ path: '/users/:id', meta: { page: 'user' } },
			{ path: '/users/me', meta: { page: 'me' } },
		])
		expect(navigator.active?.path).toBe('/users/me')
	})

	it('navigate(path) navigates by setting the hash and re-resolving', async () => {
		const navigator = start([
			{ path: '/tokens', meta: { page: 'tokens' } },
			{ path: '/palette', meta: { page: 'palette' } },
		])
		navigator.navigate('/palette')
		await waitForDelay()
		expect(window.location.hash).toBe('#/palette')
		expect(navigator.active?.path).toBe('/palette')
	})

	it('navigate(path) re-resolves synchronously when the destination is already the active hash', async () => {
		await setHash('#/tokens')
		const navigator = start([{ path: '/tokens', meta: { page: 'tokens' } }])
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		navigator.emitter.on('navigate', recorder.handler)
		navigator.navigate('/tokens') // same hash → no hashchange fires → resolves directly
		expect(recorder.count).toBe(1)
		expect(recorder.calls[0]?.[0].path).toBe('/tokens')
	})

	it('falls back to the first route on an unknown hash', async () => {
		await setHash('#/does-not-exist')
		const navigator = start([
			{ path: '/tokens', meta: { page: 'tokens' } },
			{ path: '/palette', meta: { page: 'palette' } },
		])
		expect(navigator.active?.path).toBe('/tokens')
	})

	it('honors an explicit fallback path', async () => {
		await setHash('#/nope')
		const navigator = start(
			[
				{ path: '/tokens', meta: { page: 'tokens' } },
				{ path: '/palette', meta: { page: 'palette' } },
			],
			{ fallback: '/palette' },
		)
		expect(navigator.active?.path).toBe('/palette')
	})

	it('leaves active undefined and emits nothing when the fallback itself matches nothing', async () => {
		await setHash('#/nope')
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		const navigator = createNavigator<PageMeta>({
			routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
			fallback: '/ghost',
			on: { navigate: recorder.handler },
		})
		navigators.push(navigator)
		navigator.start()
		expect(navigator.active).toBeUndefined()
		expect(recorder.count).toBe(0)
	})
})

describe('Navigator — history mode: pushState/popstate + base stripping', () => {
	it('resolves the current pathname on start()', () => {
		settleHistory('/tokens')
		const navigator = start(
			[
				{ path: '/tokens', meta: { page: 'tokens' } },
				{ path: '/palette', meta: { page: 'palette' } },
			],
			{ history: true },
		)
		expect(navigator.active?.path).toBe('/tokens')
	})

	it('navigate(path) pushes state and resolves synchronously', () => {
		const navigator = start(
			[
				{ path: '/tokens', meta: { page: 'tokens' } },
				{ path: '/palette', meta: { page: 'palette' } },
			],
			{ history: true },
		)
		navigator.navigate('/palette')
		expect(window.location.pathname).toBe('/palette')
		expect(navigator.active?.path).toBe('/palette')
	})

	it('re-resolves on a real popstate (browser back)', async () => {
		const navigator = start(
			[
				{ path: '/tokens', meta: { page: 'tokens' } },
				{ path: '/palette', meta: { page: 'palette' } },
			],
			{ history: true },
		)
		navigator.navigate('/tokens') // both traversal entries belong to THIS test — no cross-test history reliance
		navigator.navigate('/palette')
		expect(navigator.active?.path).toBe('/palette')
		const navigated = new Promise<void>((resolve) => {
			navigator.emitter.once('navigate', () => resolve())
		})
		window.history.back()
		await navigated
		expect(navigator.active?.path).toBe('/tokens')
	})

	it('strips a configured base before matching', () => {
		settleHistory('/app/users/7')
		const navigator = start([{ path: '/users/:id', meta: { page: 'user' } }], {
			history: true,
			base: '/app',
		})
		expect(navigator.active?.path).toBe('/users/:id')
		expect(navigator.active?.params).toEqual({ id: '7' })
	})

	it('navigate(path) composes the configured base back onto pushState', () => {
		settleHistory('/app')
		const navigator = start([{ path: '/users/:id', meta: { page: 'user' } }], {
			history: true,
			base: '/app',
		})
		navigator.navigate('/users/9')
		expect(window.location.pathname).toBe('/app/users/9')
		expect(navigator.active?.params).toEqual({ id: '9' })
	})
})

describe('Navigator — history mode: link interception', () => {
	it('intercepts a plain left-click on a same-origin link when intercept is true', () => {
		settleHistory('/')
		const navigator = start(
			[
				{ path: '/', meta: { page: 'home' } },
				{ path: '/tokens', meta: { page: 'tokens' } },
			],
			{ history: true, intercept: true },
		)
		const anchor = createAnchor('/tokens')
		try {
			const { prevented } = safeClick(anchor)
			expect(prevented).toBe(true)
			expect(window.location.pathname).toBe('/tokens')
			expect(navigator.active?.path).toBe('/tokens')
		} finally {
			anchor.remove()
		}
	})

	it('does not intercept when intercept is false (default)', () => {
		settleHistory('/')
		start(
			[
				{ path: '/', meta: { page: 'home' } },
				{ path: '/tokens', meta: { page: 'tokens' } },
			],
			{ history: true },
		)
		const anchor = createAnchor('/tokens')
		try {
			const { prevented } = safeClick(anchor)
			expect(prevented).toBe(false)
		} finally {
			anchor.remove()
		}
	})

	it('does not intercept a click carrying a modifier key', () => {
		settleHistory('/')
		start(
			[
				{ path: '/', meta: { page: 'home' } },
				{ path: '/tokens', meta: { page: 'tokens' } },
			],
			{ history: true, intercept: true },
		)
		const anchor = createAnchor('/tokens')
		try {
			const { prevented } = safeClick(anchor, { metaKey: true })
			expect(prevented).toBe(false)
			expect(window.location.pathname).toBe('/')
		} finally {
			anchor.remove()
		}
	})

	it('does not intercept a targeted link', () => {
		settleHistory('/')
		start(
			[
				{ path: '/', meta: { page: 'home' } },
				{ path: '/tokens', meta: { page: 'tokens' } },
			],
			{ history: true, intercept: true },
		)
		const anchor = createAnchor('/tokens', { target: '_blank' })
		try {
			const { prevented } = safeClick(anchor)
			expect(prevented).toBe(false)
		} finally {
			anchor.remove()
		}
	})

	it('does not intercept a download link', () => {
		settleHistory('/')
		start(
			[
				{ path: '/', meta: { page: 'home' } },
				{ path: '/tokens', meta: { page: 'tokens' } },
			],
			{ history: true, intercept: true },
		)
		const anchor = createAnchor('/tokens', { download: true })
		try {
			const { prevented } = safeClick(anchor)
			expect(prevented).toBe(false)
		} finally {
			anchor.remove()
		}
	})
})

describe('Navigator — guard matrix', () => {
	it('commits when the guard synchronously allows', async () => {
		await setHash('#/tokens')
		const navigator = start([{ path: '/tokens', meta: { page: 'tokens' } }], {
			guard: () => true,
		})
		await waitForDelay() // the guard's verdict is always awaited, even when returned synchronously
		expect(navigator.active?.path).toBe('/tokens')
	})

	it('vetoes synchronously — active stays unchanged, nothing emitted', async () => {
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		const navigator = createNavigator<PageMeta>({
			routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
			guard: () => false,
			on: { navigate: recorder.handler },
		})
		navigators.push(navigator)
		navigator.start()
		await waitForDelay()
		expect(navigator.active).toBeUndefined()
		expect(recorder.count).toBe(0)
	})

	it('commits after an async allow', async () => {
		const deferred = createDeferred<boolean>()
		const navigator = start([{ path: '/tokens', meta: { page: 'tokens' } }], {
			guard: () => deferred.promise,
		})
		expect(navigator.active).toBeUndefined() // guard still pending
		deferred.resolve(true)
		await waitForDelay()
		expect(navigator.active?.path).toBe('/tokens')
	})

	it('discards an async veto — active stays unchanged, nothing emitted', async () => {
		const deferred = createDeferred<boolean>()
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		const navigator = createNavigator<PageMeta>({
			routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
			guard: () => deferred.promise,
			on: { navigate: recorder.handler },
		})
		navigators.push(navigator)
		navigator.start()
		deferred.resolve(false)
		await waitForDelay()
		expect(navigator.active).toBeUndefined()
		expect(recorder.count).toBe(0)
	})

	it('supersede: a slow guard for navigation A is discarded when navigation B lands first', async () => {
		const first = createDeferred<boolean>()
		const seenAborted: boolean[] = []
		const navigator = createNavigator<PageMeta>({
			routes: [
				{ path: '/a', meta: { page: 'a' } },
				{ path: '/b', meta: { page: 'b' } },
			],
			history: true,
			guard: (to, _from, signal) => {
				if (to.path === '/a') {
					return first.promise.then(() => {
						seenAborted.push(signal.aborted)
						return true
					})
				}
				return true // navigation B allows synchronously
			},
		})
		navigators.push(navigator)
		settleHistory('/')
		navigator.navigate('/a') // guard pending, supersede handle A minted
		navigator.navigate('/b') // supersedes A, B's own guard resolves in a microtask
		await waitForDelay()
		expect(navigator.active?.path).toBe('/b')
		first.resolve(true) // A's stale verdict arrives after supersession
		await waitForDelay()
		// A's verdict must be discarded — active stays on B.
		expect(navigator.active?.path).toBe('/b')
		expect(seenAborted).toEqual([true])
	})

	it('a total miss (no path match, no fallback match) supersedes and aborts a pending guarded navigation', async () => {
		const deferred = createDeferred<boolean>()
		const seenAborted: boolean[] = []
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		const navigator = createNavigator<PageMeta>({
			routes: [{ path: '/a', meta: { page: 'a' } }],
			history: true,
			fallback: '/ghost',
			guard: (_to, _from, signal) =>
				deferred.promise.then((verdict) => {
					seenAborted.push(signal.aborted)
					return verdict
				}),
			on: { navigate: recorder.handler },
		})
		navigators.push(navigator)
		settleHistory('/')
		navigator.navigate('/a') // guard pending, supersede handle minted
		navigator.navigate('/nope') // total miss — path AND fallback both match nothing — must supersede
		expect(navigator.active).toBeUndefined()
		deferred.resolve(true) // the superseded guard's stale verdict arrives after the miss
		await waitForDelay()
		expect(navigator.active).toBeUndefined()
		expect(recorder.count).toBe(0)
		expect(seenAborted).toEqual([true])
	})

	it('a guard throw vetoes and routes to the error handler', async () => {
		const errors: [error: unknown, event: string][] = []
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		const navigator = createNavigator<PageMeta>({
			routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
			guard: () => {
				throw new Error('guard exploded')
			},
			on: { navigate: recorder.handler },
			error: (error, event) => {
				errors.push([error, event])
			},
		})
		navigators.push(navigator)
		navigator.start()
		await waitForDelay()
		expect(navigator.active).toBeUndefined()
		expect(recorder.count).toBe(0)
		expect(errors).toHaveLength(1)
		expect(errors[0]?.[1]).toBe('navigate')
		expect(errors[0]?.[0]).toBeInstanceOf(Error)
	})

	it('a rejected async guard vetoes without emitting', async () => {
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		const errors: unknown[] = []
		const navigator = createNavigator<PageMeta>({
			routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
			guard: () => Promise.reject(new Error('async guard rejected')),
			on: { navigate: recorder.handler },
			error: (error) => errors.push(error),
		})
		navigators.push(navigator)
		navigator.start()
		await waitForDelay()
		expect(navigator.active).toBeUndefined()
		expect(recorder.count).toBe(0)
		expect(errors).toHaveLength(1)
	})

	it('receives from as undefined on the very first navigation', () => {
		const seen: (RouterMatch<PageMeta> | undefined)[] = []
		const navigator = createNavigator<PageMeta>({
			routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
			guard: (_to, from) => {
				seen.push(from)
				return true
			},
		})
		navigators.push(navigator)
		navigator.start()
		expect(seen).toEqual([undefined])
	})

	it('receives the previous active match as from on a second navigation', async () => {
		const seen: (RouterMatch<PageMeta> | undefined)[] = []
		const navigator = createNavigator<PageMeta>({
			routes: [
				{ path: '/tokens', meta: { page: 'tokens' } },
				{ path: '/palette', meta: { page: 'palette' } },
			],
			history: true,
			guard: (_to, from) => {
				seen.push(from)
				return true
			},
		})
		navigators.push(navigator)
		settleHistory('/tokens')
		navigator.start()
		await waitForDelay() // let the first navigation's guard verdict commit before the second
		navigator.navigate('/palette')
		expect(seen).toHaveLength(2)
		expect(seen[0]).toBeUndefined()
		expect(seen[1]?.path).toBe('/tokens')
	})
})

describe('Navigator — the navigate event', () => {
	it('emits navigate with the resolved match on every navigation', async () => {
		await setHash('#/tokens')
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		const navigator = start([
			{ path: '/tokens', meta: { page: 'tokens' } },
			{ path: '/users/:id', meta: { page: 'user' } },
		])
		navigator.emitter.on('navigate', recorder.handler)
		navigator.navigate('/users/7')
		await waitForDelay()
		expect(recorder.count).toBe(1)
		expect(recorder.calls[0]?.[0]).toEqual({
			path: '/users/:id',
			params: { id: '7' },
			meta: { page: 'user' },
		})
	})

	it('wires an initial navigate listener from options.on', async () => {
		await setHash('#/tokens')
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		const navigator = createNavigator<PageMeta>({
			routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
			on: { navigate: recorder.handler },
		})
		navigators.push(navigator)
		navigator.start()
		expect(recorder.count).toBe(1)
		expect(recorder.calls[0]?.[0]).toEqual({
			path: '/tokens',
			params: {},
			meta: { page: 'tokens' },
		})
	})

	it('delivers the initial resolve to a listener registered before start', async () => {
		await setHash('#/tokens')
		const navigator = createNavigator<PageMeta>({
			routes: [
				{ path: '/tokens', meta: { page: 'tokens' } },
				{ path: '/palette', meta: { page: 'palette' } },
			],
		})
		navigators.push(navigator)
		const seen: string[] = []
		navigator.emitter.on('navigate', (match) => seen.push(match.path))
		navigator.start()
		expect(seen).toEqual(['/tokens'])
		navigator.navigate('/palette')
		await waitForDelay()
		expect(seen).toEqual(['/tokens', '/palette'])
	})
})

describe('Navigator — start / stop / destroy lifecycle', () => {
	it('stop() removes the listener — a later hashchange no longer resolves', async () => {
		await setHash('#/tokens')
		const navigator = start([
			{ path: '/tokens', meta: { page: 'tokens' } },
			{ path: '/palette', meta: { page: 'palette' } },
		])
		navigator.stop()
		window.location.hash = '#/palette'
		await waitForDelay()
		expect(navigator.active?.path).toBe('/tokens')
	})

	it('start() is idempotent — a second call does not double-register the listener', async () => {
		await setHash('#/tokens')
		const navigator = start([
			{ path: '/tokens', meta: { page: 'tokens' } },
			{ path: '/palette', meta: { page: 'palette' } },
		])
		navigator.start() // second call — must be a no-op
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		navigator.emitter.on('navigate', recorder.handler)
		window.location.hash = '#/palette'
		await waitForDelay()
		// Exactly ONE navigate from the single hashchange (not two from a doubled listener).
		expect(recorder.count).toBe(1)
	})

	it('stop() is idempotent — a second call is a no-op', () => {
		const navigator = start([{ path: '/tokens', meta: { page: 'tokens' } }])
		navigator.stop()
		expect(() => navigator.stop()).not.toThrow()
	})

	it('destroy() stops listening and tears down the emitter', async () => {
		await setHash('#/tokens')
		const navigator = start([
			{ path: '/tokens', meta: { page: 'tokens' } },
			{ path: '/palette', meta: { page: 'palette' } },
		])
		navigator.destroy()
		expect(navigator.emitter.destroyed).toBe(true)
		window.location.hash = '#/palette'
		await waitForDelay()
		expect(navigator.active?.path).toBe('/tokens')
	})

	it('createNavigator returns a Navigator instance', () => {
		const navigator = createNavigator<PageMeta>({
			routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
		})
		navigators.push(navigator)
		expect(navigator).toBeInstanceOf(Navigator)
	})
})

describe('Navigator — match(path) is a pure lookup', () => {
	it('does not mutate active or touch the location', () => {
		settleHistory('/other')
		const navigator = createNavigator<PageMeta>({
			routes: [
				{ path: '/users/:id', meta: { page: 'user' } },
				{ path: '/users/me', meta: { page: 'me' } },
			],
			history: true,
		})
		navigators.push(navigator)
		expect(navigator.match('/users/7')).toEqual({
			path: '/users/:id',
			params: { id: '7' },
			meta: { page: 'user' },
		})
		expect(navigator.match('/users/me')).toEqual({
			path: '/users/me',
			params: {},
			meta: { page: 'me' },
		})
		expect(navigator.active).toBeUndefined()
		expect(window.location.pathname).toBe('/other')
	})

	it('returns undefined for a non-matching path with no fallback applied', () => {
		const navigator = createNavigator<PageMeta>({
			routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
		})
		navigators.push(navigator)
		expect(navigator.match('/nope')).toBeUndefined()
	})
})

describe('Navigator — construction guards', () => {
	it('throws TypeError when guard is not a function', () => {
		expect(
			() =>
				new Navigator<PageMeta>({
					routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
					guard: 'nope' as unknown as () => boolean,
				}),
		).toThrow(TypeError)
	})

	it('throws TypeError when fallback is not a string', () => {
		expect(
			() =>
				new Navigator<PageMeta>({
					routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
					fallback: 7 as unknown as string,
				}),
		).toThrow(TypeError)
	})

	it('throws TypeError when base is not a string', () => {
		expect(
			() =>
				new Navigator<PageMeta>({
					routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
					base: 7 as unknown as string,
				}),
		).toThrow(TypeError)
	})

	it('throws TypeError from the underlying Router when a route path is malformed', () => {
		expect(
			() =>
				new Navigator<PageMeta>({ routes: [{ path: 'no-leading-slash', meta: { page: 'x' } }] }),
		).toThrow(TypeError)
	})
})

describe('Navigator — destroy() idempotence', () => {
	it('a second destroy() call is a no-op', () => {
		const navigator = createNavigator<PageMeta>({
			routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
		})
		navigator.destroy()
		expect(() => navigator.destroy()).not.toThrow()
		expect(navigator.emitter.destroyed).toBe(true)
	})
})

describe('NavigatorInterface — member shape', () => {
	it('exposes router, emitter, active, start, stop, navigate, match, destroy', () => {
		expectTypeOf<NavigatorInterface<PageMeta>>().toHaveProperty('router')
		expectTypeOf<NavigatorInterface<PageMeta>>().toHaveProperty('emitter')
		expectTypeOf<NavigatorInterface<PageMeta>>().toHaveProperty('active')
		expectTypeOf<NavigatorInterface<PageMeta>['start']>().toBeFunction()
		expectTypeOf<NavigatorInterface<PageMeta>['stop']>().toBeFunction()
		expectTypeOf<NavigatorInterface<PageMeta>['navigate']>().toBeFunction()
		expectTypeOf<NavigatorInterface<PageMeta>['match']>().toBeFunction()
		expectTypeOf<NavigatorInterface<PageMeta>['destroy']>().toBeFunction()
	})
})

// ── Cross-face grammar parity fixture (§8 "similar surface" pin) ────────────
//
// The SAME table as `core/Router.test.ts` and `core/Dispatcher.test.ts` — one
// one `it` case per face — driven here through the PURE `Navigator.match` lookup (no
// location read, no fallback, no guard, no emit — safe to run with no hash set).
const CROSS_FACE_TABLE = [
	{ pattern: '/users/:id', request: '/users/7', params: { id: '7' } },
	{ pattern: '/users/me', request: '/users/me', params: {} },
	{ pattern: '/files/*rest', request: '/files/a/b.png', params: { rest: 'a/b.png' } },
	{ pattern: '/about', request: '/about/', params: {} },
] as const

describe('Navigator — cross-face grammar parity fixture', () => {
	it('resolves every fixture case to its expected pattern + params via the pure match() lookup', () => {
		const navigator = createNavigator<PageMeta>({
			routes: CROSS_FACE_TABLE.map((row) => ({ path: row.pattern, meta: { page: row.pattern } })),
		})
		navigators.push(navigator)
		for (const row of CROSS_FACE_TABLE) {
			const match = navigator.match(row.request)
			expect(match?.path).toBe(row.pattern)
			expect(match?.params).toEqual(row.params)
		}
	})
})
