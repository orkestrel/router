import type { NavigatorInterface, NavigatorOptions } from '../../../src/browser/types.js'
import type { PageMeta } from '../../setupBrowser.js'
import type { RouterMatch } from '../../../src/core/types.js'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { ContractError } from '@orkestrel/contract'
import { createNavigator, Navigator } from '../../../src/browser/index.js'
import { createRecorder, waitForCondition, waitForDelay } from '@orkestrel/test'
import {
	BASE_ROUTES,
	DOOR_PATHS,
	ENCODED_BASES,
	ENCODED_HASHES,
	GUARD_ROUTES,
	HASH_ROUTES,
	buildDoorRoutes,
	createAnchor,
	startNavigator,
	drainNavigators,
	safeClick,
	setHash,
	settleHash,
	settleHistory,
	waitForHistory,
} from '../../setupBrowser.js'

// The test mirror of `src/browser/Navigator.ts` — pinned in a real Chromium (the
// `src:browser` project) against real `location.hash` / `history` + real DOM
// events (no mocks). Covers hash mode, history mode (base stripping +
// link interception), the guard matrix (sync veto, async allow/veto, supersede,
// throw), the `navigate` event payload, lifecycle idempotence, and the pure
// `match` lookup.

// Every navigator started in a test is tracked and destroyed after it, so no
// `hashchange`/`popstate`/click listener leaks across cases (the shared teardown
// shape). `location.hash` and `history` are reset before each case.
const navigators: Array<NavigatorInterface<PageMeta>> = []

beforeEach(async () => {
	drainNavigators(navigators)
	settleHistory('/')
	await settleHash()
})

afterEach(() => {
	drainNavigators(navigators)
})

