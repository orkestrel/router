import { describe, expect, it } from 'vitest'
import {
	canonicalizePath,
	classifySegment,
	compareSpecificity,
	compilePath,
	decodeParam,
	escapeRegExp,
	joinPaths,
	matchPath,
	parseMethod,
	computeSpecificity,
} from '../../../src/core/helpers.js'

// §16 mirror of `src/core/helpers.ts` — pins every pure path-matching primitive:
// compile/match round-trips, `:`/`*` captures, tolerant decode, trailing-slash +
// root exemptions, the case-sensitivity flag, the wildcard-mid-path guard, and
// the specificity classification fix (§4) that shares one segment parser with
// `compilePath`.

describe('escapeRegExp', () => {
	it('escapes every regex metacharacter so the result matches only the literal string', () => {
		expect(escapeRegExp('a.b+c')).toBe('a\\.b\\+c')
		expect(new RegExp(`^${escapeRegExp('a.b')}$`).test('a.b')).toBe(true)
		expect(new RegExp(`^${escapeRegExp('a.b')}$`).test('axb')).toBe(false)
	})

	it('returns an unescaped string unchanged when it has no metacharacters', () => {
		expect(escapeRegExp('users')).toBe('users')
	})
})

describe('canonicalizePath', () => {
	it('strips a single trailing slash from a non-root path', () => {
		expect(canonicalizePath('/users/')).toBe('/users')
	})

	it('leaves a path with no trailing slash unchanged', () => {
		expect(canonicalizePath('/users')).toBe('/users')
	})

	it('exempts the root path `/`', () => {
		expect(canonicalizePath('/')).toBe('/')
	})

	it("exempts the empty pattern `''`", () => {
		expect(canonicalizePath('')).toBe('')
	})
})

describe('compilePath — literal + param compile/match round-trips', () => {
	it('compiles a parameterless literal path and matches it exactly', () => {
		const compiled = compilePath('/about')
		expect(compiled.params).toEqual([])
		expect(compiled.regex.test('/about')).toBe(true)
		expect(compiled.regex.test('/about/extra')).toBe(false)
	})

	it('compiles `:name` segments into ordered params and captures them', () => {
		const compiled = compilePath('/users/:id/posts/:slug')
		expect(compiled.params).toEqual(['id', 'slug'])
		const result = compiled.regex.exec('/users/7/posts/hello')
		expect(result?.slice(1)).toEqual(['7', 'hello'])
	})

	it('escapes literal regex metacharacters in the pattern', () => {
		const compiled = compilePath('/files/:name.json')
		expect(compiled.regex.test('/files/a.json')).toBe(true)
		expect(compiled.regex.test('/files/aXjson')).toBe(false)
	})

	it('captures only the identifier head of a :name param, stopping before a literal suffix', () => {
		expect(compilePath('/files/:name.json').params).toEqual(['name'])
	})
})

describe('compilePath — `*name` wildcard captures', () => {
	it('captures the rest of the path including slashes as the final segment', () => {
		const compiled = compilePath('/files/*rest')
		expect(compiled.params).toEqual(['rest'])
		const result = compiled.regex.exec('/files/a/b/c.png')
		expect(result?.[1]).toBe('a/b/c.png')
	})

	it('matches a bare single segment for the wildcard too', () => {
		const compiled = compilePath('/files/*rest')
		expect(compiled.regex.exec('/files/a.png')?.[1]).toBe('a.png')
	})

	it('throws TypeError when a wildcard segment is not the final segment', () => {
		expect(() => compilePath('/files/*rest/more')).toThrow(TypeError)
	})

	it('throws TypeError for a wildcard mid-path even with a following literal', () => {
		expect(() => compilePath('/*rest/users')).toThrow(TypeError)
	})
})

describe('compilePath — trailing slash + root exemptions', () => {
	it("folds the pattern's own trailing slash before compiling", () => {
		const compiled = compilePath('/users/')
		expect(compiled.regex.test('/users')).toBe(true)
	})

	it('makes the request trailing slash optional for a non-root pattern', () => {
		const compiled = compilePath('/users/:id')
		expect(compiled.regex.test('/users/7')).toBe(true)
		expect(compiled.regex.test('/users/7/')).toBe(true)
	})

	it('does not prefix-match — a deeper path is a distinct segment', () => {
		const compiled = compilePath('/api')
		expect(compiled.regex.test('/api/users')).toBe(false)
	})

	it('anchors the root `/` exactly, exempt from the optional-slash suffix', () => {
		const compiled = compilePath('/')
		expect(compiled.regex.test('/')).toBe(true)
		expect(compiled.regex.test('')).toBe(false)
	})

	it('anchors the empty pattern exactly', () => {
		const compiled = compilePath('')
		expect(compiled.regex.test('')).toBe(true)
		expect(compiled.regex.test('/')).toBe(false)
	})
})

describe('compilePath — case sensitivity', () => {
	it('is case-sensitive by default', () => {
		const compiled = compilePath('/Users')
		expect(compiled.regex.test('/users')).toBe(false)
		expect(compiled.regex.test('/Users')).toBe(true)
	})

	it('folds case when sensitive is explicitly false', () => {
		const compiled = compilePath('/Users', false)
		expect(compiled.regex.test('/users')).toBe(true)
		expect(compiled.regex.test('/USERS')).toBe(true)
	})
})

