import { describe, expect, it } from 'vitest'
import { parseMethod } from '../../../src/core/parsers.js'
import { METHOD_LIST } from '../../../src/core/constants.js'

// §16 mirror of `src/core/parsers.ts` — pins the raw-method narrowing leaf:
// every registrable verb narrows, an unknown verb and the wrong casing both
// resolve to `undefined`, and the accepted set is exactly `METHOD_LIST` so a
// verb added to the constant cannot leave this coercer behind.

describe('parseMethod', () => {
	it('narrows every one of the seven registrable methods', () => {
		expect(parseMethod('GET')).toBe('GET')
		expect(parseMethod('POST')).toBe('POST')
		expect(parseMethod('PUT')).toBe('PUT')
		expect(parseMethod('PATCH')).toBe('PATCH')
		expect(parseMethod('DELETE')).toBe('DELETE')
		expect(parseMethod('HEAD')).toBe('HEAD')
		expect(parseMethod('OPTIONS')).toBe('OPTIONS')
	})

	it('returns undefined for an unknown verb', () => {
		expect(parseMethod('PURGE')).toBeUndefined()
	})

	it('is case-sensitive — a lowercase verb does not match', () => {
		expect(parseMethod('get')).toBeUndefined()
	})

	it('accepts exactly the methods METHOD_LIST declares', () => {
		expect(METHOD_LIST.map((method) => parseMethod(method))).toEqual([...METHOD_LIST])
	})
})