describe('Navigator — hash mode: resolves current hash + navigate lifecycle', () => {
	it('resolves the current hash on start()', async () => {
		await setHash('#/tokens')
		const navigator = startNavigator(navigators, [
			{ path: '/tokens', meta: { page: 'tokens' } },
			{ path: '/palette', meta: { page: 'palette' } },
		])
		expect(navigator.active?.path).toBe('/tokens')
		expect(navigator.active?.meta).toEqual({ page: 'tokens' })
	})

	it('re-resolves on a real hashchange', async () => {
		const navigator = startNavigator(navigators, [
			{ path: '/tokens', meta: { page: 'tokens' } },
			{ path: '/palette', meta: { page: 'palette' } },
		])
		window.location.hash = '#/palette'
		await waitForDelay()
		expect(navigator.active?.path).toBe('/palette')
	})

	it('extracts :param captures into active', async () => {
		await setHash('#/users/7')
		const navigator = startNavigator(navigators, [{ path: '/users/:id', meta: { page: 'user' } }])
		expect(navigator.active?.params).toEqual({ id: '7' })
	})

	it('prefers a literal over a param (order-independent)', async () => {
		await setHash('#/users/me')
		const navigator = startNavigator(navigators, [
			{ path: '/users/:id', meta: { page: 'user' } },
			{ path: '/users/me', meta: { page: 'me' } },
		])
		expect(navigator.active?.path).toBe('/users/me')
	})

	it('navigate(path) navigates by setting the hash and re-resolving', async () => {
		const navigator = startNavigator(navigators, [
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
		const navigator = startNavigator(navigators, [{ path: '/tokens', meta: { page: 'tokens' } }])
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		navigator.emitter.on('navigate', recorder.handler)
		navigator.navigate('/tokens') // same hash → no hashchange fires → resolves directly
		expect(recorder.count).toBe(1)
		expect(recorder.calls[0]?.[0].path).toBe('/tokens')
	})

	it('falls back to the first route on an unknown hash', async () => {
		await setHash('#/does-not-exist')
		const navigator = startNavigator(navigators, [
			{ path: '/tokens', meta: { page: 'tokens' } },
			{ path: '/palette', meta: { page: 'palette' } },
		])
		expect(navigator.active?.path).toBe('/tokens')
	})

	it('honors an explicit fallback path', async () => {
		await setHash('#/nope')
		const navigator = startNavigator(
			navigators,
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
		const navigator = startNavigator(
			navigators,
			[
				{ path: '/tokens', meta: { page: 'tokens' } },
				{ path: '/palette', meta: { page: 'palette' } },
			],
			{ history: true },
		)
		expect(navigator.active?.path).toBe('/tokens')
	})

	it('navigate(path) pushes state and resolves synchronously', () => {
		const navigator = startNavigator(
			navigators,
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
		const navigator = startNavigator(
			navigators,
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
		const navigator = startNavigator(navigators, [{ path: '/users/:id', meta: { page: 'user' } }], {
			history: true,
			base: '/app',
		})
		expect(navigator.active?.path).toBe('/users/:id')
		expect(navigator.active?.params).toEqual({ id: '7' })
	})

	it('navigate(path) composes the configured base back onto pushState', () => {
		settleHistory('/app')
		const navigator = startNavigator(navigators, [{ path: '/users/:id', meta: { page: 'user' } }], {
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
		const navigator = startNavigator(
			navigators,
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
		startNavigator(
			navigators,
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
		startNavigator(
			navigators,
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
		startNavigator(
			navigators,
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
		startNavigator(
			navigators,
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
		const navigator = startNavigator(navigators, [{ path: '/tokens', meta: { page: 'tokens' } }], {
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
		const deferred = Promise.withResolvers<boolean>()
		const navigator = startNavigator(navigators, [{ path: '/tokens', meta: { page: 'tokens' } }], {
			guard: () => deferred.promise,
		})
		expect(navigator.active).toBeUndefined() // guard still pending
		deferred.resolve(true)
		await waitForDelay()
		expect(navigator.active?.path).toBe('/tokens')
	})

	it('discards an async veto — active stays unchanged, nothing emitted', async () => {
		const deferred = Promise.withResolvers<boolean>()
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
		const first = Promise.withResolvers<boolean>()
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
		const deferred = Promise.withResolvers<boolean>()
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
		const errors: Array<[error: unknown, event: string]> = []
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
		const seen: Array<RouterMatch<PageMeta> | undefined> = []
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
		const seen: Array<RouterMatch<PageMeta> | undefined> = []
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

describe('Navigator — a link outside base', () => {
	it('leaves a same-origin link outside base to the browser and keeps location and active', () => {
		settleHistory('/app/users')
		const navigator = startNavigator(navigators, BASE_ROUTES, {
			history: true,
			base: '/app',
			intercept: true,
		})
		const anchor = createAnchor('/other/page')
		try {
			const { prevented } = safeClick(anchor)
			expect(prevented).toBe(false)
			expect(window.location.pathname).toBe('/app/users')
			expect(navigator.active?.path).toBe('/users')
		} finally {
			anchor.remove()
		}
	})

	it('intercepts a same-origin link inside base', () => {
		settleHistory('/app/users')
		const navigator = startNavigator(navigators, BASE_ROUTES, {
			history: true,
			base: '/app',
			intercept: true,
		})
		const anchor = createAnchor('/app/other/page')
		try {
			const { prevented } = safeClick(anchor)
			expect(prevented).toBe(true)
			expect(window.location.pathname).toBe('/app/other/page')
			expect(navigator.active?.path).toBe('/other/page')
		} finally {
			anchor.remove()
		}
	})

	it('resolves the fallback for a location outside base', () => {
		settleHistory('/other/page')
		const navigator = startNavigator(navigators, BASE_ROUTES, { history: true, base: '/app' })
		expect(navigator.active?.path).toBe('/users')
	})
})

describe('Navigator — the guard runs before the URL moves', () => {
	it('history mode: a vetoed navigate leaves location, history length, and active unchanged', async () => {
		settleHistory('/a')
		const verdict = Promise.withResolvers<boolean>()
		const seen: string[] = []
		const navigator = startNavigator(navigators, GUARD_ROUTES, {
			history: true,
			guard: (to) => {
				seen.push(`${to.path} at ${window.location.pathname}`)
				return to.path === '/b' ? verdict.promise : true
			},
		})
		await waitForDelay()
		const length = window.history.length
		navigator.navigate('/b')
		expect(window.location.pathname).toBe('/a')
		verdict.resolve(false)
		await waitForDelay()
		expect(window.location.pathname).toBe('/a')
		expect(window.history.length).toBe(length)
		expect(navigator.active?.path).toBe('/a')
		expect(seen).toEqual(['/a at /a', '/b at /a'])
	})

	it('history mode: an allowed navigate moves the URL after the verdict', async () => {
		settleHistory('/a')
		const verdict = Promise.withResolvers<boolean>()
		const navigator = startNavigator(navigators, GUARD_ROUTES, {
			history: true,
			guard: (to) => (to.path === '/b' ? verdict.promise : true),
		})
		await waitForDelay()
		navigator.navigate('/b')
		expect(window.location.pathname).toBe('/a')
		verdict.resolve(true)
		await waitForDelay()
		expect(window.location.pathname).toBe('/b')
		expect(navigator.active?.path).toBe('/b')
	})

	it('hash mode: a vetoed navigate leaves location.hash and active unchanged', async () => {
		await setHash('#/a')
		const verdict = Promise.withResolvers<boolean>()
		const seen: string[] = []
		const navigator = startNavigator(navigators, GUARD_ROUTES, {
			guard: (to) => {
				seen.push(`${to.path} at ${window.location.hash}`)
				return to.path === '/b' ? verdict.promise : true
			},
		})
		await waitForDelay()
		const length = window.history.length
		navigator.navigate('/b')
		expect(window.location.hash).toBe('#/a')
		verdict.resolve(false)
		await waitForDelay()
		expect(window.location.hash).toBe('#/a')
		expect(window.history.length).toBe(length)
		expect(navigator.active?.path).toBe('/a')
		expect(seen).toEqual(['/a at #/a', '/b at #/a'])
	})

	it('hash mode: an allowed navigate moves the hash after the verdict and asks the guard once', async () => {
		await setHash('#/a')
		const verdict = Promise.withResolvers<boolean>()
		const seen: string[] = []
		const navigator = startNavigator(navigators, GUARD_ROUTES, {
			guard: (to) => {
				seen.push(to.path)
				return to.path === '/b' ? verdict.promise : true
			},
		})
		await waitForDelay()
		navigator.navigate('/b')
		expect(window.location.hash).toBe('#/a')
		verdict.resolve(true)
		await waitForDelay()
		expect(window.location.hash).toBe('#/b')
		expect(navigator.active?.path).toBe('/b')
		expect(seen).toEqual(['/a', '/b'])
	})

	it('history mode: refuses a path on another origin before the guard runs', () => {
		settleHistory('/a')
		const seen: string[] = []
		const navigator = startNavigator(navigators, GUARD_ROUTES, {
			history: true,
			guard: (to) => {
				seen.push(to.path)
				return true
			},
		})
		expect(() => navigator.navigate('//elsewhere.example/b')).toThrow(
			expect.objectContaining({ code: 'pattern' }),
		)
		expect(() => navigator.navigate('//elsewhere.example/b')).toThrow(ContractError)
		expect(window.location.pathname).toBe('/a')
		expect(seen).toEqual(['/a'])
	})
})

describe('Navigator — a veto after the browser moved the URL', () => {
	it('history mode: a popstate veto moves the location back to the entry active describes', async () => {
		settleHistory('/a')
		const blocked = new Set<string>()
		const seen: string[] = []
		const navigator = startNavigator(navigators, GUARD_ROUTES, {
			history: true,
			guard: (to) => {
				seen.push(to.path)
				return !blocked.has(to.path)
			},
		})
		await waitForDelay()
		navigator.navigate('/b')
		await waitForDelay()
		navigator.navigate('/c')
		await waitForDelay()
		const length = window.history.length
		blocked.add('/a')
		const arrived = waitForHistory('popstate')
		window.history.go(-2)
		await arrived
		await waitForCondition(
			'the vetoed traversal returns to /c',
			() => window.location.pathname === '/c',
		)
		await waitForDelay()
		expect(navigator.active?.path).toBe('/c')
		expect(window.history.length).toBe(length)
		expect(seen).toEqual(['/a', '/b', '/c', '/a'])
	})

	it('hash mode: a hashchange veto moves the hash back to the entry active describes', async () => {
		await setHash('#/a')
		const blocked = new Set<string>()
		const navigator = startNavigator(navigators, GUARD_ROUTES, {
			guard: (to) => !blocked.has(to.path),
		})
		await waitForDelay()
		navigator.navigate('/b')
		await waitForDelay()
		blocked.add('/a')
		const arrived = waitForHistory('hashchange')
		window.history.back()
		await arrived
		await waitForCondition(
			'the vetoed traversal returns to #/b',
			() => window.location.hash === '#/b',
		)
		await waitForDelay()
		expect(navigator.active?.path).toBe('/b')
	})

	it('hash mode: a vetoed fragment link the navigator did not write leaves the hash for the consumer to reconcile', async () => {
		await setHash('#/a')
		const navigator = startNavigator(navigators, GUARD_ROUTES, {
			guard: (to) => to.path !== '/b',
		})
		await waitForDelay()
		const anchor = createAnchor('#/b')
		try {
			const arrived = waitForHistory('hashchange')
			anchor.click()
			await arrived
			// A traversal lands in a later task, so the case waits long enough for a restore to land.
			await waitForDelay(100)
			expect(window.location.hash).toBe('#/b')
			expect(navigator.active?.path).toBe('/a')
		} finally {
			anchor.remove()
		}
	})
})

describe('Navigator — a navigate from a navigate listener', () => {
	it('runs after the emission, so each listener reads active equal to the match it receives', async () => {
		settleHistory('/a')
		const navigator = createNavigator<PageMeta>({ routes: GUARD_ROUTES, history: true })
		navigators.push(navigator)
		const deliveries: string[] = []
		navigator.emitter.on('navigate', (match) => {
			deliveries.push(`first ${match.path} ${navigator.active?.path}`)
			if (match.path === '/b') navigator.navigate('/c')
		})
		navigator.emitter.on('navigate', (match) => {
			deliveries.push(`second ${match.path} ${navigator.active?.path}`)
		})
		navigator.navigate('/b')
		await waitForDelay()
		expect(deliveries).toEqual(['first /b /b', 'second /b /b', 'first /c /c', 'second /c /c'])
		expect(navigator.active?.path).toBe('/c')
		expect(window.location.pathname).toBe('/c')
	})

	it('yields to a later navigate made before the deferred navigate runs', async () => {
		settleHistory('/a')
		const navigator = createNavigator<PageMeta>({ routes: GUARD_ROUTES, history: true })
		navigators.push(navigator)
		const delivered: string[] = []
		navigator.emitter.on('navigate', (match) => {
			delivered.push(match.path)
			if (match.path === '/b') navigator.navigate('/a')
		})
		navigator.navigate('/b')
		navigator.navigate('/c')
		await waitForDelay()
		expect(delivered).toEqual(['/b', '/c'])
		expect(navigator.active?.path).toBe('/c')
		expect(window.location.pathname).toBe('/c')
	})
})

describe('Navigator — after destroy', () => {
	it('navigate pushes no entry and emits nothing', () => {
		settleHistory('/a')
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		const navigator = startNavigator(navigators, GUARD_ROUTES, {
			history: true,
			on: { navigate: recorder.handler },
		})
		navigator.destroy()
		const length = window.history.length
		navigator.navigate('/b')
		expect(window.location.pathname).toBe('/a')
		expect(window.history.length).toBe(length)
		expect(navigator.active?.path).toBe('/a')
		expect(recorder.count).toBe(1)
	})

	it('start binds no listener and resolves nothing', async () => {
		await setHash('#/a')
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		const navigator = createNavigator<PageMeta>({
			routes: GUARD_ROUTES,
			on: { navigate: recorder.handler },
		})
		navigators.push(navigator)
		navigator.destroy()
		navigator.start()
		expect(navigator.active).toBeUndefined()
		window.location.hash = '#/b'
		await waitForDelay()
		expect(navigator.active).toBeUndefined()
		expect(recorder.count).toBe(0)
	})
})

describe('Navigator — the pending registry', () => {
	it('stop aborts the pending navigation and discards its verdict', async () => {
		settleHistory('/a')
		const verdict = Promise.withResolvers<boolean>()
		const signals: AbortSignal[] = []
		const navigator = startNavigator(navigators, GUARD_ROUTES, {
			history: true,
			guard: (to, _from, signal) => {
				signals.push(signal)
				return to.path === '/b' ? verdict.promise : true
			},
		})
		await waitForDelay()
		navigator.navigate('/b')
		navigator.stop()
		expect(signals.map((signal) => signal.aborted)).toEqual([false, true])
		verdict.resolve(true)
		await waitForDelay()
		expect(window.location.pathname).toBe('/a')
		expect(navigator.active?.path).toBe('/a')
	})

	it('destroy aborts a pending navigation on a navigator that never started', async () => {
		settleHistory('/a')
		const verdict = Promise.withResolvers<boolean>()
		const signals: AbortSignal[] = []
		const navigator = createNavigator<PageMeta>({
			routes: GUARD_ROUTES,
			history: true,
			guard: (_to, _from, signal) => {
				signals.push(signal)
				return verdict.promise
			},
		})
		navigators.push(navigator)
		navigator.navigate('/b')
		navigator.destroy()
		expect(signals.map((signal) => signal.aborted)).toEqual([true])
		verdict.resolve(true)
		await waitForDelay()
		expect(window.location.pathname).toBe('/a')
		expect(navigator.active).toBeUndefined()
	})
})

describe('Navigator — location text compared in one form', () => {
	it.each(ENCODED_BASES)(
		'strips the non-ASCII base $base from the encoded pathname',
		({ base, location, pathname, route, params }) => {
			settleHistory(location)
			const routes = [{ path: '/home', meta: { page: 'home' } }, route]
			const navigator = startNavigator(navigators, routes, { history: true, base })
			expect(window.location.pathname).toBe(pathname)
			expect(navigator.active?.path).toBe(route.path)
			expect(navigator.active?.params).toEqual(params)
		},
	)

	it.each(ENCODED_HASHES)('resolves a navigate to the hash %s it already shows', async (path) => {
		await setHash(`#${path}`)
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		const navigator = startNavigator(navigators, HASH_ROUTES, {
			on: { navigate: recorder.handler },
		})
		const shown = window.location.hash
		const length = window.history.length
		navigator.navigate(path)
		expect(recorder.count).toBe(2)
		expect(recorder.calls[1]?.[0].path).toBe('/w/:name')
		await waitForDelay()
		expect(window.location.hash).toBe(shown)
		expect(window.history.length).toBe(length)
		expect(recorder.count).toBe(2)
	})
})

describe('Navigator — the navigate event', () => {
	it('emits navigate with the resolved match on every navigation', async () => {
		await setHash('#/tokens')
		const recorder = createRecorder<readonly [RouterMatch<PageMeta>]>()
		const navigator = startNavigator(navigators, [
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
		const navigator = startNavigator(navigators, [
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
		const navigator = startNavigator(navigators, [
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
		const navigator = startNavigator(navigators, [{ path: '/tokens', meta: { page: 'tokens' } }])
		navigator.stop()
		expect(() => navigator.stop()).not.toThrow()
	})

	it('destroy() stops listening and tears down the emitter', async () => {
		await setHash('#/tokens')
		const navigator = startNavigator(navigators, [
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

describe('Navigator — a lookup goes through the router getter', () => {
	it('answers through navigator.router.match without touching active or the location', () => {
		settleHistory('/other')
		const navigator = createNavigator<PageMeta>({
			routes: [
				{ path: '/users/:id', meta: { page: 'user' } },
				{ path: '/users/me', meta: { page: 'me' } },
			],
			history: true,
		})
		navigators.push(navigator)
		expect(navigator.router.match('/users/7')).toEqual({
			path: '/users/:id',
			params: { id: '7' },
			meta: { page: 'user' },
		})
		expect(navigator.router.match('/users/me')).toEqual({
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
		expect(navigator.router.match('/nope')).toBeUndefined()
	})

	it('exposes no match method of its own', () => {
		const navigator = createNavigator<PageMeta>({
			routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
		})
		navigators.push(navigator)
		expect('match' in navigator).toBe(false)
	})
})

describe('Navigator — every door reaches an encoded literal (F9)', () => {
	for (const path of DOOR_PATHS) {
		// Another route registers first, so a door that misses lands on it, never on `path`.
		const other = DOOR_PATHS.find((candidate) => candidate !== path) ?? path

		it(`resolves ${path} through history navigate`, () => {
			const navigator = startNavigator(navigators, buildDoorRoutes(other), { history: true })
			expect(navigator.active?.path).toBe(other)
			navigator.navigate(path)
			expect(navigator.active?.path).toBe(path)
		})

		it(`resolves ${path} through hash navigate`, async () => {
			const navigator = startNavigator(navigators, buildDoorRoutes(other))
			expect(navigator.active?.path).toBe(other)
			navigator.navigate(path)
			await waitForDelay()
			expect(navigator.active?.path).toBe(path)
		})

		it(`resolves ${path} as the configured fallback`, async () => {
			await setHash('#/nowhere')
			const navigator = startNavigator(navigators, buildDoorRoutes(other), { fallback: path })
			expect(navigator.active?.path).toBe(path)
		})

		it(`resolves ${path} as the default fallback`, async () => {
			await setHash('#/nowhere')
			const navigator = startNavigator(navigators, buildDoorRoutes(path))
			expect(navigator.active?.path).toBe(path)
		})

		it(`matches ${path} as raw text and as the encoded pathname`, () => {
			const navigator = startNavigator(navigators, buildDoorRoutes(path))
			const encoded = new URL(path, window.location.origin).pathname
			expect([navigator.router.match(path)?.path, navigator.router.match(encoded)?.path]).toEqual([
				path,
				path,
			])
		})
	}
})

describe('Navigator — construction guards', () => {
	it('throws a ContractError coded `literal` when guard is not a function', () => {
		// A malformed guard, arriving the way it would from an untyped boundary (parsed JSON) —
		// `JSON.parse` returns `any`, so assigning it to the following declared guard type needs no
		// `as` (the value is genuinely a runtime string).
		const malformedGuard: NonNullable<NavigatorOptions<PageMeta>['guard']> = JSON.parse('"nope"')
		expect(
			() =>
				new Navigator<PageMeta>({
					routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
					guard: malformedGuard,
				}),
		).toThrow(ContractError)
		expect(
			() =>
				new Navigator<PageMeta>({
					routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
					guard: malformedGuard,
				}),
		).toThrow(expect.objectContaining({ code: 'literal' }))
	})

	it('throws a ContractError coded `literal` when fallback is not a string', () => {
		// A fallback sourced from an untyped boundary (parsed JSON) — assigned to the declared
		// `string` type with no `as` (the value is genuinely a runtime number).
		const malformedFallback: string = JSON.parse('7')
		expect(
			() =>
				new Navigator<PageMeta>({
					routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
					fallback: malformedFallback,
				}),
		).toThrow(ContractError)
		expect(
			() =>
				new Navigator<PageMeta>({
					routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
					fallback: malformedFallback,
				}),
		).toThrow(expect.objectContaining({ code: 'literal' }))
	})

	it('throws a ContractError coded `literal` when base is not a string', () => {
		// A base sourced from an untyped boundary (parsed JSON) — assigned to the declared
		// `string` type with no `as` (the value is genuinely a runtime number).
		const malformedBase: string = JSON.parse('7')
		expect(
			() =>
				new Navigator<PageMeta>({
					routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
					base: malformedBase,
				}),
		).toThrow(ContractError)
		expect(
			() =>
				new Navigator<PageMeta>({
					routes: [{ path: '/tokens', meta: { page: 'tokens' } }],
					base: malformedBase,
				}),
		).toThrow(expect.objectContaining({ code: 'literal' }))
	})

	it('throws a ContractError coded `pattern` from the underlying Router when a route path is malformed', () => {
		expect(
			() =>
				new Navigator<PageMeta>({ routes: [{ path: 'no-leading-slash', meta: { page: 'x' } }] }),
		).toThrow(ContractError)
		expect(
			() =>
				new Navigator<PageMeta>({ routes: [{ path: 'no-leading-slash', meta: { page: 'x' } }] }),
		).toThrow(expect.objectContaining({ code: 'pattern' }))
	})
})

describe('Navigator — the published router getter', () => {
	it('carries the route payload as meta, the same shape the navigate event delivers', () => {
		settleHistory('/tokens')
		const navigator = startNavigator(navigators, [{ path: '/tokens', meta: { page: 'tokens' } }], {
			history: true,
		})
		const inner = navigator.router.match('/tokens')
		expect(inner?.meta).toEqual({ page: 'tokens' })
		expect(inner).toEqual(navigator.active)
	})

	it('registers each route once on the shared engine', () => {
		const navigator = createNavigator<PageMeta>({
			routes: [
				{ path: '/tokens', meta: { page: 'tokens' } },
				{ path: '/tokens/', meta: { page: 'replaced' } },
			],
		})
		navigators.push(navigator)
		expect(navigator.router.count).toBe(1)
		expect(navigator.router.match('/tokens')?.meta).toEqual({ page: 'replaced' })
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
	it('exposes router, emitter, active, start, stop, navigate, destroy', () => {
		expectTypeOf<NavigatorInterface<PageMeta>>().toHaveProperty('router')
		expectTypeOf<NavigatorInterface<PageMeta>>().toHaveProperty('emitter')
		expectTypeOf<NavigatorInterface<PageMeta>>().toHaveProperty('active')
		expectTypeOf<NavigatorInterface<PageMeta>['start']>().toBeFunction()
		expectTypeOf<NavigatorInterface<PageMeta>['stop']>().toBeFunction()
		expectTypeOf<NavigatorInterface<PageMeta>['navigate']>().toBeFunction()
		expectTypeOf<NavigatorInterface<PageMeta>>().not.toHaveProperty('match')
		expectTypeOf<NavigatorInterface<PageMeta>['destroy']>().toBeFunction()
	})
})

// ── Cross-face grammar parity fixture (the similar-surface pin) ─────────────
//
// The SAME table as `core/Router.test.ts` and `core/Dispatcher.test.ts` — one
// one `it` case per face — driven here through a history-mode `navigate`, the Navigator's own
// door, and read back from `active`.
const CROSS_FACE_TABLE = [
	{ pattern: '/users/:id', request: '/users/7', params: { id: '7' } },
	{ pattern: '/users/me', request: '/users/me', params: {} },
	{ pattern: '/files/*rest', request: '/files/a/b.png', params: { rest: 'a/b.png' } },
	{ pattern: '/about', request: '/about/', params: {} },
] as const

describe('Navigator — cross-face grammar parity fixture', () => {
	it('resolves every fixture case to its expected pattern + params through navigate', () => {
		settleHistory('/')
		const navigator = createNavigator<PageMeta>({
			routes: CROSS_FACE_TABLE.map((row) => ({ path: row.pattern, meta: { page: row.pattern } })),
			history: true,
		})
		navigators.push(navigator)
		for (const row of CROSS_FACE_TABLE) {
			navigator.navigate(row.request)
			expect(navigator.active?.path).toBe(row.pattern)
			expect(navigator.active?.params).toEqual(row.params)
		}
	})
})

// ── Flagship fence transcriptions ────────────────────────────────────────────
//
// Each block that follows is one `guides/router.md` fence importing `@orkestrel/router/browser`,
// run against the real barrel and asserting what its comments claim. The `guides` project runs in
// Node with the browser disabled, so it cannot execute a fence that touches `window` — the
// core fences are transcribed in `tests/guides.test.ts` and these browser ones live here
// instead. Change a fence, change its transcription.

interface TitleMeta {
	readonly title: string
}

// The fences carry their own `{ title }` payload, so they need their own tracked list — the
// shared `navigators` array is pinned to `PageMeta`.
const fenceNavigators: Array<NavigatorInterface<TitleMeta>> = []

describe('flagship fences', () => {
	afterEach(() => {
		drainNavigators(fenceNavigators)
	})

	it('navigates in hash mode and tears down (guides/router.md — Hash-mode navigation)', async () => {
		await settleHash()
		const navigator = createNavigator<TitleMeta>({
			routes: [
				{ path: '/', meta: { title: 'Home' } },
				{ path: '/about', meta: { title: 'About' } },
			],
		})
		fenceNavigators.push(navigator)
		const titles: string[] = []
		navigator.emitter.on('navigate', (match) => titles.push(match.meta.title))
		navigator.start()
		expect(navigator.router.match('/about')?.meta.title).toBe('About')
		navigator.navigate('/about')
		expect(window.location.hash).toBe('#/about')
		expect(navigator.active?.path).toBe('/about')
		await waitForDelay()
		expect(titles).toEqual(['Home', 'About'])
		navigator.stop()
		navigator.destroy()
		expect(navigator.emitter.destroyed).toBe(true)
	})

	it('binds popstate and link interception in history mode (guides/router.md — History mode with link interception)', () => {
		settleHistory('/app/users/7')
		const navigator = createNavigator<TitleMeta>({
			routes: [{ path: '/users/:id', meta: { title: 'User' } }],
			history: true,
			base: '/app',
			intercept: true,
		})
		fenceNavigators.push(navigator)
		navigator.start()
		expect(navigator.active?.path).toBe('/users/:id')
		expect(navigator.active?.params).toEqual({ id: '7' })
		const anchor = createAnchor('/app/users/9')
		try {
			const { prevented } = safeClick(anchor)
			expect(prevented).toBe(true)
			expect(window.location.pathname).toBe('/app/users/9')
			expect(navigator.active?.params).toEqual({ id: '9' })
		} finally {
			anchor.remove()
		}
	})

	it('runs an async guard before committing (guides/router.md — Guarding navigation)', async () => {
		await setHash('#/')
		const navigator = createNavigator<TitleMeta>({
			routes: [
				{ path: '/private', meta: { title: 'Private' } },
				{ path: '/', meta: { title: 'Home' } },
			],
			guard: async (_to, _from, signal) => {
				const allowed = await Promise.resolve(true)
				return signal.aborted ? false : allowed
			},
		})
		fenceNavigators.push(navigator)
		navigator.start()
		expect(navigator.active).toBeUndefined()
		await waitForDelay()
		expect(navigator.active?.path).toBe('/')
		navigator.navigate('/private')
		await waitForDelay()
		expect(navigator.active?.path).toBe('/private')
	})
})
