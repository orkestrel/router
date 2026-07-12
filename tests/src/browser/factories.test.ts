import { describe, expect, it } from 'vitest'
import { createNavigator, Navigator } from '../../../src/browser/index.js'

// §16 mirror of `src/browser/factories.ts` — `createNavigator` returns a working
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

	it('is usable immediately — match() works before start()', () => {
		const navigator = createNavigator({ routes: [{ path: '/users/:id', meta: { page: 'user' } }] })
		try {
			expect(navigator.match('/users/7')).toEqual({
				path: '/users/:id',
				params: { id: '7' },
				meta: { page: 'user' },
			})
		} finally {
			navigator.destroy()
		}
	})
})
