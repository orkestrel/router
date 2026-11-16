import { describe, expect, expectTypeOf, it } from 'vitest'
import type { RouteContext } from '../../../src/core/types.js'
import { ContractError } from '@orkestrel/contract'
import {
	canonicalizePath,
	classifySegment,
	collectInputs,
	compareSpecificity,
	compilePath,
	computeDispatchKey,
	decodeParam,
	defineRoute,
	encodeSegment,
	joinPaths,
	matchPath,
	computeSpecificity,
} from '../../../src/core/helpers.js'

// The test mirror of `src/core/helpers.ts` — pins every pure path-matching primitive:
// compile/match round-trips, `:`/`*` captures, tolerant decode, trailing-slash +
// root exemptions, the case-sensitivity flag, the wildcard-mid-path guard, and
// the specificity classification fix that shares one segment parser with
// `compilePath`.

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

describe('computeDispatchKey', () => {
	it('combines the method with a canonical route path', () => {
		expect(computeDispatchKey({ path: '/users/', meta: { method: 'GET' } })).toBe('GET /users')
	})

	it('keeps registrations for distinct methods separate', () => {
		expect(computeDispatchKey({ path: '/users', meta: { method: 'POST' } })).toBe('POST /users')
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

	it('escapes regex metacharacters in a literal segment with no param', () => {
		const compiled = compilePath('/v1.0/c++')
		expect(compiled.regex.test('/v1.0/c++')).toBe(true)
		expect(compiled.regex.test('/v1x0/c++')).toBe(false)
		expect(compiled.regex.test('/v1.0/cc')).toBe(false)
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

	it('throws a ContractError coded `placement` when a wildcard segment is not the final segment', () => {
		expect(() => compilePath('/files/*rest/more')).toThrow(ContractError)
		expect(() => compilePath('/files/*rest/more')).toThrow(
			expect.objectContaining({ code: 'placement' }),
		)
	})

	it('throws a ContractError for a wildcard mid-path even with a following literal', () => {
		expect(() => compilePath('/*rest/users')).toThrow(ContractError)
		expect(() => compilePath('/*rest/users')).toThrow(
			expect.objectContaining({ code: 'placement' }),
		)
	})

	it('throws a ContractError coded `pattern` for a final wildcard carrying a suffix', () => {
		expect(() => compilePath('/files/*rest.json')).toThrow(
			expect.objectContaining({ code: 'pattern' }),
		)
		expect(compilePath('/files/x*rest.json').params).toEqual([])
	})
})

describe('compilePath — param names', () => {
	it('throws a ContractError coded `literal` for a param named for an Object.prototype key', () => {
		expect(() => compilePath('/x/:__proto__')).toThrow(expect.objectContaining({ code: 'literal' }))
		expect(() => compilePath('/x/:toString.json')).toThrow(
			expect.objectContaining({ code: 'literal' }),
		)
		expect(() => compilePath('/files/*constructor')).toThrow(
			expect.objectContaining({ code: 'literal' }),
		)
		expect(compilePath('/x/:__proto').params).toEqual(['__proto'])
	})

	it('throws a ContractError coded `structure` for a param name used twice', () => {
		expect(() => compilePath('/a/:id/b/:id')).toThrow(
			expect.objectContaining({ code: 'structure' }),
		)
		expect(() => compilePath('/a/:id/*id')).toThrow(expect.objectContaining({ code: 'structure' }))
		expect(compilePath('/a/:id/b/:other').params).toEqual(['id', 'other'])
	})
})

describe('compilePath — encoded literals', () => {
	it('matches a literal against its encoded pathname form, not the raw text', () => {
		const compiled = compilePath('/café/a b')
		expect(compiled.regex.test('/caf%C3%A9/a%20b')).toBe(true)
		expect(compiled.regex.test('/café/a b')).toBe(false)
	})

	it('encodes the literal suffix of a param', () => {
		const compiled = compilePath('/docs/:page.café')
		expect(matchPath(compiled, '/docs/intro.caf%C3%A9')).toEqual({ page: 'intro' })
	})

	it('carries the specificity vector of the canonical pattern', () => {
		expect(compilePath('/files/:name.json/').specificity).toEqual(
			computeSpecificity('/files/:name.json'),
		)
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
	it('ranks a literal-only path as all literal tiers with each literal length', () => {
		expect(computeSpecificity('/users/me')).toEqual([
			{ tier: 2, length: 0 },
			{ tier: 2, length: 5 },
			{ tier: 2, length: 2 },
		])
	})

	it('ranks a param segment at its position, with the length of its suffix', () => {
		expect(computeSpecificity('/users/:id').at(-1)).toEqual({ tier: 1, length: 0 })
		expect(computeSpecificity('/files/:name.json').at(-1)).toEqual({ tier: 1, length: 5 })
	})

	it('ranks a final wildcard segment at its position with no literal length', () => {
		expect(computeSpecificity('/files/*rest').at(-1)).toEqual({ tier: 0, length: 0 })
	})

	it('ranks a literal segment containing a colon mid-string as literal — the classification fix', () => {
		expect(computeSpecificity('/a:b').at(-1)).toEqual({ tier: 2, length: 3 })
	})

	it('measures a literal by its encoded length', () => {
		expect(computeSpecificity('/café').at(-1)).toEqual({ tier: 2, length: 9 })
	})
})

describe('compareSpecificity', () => {
	it('ranks a literal path as more specific than a param path', () => {
		expect(
			compareSpecificity(computeSpecificity('/users/me'), computeSpecificity('/users/:id')),
		).toBeLessThan(0)
	})

	it('ranks a param path as more specific than a wildcard path', () => {
		expect(
			compareSpecificity(computeSpecificity('/users/:id'), computeSpecificity('/users/*rest')),
		).toBeLessThan(0)
	})

	it('is symmetric — the reverse comparison flips sign', () => {
		expect(
			compareSpecificity(computeSpecificity('/users/:id'), computeSpecificity('/users/me')),
		).toBeGreaterThan(0)
	})

	it('returns 0 for equally specific paths', () => {
		expect(
			compareSpecificity(computeSpecificity('/users/:id'), computeSpecificity('/users/:slug')),
		).toBe(0)
	})

	it('resolves at the earliest differing segment', () => {
		expect(
			compareSpecificity(computeSpecificity('/users/list'), computeSpecificity('/:section/list')),
		).toBeLessThan(0)
	})

	it('ranks a longer literal suffix above a shorter one within the same tier', () => {
		const json = computeSpecificity('/files/:name.json')
		const plain = computeSpecificity('/files/:name')
		expect(compareSpecificity(json, plain)).toBeLessThan(0)
		expect(compareSpecificity(plain, json)).toBeGreaterThan(0)
	})

	it('ranks a longer, more-segmented path as more specific than its prefix', () => {
		const longer = computeSpecificity('/users/:id')
		const shorter = computeSpecificity('/users')
		expect(compareSpecificity(longer, shorter)).toBeLessThan(0)
		expect(compareSpecificity(shorter, longer)).toBeGreaterThan(0)
	})
})

describe('encodeSegment', () => {
	it('percent-encodes a non-ASCII character, a space, and the URL path set', () => {
		expect(encodeSegment('café')).toBe('caf%C3%A9')
		expect(encodeSegment('a b')).toBe('a%20b')
		expect(encodeSegment('q?a#b')).toBe('q%3Fa%23b')
		expect(encodeSegment('{c}')).toBe('%7Bc%7D')
	})

	it('leaves path-safe text, regex metacharacters, and an existing `%` unchanged', () => {
		expect(encodeSegment('report.json')).toBe('report.json')
		expect(encodeSegment('(x)|[y]+$')).toBe('(x)|[y]+$')
		expect(encodeSegment('100%')).toBe('100%')
		expect(encodeSegment('us%65rs')).toBe('us%65rs')
	})

	it('keeps a text of `.` or `..` instead of reading it as a dot segment', () => {
		expect(encodeSegment('.')).toBe('.')
		expect(encodeSegment('..')).toBe('..')
		expect(encodeSegment('')).toBe('')
	})
})

describe('collectInputs', () => {
	it('wraps one input in a list and returns a list as it is', () => {
		const list = ['a', 'b']
		expect(collectInputs('a')).toEqual(['a'])
		expect(collectInputs(list)).toBe(list)
		expect(collectInputs([])).toEqual([])
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

describe('defineRoute', () => {
	it('returns its input unchanged (same reference)', () => {
		const input = defineRoute({
			method: 'GET',
			path: '/users/:id',
			handler: (_request: Request, context: RouteContext<'/users/:id'>) =>
				new Response(context.params.id),
		})
		expect(defineRoute(input)).toBe(input)
	})

	it('preserves the literal Path so context.params types correctly at the registration site', () => {
		const input = defineRoute({
			method: 'GET',
			path: '/users/:id',
			handler: (_request, context) => {
				expectTypeOf(context.params).toEqualTypeOf<{ readonly id: string }>()
				const id: string = context.params.id
				return new Response(id)
			},
		})
		expectTypeOf(input.path).toEqualTypeOf<'/users/:id'>()
	})
})
