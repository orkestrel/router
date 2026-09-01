import { describe, expect, it } from 'vitest'
import { isEncryptedSocket } from '../../../src/server/validators.js'

// §16 mirror of `src/server/validators.ts` — pins the TLS-socket narrow that
// picks `buildRequest`'s derived scheme, including its totality off-shape.

describe('isEncryptedSocket', () => {
	it('returns true for a value carrying a truthy encrypted property', () => {
		expect(isEncryptedSocket({ encrypted: true })).toBe(true)
	})

	it('returns false for a value with no encrypted property', () => {
		expect(isEncryptedSocket({})).toBe(false)
	})

	it('returns false for non-record values without throwing', () => {
		expect(isEncryptedSocket(null)).toBe(false)
		expect(isEncryptedSocket(undefined)).toBe(false)
		expect(isEncryptedSocket('socket')).toBe(false)
		expect(isEncryptedSocket(42)).toBe(false)
	})
})
