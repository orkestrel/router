import { Socket } from 'node:net'
import { TLSSocket } from 'node:tls'
import { describe, expect, it } from 'vitest'
import { createHostileValues } from '@orkestrel/test'
import { isAuthority, isEncryptedSocket } from '@src/server'

// The test mirror of `src/server/validators.ts` — pins the TLS-socket narrow that
// picks `buildRequest`'s derived scheme, and the authority guard `buildURL` applies to a
// `Host` header and an absolute-form target, each including its totality off-shape.

describe('isEncryptedSocket', () => {
	it('returns true for a value carrying a truthy encrypted property', () => {
		expect(isEncryptedSocket({ encrypted: true })).toBe(true)
	})

	it('returns true for a real TLS socket and false for a real plain socket', () => {
		expect(isEncryptedSocket(new TLSSocket(new Socket()))).toBe(true)
		expect(isEncryptedSocket(new Socket())).toBe(false)
	})

	it('returns false for a value with no encrypted property', () => {
		expect(isEncryptedSocket({})).toBe(false)
	})

	it('returns false for non-record values without throwing', () => {
		expect(isEncryptedSocket(null)).toBe(false)
		expect(isEncryptedSocket(undefined)).toBe(false)
		expect(isEncryptedSocket('socket')).toBe(false)
		expect(isEncryptedSocket(42)).toBe(false)
		expect(createHostileValues().filter((value) => isEncryptedSocket(value))).toEqual([])
	})
})

describe('isAuthority', () => {
	it('accepts a registered name, an IP literal, and either with a port, an empty one included', () => {
		const accepted = [
			'app.local',
			'APP.local',
			'app.local:8080',
			'app.local:',
			'app.local:0',
			'app.local:65535',
			'127.0.0.1',
			'[::1]',
			'[::1]:8080',
			'a%41b',
			"sub-delims!$&'()*+,;=",
		]

		expect(accepted.filter((value) => !isAuthority(value))).toEqual([])
	})

	it('refuses a path, a query, a fragment, userinfo, whitespace, and an out-of-range port', () => {
		const refused = [
			'',
			'app.local/admin',
			'app.local\\admin',
			'app.local?x',
			'app.local#x',
			'user@app.local',
			'user:pass@app.local',
			'app local',
			' app.local',
			'app.local:65536',
			'app.local:-1',
			'app.local:8o',
			'[::1',
			'[zz::1]',
			'[:::::]',
			'a%4',
			'app.lo<cal',
			'ápp.local',
		]

		expect(refused.filter((value) => isAuthority(value))).toEqual([])
	})

	it('returns false for every non-string value without throwing', () => {
		expect(createHostileValues().filter((value) => isAuthority(value))).toEqual([])
		expect(isAuthority(undefined)).toBe(false)
		expect(isAuthority(8080)).toBe(false)
	})
})
