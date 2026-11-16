import { describe, expect, it } from 'vitest'
import { createDispatcher, encodePath } from '@src/core'
import { PATH_REFUSED } from '../../setup.js'

// The core path grammar on the Chromium host: the host row, and a `|` literal through Chromium's
// URL parser, whose `new URL` and `history.pushState` text is handed to `new Request` and the real
// dispatcher. No fetch, no navigation, and no socket runs; the Node row crosses a real socket.

describe('router path text on Chromium', () => {
	it('F6: the host rewrites exactly the refused code points beyond the encode set', () => {
		const ascii = Array.from({ length: 0x80 }, (_, code) => String.fromCharCode(code))
		const rewritten = ascii.filter((char) => {
			const url = new URL('http://x/')
			url.pathname = `/a${char}b`
			return encodePath(url.pathname) !== encodePath(`/a${char}b`)
		})
		expect(rewritten.toSorted()).toEqual([...PATH_REFUSED].toSorted())
	})

	it('A2: answers `/a|b` with 200 through Chromium URL parsing of `new URL` and `history.pushState`, handed to `new Request`', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/a|b', handler: () => new Response('pipe') })
		const fetched = await dispatcher.handle(
			new Request(new URL('/a|b', window.location.origin)),
			undefined,
		)
		const before = window.location.href
		window.history.pushState(null, '', '/a|b')
		const navigated = await dispatcher.handle(new Request(window.location.href), undefined)
		window.history.replaceState(null, '', before)
		expect([fetched.status, navigated.status]).toEqual([200, 200])
		dispatcher.destroy()
	})
})