describe('decodeParam', () => {
	it('URL-decodes a percent-encoded value', () => {
		expect(decodeParam('a%2Fb')).toBe('a/b')
		expect(decodeParam('100%25')).toBe('100%')
	})

	it('tolerates a malformed percent-escape, returning the raw value', () => {
		expect(decodeParam('%')).toBe('%')
		expect(decodeParam('%zz')).toBe('%zz')
	})

	it('returns a value with no escapes unchanged', () => {
		expect(decodeParam('plain')).toBe('plain')
	})
})

describe('matchPath', () => {
	it('returns decoded params on a hit', () => {
		const compiled = compilePath('/users/:id')
		expect(matchPath(compiled, '/users/7')).toEqual({ id: '7' })
	})

	it('decodes a percent-encoded captured value', () => {
		const compiled = compilePath('/users/:id')
		expect(matchPath(compiled, '/users/a%2Fb')).toEqual({ id: 'a/b' })
	})

	it('returns undefined on a miss', () => {
		const compiled = compilePath('/users/:id')
		expect(matchPath(compiled, '/posts/7')).toBeUndefined()
	})

	it('returns an empty frozen record for a parameterless match', () => {
		const compiled = compilePath('/about')
		const result = matchPath(compiled, '/about')
		expect(result).toEqual({})
		expect(Object.isFrozen(result)).toBe(true)
	})

	it('captures the wildcard rest segment', () => {
		const compiled = compilePath('/files/*rest')
		expect(matchPath(compiled, '/files/a/b.png')).toEqual({ rest: 'a/b.png' })
	})
})

describe('classifySegment', () => {
	it('classifies a syntactically valid `:name` head as param', () => {
		expect(classifySegment(':id', false)).toBe(1)
		expect(classifySegment(':id', true)).toBe(1)
	})

	it('classifies a final `*name` as wildcard', () => {
		expect(classifySegment('*rest', true)).toBe(0)
	})

	it('classifies a non-final `*name` as literal — wildcard is final-only', () => {
		expect(classifySegment('*rest', false)).toBe(2)
	})

	it("classifies a literal segment that merely CONTAINS a `:` mid-string as literal — the old bug's regression case", () => {
		expect(classifySegment('a:b', true)).toBe(2)
		expect(classifySegment('a:b', false)).toBe(2)
	})

	it('classifies a plain literal segment as literal', () => {
		expect(classifySegment('users', false)).toBe(2)
	})
})

describe('computeSpecificity', () => {
	it('vectors a literal-only path as all literal tiers', () => {
		expect(computeSpecificity('/users/me')).toEqual([2, 2, 2])
	})

	it('vectors a param segment at its position', () => {
		expect(computeSpecificity('/users/:id')).toEqual([2, 2, 1])
	})

	it('vectors a final wildcard segment at its position', () => {
		expect(computeSpecificity('/files/*rest')).toEqual([2, 2, 0])
	})

	it('vectors a literal segment containing a colon mid-string as literal — the classification fix', () => {
		expect(computeSpecificity('/a:b')).toEqual([2, 2])
	})
})

describe('compareSpecificity', () => {
	it('ranks a literal path as more specific than a param path', () => {
		expect(compareSpecificity('/users/me', '/users/:id')).toBeLessThan(0)
	})

	it('ranks a param path as more specific than a wildcard path', () => {
		expect(compareSpecificity('/users/:id', '/users/*rest')).toBeLessThan(0)
	})

	it('is symmetric — the reverse comparison flips sign', () => {
		expect(compareSpecificity('/users/:id', '/users/me')).toBeGreaterThan(0)
	})

	it('returns 0 for equally specific paths', () => {
		expect(compareSpecificity('/users/:id', '/users/:slug')).toBe(0)
	})

	it('resolves at the earliest differing segment', () => {
		expect(compareSpecificity('/users/list', '/:section/list')).toBeLessThan(0)
	})

	it('ranks a longer, more-segmented path as more specific than its prefix', () => {
		expect(compareSpecificity('/users/:id', '/users')).toBeLessThan(0)
		expect(compareSpecificity('/users', '/users/:id')).toBeGreaterThan(0)
	})
})

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
})

describe('joinPaths', () => {
	it('joins a prefix and a path with exactly one slash', () => {
		expect(joinPaths('/api', '/users')).toBe('/api/users')
	})

	it('normalizes a duplicated joining slash', () => {
		expect(joinPaths('/api/', '/users')).toBe('/api/users')
	})

	it('normalizes a missing joining slash', () => {
		expect(joinPaths('/api', 'users')).toBe('/api/users')
	})

	it('returns the path unchanged when the prefix is empty', () => {
		expect(joinPaths('', '/users')).toBe('/users')
	})

	it('adds a leading slash to a path when the prefix is empty and the path lacks one', () => {
		expect(joinPaths('', 'users')).toBe('/users')
	})

	it('returns the prefix unchanged when the path is empty', () => {
		expect(joinPaths('/api', '')).toBe('/api')
	})
})
