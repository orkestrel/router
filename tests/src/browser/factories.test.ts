import { describe, expect, it } from 'vitest'
import { createNavigator, Navigator } from '../../../src/browser/index.js'

// The test mirror of `src/browser/factories.ts` — `createNavigator` returns a working
// `Navigator` instance.

describe('createNavigator', () => {
	it('returns a Navigator instance', () => {
		const navigator = createNavigator({ routes: [{ path: '/tokens', meta: undefined }] })
		try {
			expect(navigator).toBeInstanceOf(Navigator)
		} finally {
			navigator.destroy()
		}
	})

	it('is usable immediately — its router answers before start()', () => {
		const navigator = createNavigator({ routes: [{ path: '/users/:id', meta: { page: 'user' } }] })
		try {
			expect(navigator.router.match('/users/7')).toEqual({
				path: '/users/:id',
				params: { id: '7' },
				meta: { page: 'user' },
			})
		} finally {
			navigator.destroy()
		}
	})
})
