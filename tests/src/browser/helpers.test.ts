import { describe, expect, it } from 'vitest'
import { extractHashPath, findAnchor, resolveLocationPath } from '../../../src/browser/helpers.js'
import { safeClick } from '../../setupBrowser.js'

// §16 mirror of `src/browser/helpers.ts` — the pure browser-navigation primitives:
// hash → pathname extraction, current-location resolution across both navigation
// modes, and the click-event → anchor lookup that backs link interception.

describe('extractHashPath', () => {
	it('extracts the /-prefixed pathname from a #/… hash', () => {
		expect(extractHashPath('#/users/7')).toBe('/users/7')
	})

	it('drops a trailing ?query suffix', () => {
		expect(extractHashPath('#/users/7?x')).toBe('/users/7')
	})

	it('drops a ?query suffix with no path segments beyond the leading slash', () => {
		expect(extractHashPath('#/?x=1')).toBe('/')
	})

	it('returns an empty string for an empty hash', () => {
		expect(extractHashPath('')).toBe('')
	})

	it('returns an empty string for a hash not starting with #/', () => {
		expect(extractHashPath('#other')).toBe('')
	})

	it('returns an empty string for a bare #', () => {
		expect(extractHashPath('#')).toBe('')
	})
})

describe('resolveLocationPath — hash mode', () => {
	it('delegates to extractHashPath, ignoring pathname', () => {
		expect(resolveLocationPath({ hash: '#/tokens', pathname: '/should-be-ignored' }, false)).toBe(
			'/tokens',
		)
	})

	it('returns an empty string for a non-route hash', () => {
		expect(resolveLocationPath({ hash: '', pathname: '/anything' }, false)).toBe('')
	})
})

describe('resolveLocationPath — history mode', () => {
	it('returns the pathname unchanged with no base configured', () => {
		expect(resolveLocationPath({ hash: '', pathname: '/users/7' }, true)).toBe('/users/7')
	})

	it('returns the pathname unchanged when base is an empty string', () => {
		expect(resolveLocationPath({ hash: '', pathname: '/users/7' }, true, '')).toBe('/users/7')
	})

	it('strips a matching base prefix', () => {
		expect(resolveLocationPath({ hash: '', pathname: '/app/users/7' }, true, '/app')).toBe(
			'/users/7',
		)
	})

	it('strips a base prefix that ends with a trailing slash', () => {
		expect(resolveLocationPath({ hash: '', pathname: '/app/users/7' }, true, '/app/')).toBe(
			'/users/7',
		)
	})

	it('maps the bare base pathname to the root', () => {
		expect(resolveLocationPath({ hash: '', pathname: '/app' }, true, '/app')).toBe('/')
	})

	it('returns the pathname unchanged when it does not start with base', () => {
		expect(resolveLocationPath({ hash: '', pathname: '/other/users' }, true, '/app')).toBe(
			'/other/users',
		)
	})

	it('does not strip a base that only shares a string prefix, not a path segment', () => {
		expect(resolveLocationPath({ hash: '', pathname: '/apple/users' }, true, '/app')).toBe(
			'/apple/users',
		)
	})
})

describe('findAnchor', () => {
	it('finds an anchor that is the event target itself', () => {
		const anchor = document.createElement('a')
		anchor.href = '/x'
		document.body.append(anchor)
		try {
			let found: HTMLAnchorElement | undefined
			anchor.addEventListener('click', (inner) => {
				found = findAnchor(inner)
			})
			safeClick(anchor)
			expect(found).toBe(anchor)
		} finally {
			anchor.remove()
		}
	})

	it('finds an enclosing anchor when the click lands on a nested child', () => {
		const anchor = document.createElement('a')
		anchor.href = '/x'
		const child = document.createElement('span')
		anchor.append(child)
		document.body.append(anchor)
		try {
			let found: HTMLAnchorElement | undefined
			document.addEventListener('click', (inner) => {
				found = findAnchor(inner)
			})
			safeClick(child)
			expect(found).toBe(anchor)
		} finally {
			anchor.remove()
		}
	})

	it('returns undefined when no anchor is on the composed path', () => {
		const div = document.createElement('div')
		document.body.append(div)
		try {
			const results: (HTMLAnchorElement | undefined)[] = []
			document.addEventListener('click', (inner) => {
				results.push(findAnchor(inner))
			})
			safeClick(div)
			expect(results).toEqual([undefined])
		} finally {
			div.remove()
		}
	})
})
