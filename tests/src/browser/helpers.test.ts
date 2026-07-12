import { describe, expect, it } from 'vitest'
import { findAnchor, hashPath, locationPath } from '../../../src/browser/helpers.js'
import { safeClick } from '../../setupBrowser.js'

// §16 mirror of `src/browser/helpers.ts` — the pure browser-navigation primitives:
// hash → pathname extraction, current-location resolution across both navigation
// modes, and the click-event → anchor lookup that backs link interception.

describe('hashPath', () => {
	it('extracts the /-prefixed pathname from a #/… hash', () => {
		expect(hashPath('#/users/7')).toBe('/users/7')
	})

	it('drops a trailing ?query suffix', () => {
		expect(hashPath('#/users/7?x')).toBe('/users/7')
	})

	it('drops a ?query suffix with no path segments beyond the leading slash', () => {
		expect(hashPath('#/?x=1')).toBe('/')
	})

	it('returns an empty string for an empty hash', () => {
		expect(hashPath('')).toBe('')
	})

	it('returns an empty string for a hash not starting with #/', () => {
		expect(hashPath('#other')).toBe('')
	})

	it('returns an empty string for a bare #', () => {
		expect(hashPath('#')).toBe('')
	})
})

describe('locationPath — hash mode', () => {
	it('delegates to hashPath, ignoring pathname', () => {
		expect(locationPath({ hash: '#/tokens', pathname: '/should-be-ignored' }, 'hash')).toBe(
			'/tokens',
		)
	})

	it('returns an empty string for a non-route hash', () => {
		expect(locationPath({ hash: '', pathname: '/anything' }, 'hash')).toBe('')
	})
})

describe('locationPath — history mode', () => {
	it('returns the pathname unchanged with no base configured', () => {
		expect(locationPath({ hash: '', pathname: '/users/7' }, 'history')).toBe('/users/7')
	})

	it('returns the pathname unchanged when base is an empty string', () => {
		expect(locationPath({ hash: '', pathname: '/users/7' }, 'history', '')).toBe('/users/7')
	})

	it('strips a matching base prefix', () => {
		expect(locationPath({ hash: '', pathname: '/app/users/7' }, 'history', '/app')).toBe('/users/7')
	})

	it('strips a base prefix that ends with a trailing slash', () => {
		expect(locationPath({ hash: '', pathname: '/app/users/7' }, 'history', '/app/')).toBe(
			'/users/7',
		)
	})

	it('maps the bare base pathname to the root', () => {
		expect(locationPath({ hash: '', pathname: '/app' }, 'history', '/app')).toBe('/')
	})

	it('returns the pathname unchanged when it does not start with base', () => {
		expect(locationPath({ hash: '', pathname: '/other/users' }, 'history', '/app')).toBe(
			'/other/users',
		)
	})

	it('does not strip a base that only shares a string prefix, not a path segment', () => {
		expect(locationPath({ hash: '', pathname: '/apple/users' }, 'history', '/app')).toBe(
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
