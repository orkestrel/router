import { describe, expect, expectTypeOf, it } from 'vitest'
import type { PathParams, RouterInterface } from '../../../src/core/types.js'
import { createRouter } from '../../../src/core/factories.js'
import { Router } from '../../../src/core/Router.js'

// §16 mirror of `src/core/Router.ts` — pins the registry + most-specific-match scan and the
// `answers` override seam (ported from the old `RouteMatcher` acceptance spec, adapted to the
// `/`-prefixed grammar), PLUS the two promotions: dedup via `key` (replace-in-place) and
// `group(prefix)` prefix composition.

// A method-dimensioned meta (the Dispatcher's shape) — `answers` reads `method`.
interface MethodMeta {
	readonly method: 'GET' | 'POST'
	readonly tag: string
}

// A method-less meta (the Navigator's shape) — `answers` is omitted.
interface PageMeta {
	readonly page: string
}

describe('Router — registration', () => {
	it('starts empty and counts registered entries', () => {
		const router = new Router<PageMeta>()
		expect(router.count).toBe(0)
		router.add({ path: '/a', meta: { page: 'a' } })
		expect(router.count).toBe(1)
	})

	it('registers a batch (the §9.2 array overload)', () => {
		const router = new Router<PageMeta>()
		router.add([
			{ path: '/a', meta: { page: 'a' } },
			{ path: '/b', meta: { page: 'b' } },
		])
		expect(router.count).toBe(2)
	})

	it('keeps EVERY entry it is given when no `key` option is set', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/a', meta: { page: 'first' } })
		router.add({ path: '/a', meta: { page: 'second' } })
		expect(router.count).toBe(2)
	})

	it('seeds from constructor options', () => {
		const router = new Router<PageMeta>({
			entries: [{ path: '/seed', meta: { page: 'seed' } }],
		})
		expect(router.count).toBe(1)
		expect(router.match('/seed')?.meta.page).toBe('seed')
	})

	it('clear() drops every entry, leaving the router reusable', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/a', meta: { page: 'a' } })
		router.clear()
		expect(router.count).toBe(0)
		expect(router.match('/a')).toBeUndefined()
		router.add({ path: '/b', meta: { page: 'b' } })
		expect(router.match('/b')?.meta.page).toBe('b')
	})

	it('throws TypeError when path is not a string', () => {
		const router = new Router<PageMeta>()
		// A malformed registration input, arriving the way it would from an untyped boundary
		// (parsed JSON) — `JSON.parse` returns `unknown`-widened `any`, so assigning it to the
		// declared `string` type below needs no `as` (the value is genuinely a runtime `number`).
		const malformedPath: string = JSON.parse('7')
		expect(() => router.add({ path: malformedPath, meta: { page: 'a' } })).toThrow(TypeError)
	})

	it('throws TypeError when path does not start with "/"', () => {
		const router = new Router<PageMeta>()
		expect(() => router.add({ path: 'users', meta: { page: 'a' } })).toThrow(TypeError)
	})
})

describe('Router — match (method-less / Navigator consumer, no `answers`)', () => {
	it('returns the matched entry pattern, decoded params, and meta on a hit', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/users/:id', meta: { page: 'profile' } })
		expect(router.match('/users/7')).toEqual({
			path: '/users/:id',
			meta: { page: 'profile' },
			params: { id: '7' },
			name: undefined,
		})
	})

	it('returns undefined on a miss', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/users/:id', meta: { page: 'profile' } })
		expect(router.match('/posts/7')).toBeUndefined()
	})

	it('returns an empty params record for a parameterless match', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/about', meta: { page: 'about' } })
		expect(router.match('/about')?.params).toEqual({})
	})

	it('matches with trailing-slash insensitivity, root `/` exempt', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/users', meta: { page: 'list' } })
		router.add({ path: '/', meta: { page: 'home' } })
		expect(router.match('/users')?.meta.page).toBe('list')
		expect(router.match('/users/')?.meta.page).toBe('list')
		expect(router.match('/')?.meta.page).toBe('home')
		expect(router.match('')).toBeUndefined()
	})

	it('carries the optional `name` through onto the match', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/users/:id', meta: { page: 'profile' }, name: 'user-profile' })
		expect(router.match('/users/7')?.name).toBe('user-profile')
	})
})

describe('Router — literal-over-param precedence is ORDER-INDEPENDENT', () => {
	it('picks the literal `/users/me` when `:id` was registered FIRST', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/users/:id', meta: { page: 'profile' } })
		router.add({ path: '/users/me', meta: { page: 'self' } })
		expect(router.match('/users/me')?.meta.page).toBe('self')
		expect(router.match('/users/7')?.meta.page).toBe('profile')
	})

	it('picks the literal `/users/me` when `:id` was registered LAST', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/users/me', meta: { page: 'self' } })
		router.add({ path: '/users/:id', meta: { page: 'profile' } })
		expect(router.match('/users/me')?.meta.page).toBe('self')
		expect(router.match('/users/7')?.meta.page).toBe('profile')
	})

	it('resolves precedence at the EARLIEST differing segment', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/:section/list', meta: { page: 'dynamic' } })
		router.add({ path: '/users/:rest', meta: { page: 'literal-first' } })
		expect(router.match('/users/list')?.meta.page).toBe('literal-first')
	})
})

describe('Router — wildcard matching and static > param > wildcard precedence', () => {
	it('matches a wildcard, capturing the rest of the path including slashes', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/files/*rest', meta: { page: 'file' } })
		expect(router.match('/files/a/b/c.png')?.params).toEqual({ rest: 'a/b/c.png' })
	})

	it('ranks a literal above a param above a wildcard at the same position', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/users/*rest', meta: { page: 'catch-all' } })
		router.add({ path: '/users/:id', meta: { page: 'profile' } })
		router.add({ path: '/users/me', meta: { page: 'self' } })
		expect(router.match('/users/me')?.meta.page).toBe('self')
		expect(router.match('/users/7')?.meta.page).toBe('profile')
		expect(router.match('/users/7/edit')?.meta.page).toBe('catch-all')
	})
})

describe('Router — the `answers` override seam (method-dimensioned / Dispatcher consumer)', () => {
	const byMethod =
		(method: MethodMeta['method']) =>
		(meta: MethodMeta): boolean =>
			meta.method === method

	it('filters candidates by the predicate before matching the path', () => {
		const router = new Router<MethodMeta>()
		router.add({ path: '/users', meta: { method: 'GET', tag: 'read' } })
		router.add({ path: '/users', meta: { method: 'POST', tag: 'create' } })
		expect(router.match('/users', byMethod('GET'))?.meta.tag).toBe('read')
		expect(router.match('/users', byMethod('POST'))?.meta.tag).toBe('create')
	})

	it('returns undefined when the path matches but no entry answers', () => {
		const router = new Router<MethodMeta>()
		router.add({ path: '/users', meta: { method: 'GET', tag: 'read' } })
		expect(router.match('/users', byMethod('POST'))).toBeUndefined()
	})

	it('still applies specificity AMONG the answering candidates', () => {
		const router = new Router<MethodMeta>()
		router.add({ path: '/users/:id', meta: { method: 'GET', tag: 'profile' } })
		router.add({ path: '/users/me', meta: { method: 'GET', tag: 'self' } })
		router.add({ path: '/users/me', meta: { method: 'POST', tag: 'update-self' } })
		expect(router.match('/users/me', byMethod('GET'))?.meta.tag).toBe('self')
		expect(router.match('/users/me', byMethod('POST'))?.meta.tag).toBe('update-self')
	})

	it('without `answers`, every entry answers (the always-answers case)', () => {
		const router = new Router<MethodMeta>()
		router.add({ path: '/users', meta: { method: 'GET', tag: 'read' } })
		router.add({ path: '/users', meta: { method: 'POST', tag: 'create' } })
		expect(router.match('/users')?.meta.tag).toBe('read')
	})
})

describe('Router — entries() accessor', () => {
	it('lists all registered entries in registration order', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/a', meta: { page: 'a' } })
		router.add({ path: '/b', meta: { page: 'b' } })
		expect(router.entries().map((entry) => entry.path)).toEqual(['/a', '/b'])
	})

	it('returns a COPY — mutating the result never touches the registry', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/a', meta: { page: 'a' } })
		const list = router.entries()
		expect(Array.isArray(list)).toBe(true)
		expect(list).not.toBe(router.entries())
	})

	it('entries(pathname) returns only path-matching entries (regardless of meta)', () => {
		const router = new Router<MethodMeta>()
		router.add({ path: '/users', meta: { method: 'GET', tag: 'read' } })
		router.add({ path: '/users', meta: { method: 'POST', tag: 'create' } })
		router.add({ path: '/posts', meta: { method: 'GET', tag: 'posts' } })
		const matched = router.entries('/users')
		expect(matched.map((entry) => entry.meta.method).sort()).toEqual(['GET', 'POST'])
	})

	it('entries(pathname) is empty when the path matches nothing', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/users', meta: { page: 'list' } })
		expect(router.entries('/nope')).toEqual([])
	})
})

describe('Router — dedup via `key` (replace-in-place, last write wins)', () => {
	it('replaces the entry in place at the existing index, keeping count stable', () => {
		const router = new Router<PageMeta>({ key: (entry) => entry.path })
		router.add({ path: '/users', meta: { page: 'first' } })
		router.add({ path: '/posts', meta: { page: 'posts' } })
		router.add({ path: '/users', meta: { page: 'second' } })
		expect(router.count).toBe(2)
		expect(router.entries().map((entry) => entry.path)).toEqual(['/users', '/posts'])
	})

	it('the new meta wins and the old meta never matches again', () => {
		const router = new Router<PageMeta>({ key: (entry) => entry.path })
		router.add({ path: '/users', meta: { page: 'first' } })
		router.add({ path: '/users', meta: { page: 'second' } })
		expect(router.match('/users')?.meta.page).toBe('second')
	})

	it('dedups by a computed key that is not the bare path', () => {
		const router = new Router<MethodMeta>({ key: (entry) => `${entry.meta.method} ${entry.path}` })
		router.add({ path: '/users', meta: { method: 'GET', tag: 'first' } })
		router.add({ path: '/users', meta: { method: 'POST', tag: 'create' } })
		router.add({ path: '/users', meta: { method: 'GET', tag: 'second' } })
		expect(router.count).toBe(2)
		expect(router.match('/users', (meta) => meta.method === 'GET')?.meta.tag).toBe('second')
		expect(router.match('/users', (meta) => meta.method === 'POST')?.meta.tag).toBe('create')
	})

	it('keeps every entry when `key` is omitted (old engine semantics)', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/users', meta: { page: 'first' } })
		router.add({ path: '/users', meta: { page: 'second' } })
		expect(router.count).toBe(2)
	})
})

describe('Router — case sensitivity', () => {
	it('matches case-sensitively by default (`sensitive: true`)', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/Users', meta: { page: 'list' } })
		expect(router.match('/users')).toBeUndefined()
		expect(router.match('/Users')?.meta.page).toBe('list')
	})

	it('matches case-insensitively when `sensitive: false`', () => {
		const router = new Router<PageMeta>({ sensitive: false })
		router.add({ path: '/Users', meta: { page: 'list' } })
		expect(router.match('/users')?.meta.page).toBe('list')
		expect(router.match('/USERS')?.meta.page).toBe('list')
	})
})

describe('Router — implements RouterInterface', () => {
	it('is assignable to the public interface', () => {
		const router: RouterInterface<PageMeta> = new Router<PageMeta>()
		router.add({ path: '/a', meta: { page: 'a' } })
		expect(router.match('/a')?.meta.page).toBe('a')
	})
})

describe('createRouter — factory return type', () => {
	it('returns a Router instance implementing RouterInterface', () => {
		const router = createRouter<PageMeta>()
		expect(router).toBeInstanceOf(Router)
		router.add({ path: '/a', meta: { page: 'a' } })
		expect(router.match('/a')?.meta.page).toBe('a')
	})
})

describe('PathParams — type-level inference matrix', () => {
	it('extracts multiple :name segments into a record of their names', () => {
		expectTypeOf<PathParams<'/users/:id/posts/:slug'>>().toEqualTypeOf<{
			readonly id: string
			readonly slug: string
		}>()
	})

	it('extracts a single :name segment', () => {
		expectTypeOf<PathParams<'/users/:id'>>().toEqualTypeOf<{ readonly id: string }>()
	})

	it('extracts a trailing *name wildcard segment', () => {
		expectTypeOf<PathParams<'/files/*rest'>>().toEqualTypeOf<{ readonly rest: string }>()
	})

	it('resolves a parameterless path to an empty record', () => {
		// The mapped-type wrapper around `Record<string, never>` is mutually assignable with it
		// but not identical by expect-type's strict `toEqualTypeOf` — assert both directions.
		expectTypeOf<PathParams<'/health'>>().toExtend<Record<string, never>>()
		expectTypeOf<Record<string, never>>().toExtend<PathParams<'/health'>>()
	})

	it('resolves the root path to an empty record', () => {
		expectTypeOf<PathParams<'/'>>().toExtend<Record<string, never>>()
		expectTypeOf<Record<string, never>>().toExtend<PathParams<'/'>>()
	})

	it('combines a leading param with a trailing wildcard', () => {
		expectTypeOf<PathParams<'/users/:id/files/*rest'>>().toEqualTypeOf<{
			readonly id: string
			readonly rest: string
		}>()
	})

	it('captures only the identifier head of a :name param, stopping before a literal suffix', () => {
		expectTypeOf<PathParams<'/files/:name.json'>>().toEqualTypeOf<{ readonly name: string }>()
	})

	it('contributes no param for a segment whose ":" is not at the segment start ("a:b")', () => {
		expectTypeOf<PathParams<'/a:b/users'>>().toExtend<Record<string, never>>()
		expectTypeOf<Record<string, never>>().toExtend<PathParams<'/a:b/users'>>()
	})
})

describe('RouterInterface — member shape', () => {
	it('exposes count, add, match, entries, group, clear on RouterInterface', () => {
		expectTypeOf<RouterInterface<PageMeta>>().toHaveProperty('count')
		expectTypeOf<RouterInterface<PageMeta>['add']>().toBeFunction()
		expectTypeOf<RouterInterface<PageMeta>['match']>().toBeFunction()
		expectTypeOf<RouterInterface<PageMeta>['entries']>().toBeFunction()
		expectTypeOf<RouterInterface<PageMeta>['group']>().toBeFunction()
		expectTypeOf<RouterInterface<PageMeta>['clear']>().toBeFunction()
	})
})

describe('Router — adversarial hostile pathnames', () => {
	it('keeps an encoded slash (%2F) inside a single :param segment rather than splitting it', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/files/:name', meta: { page: 'file' } })
		expect(router.match('/files/a%2Fb')?.params).toEqual({ name: 'a/b' })
	})

	it('tolerates a malformed percent-escape in the pathname without throwing', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/files/:name', meta: { page: 'file' } })
		expect(() => router.match('/files/%')).not.toThrow()
		expect(router.match('/files/%')?.params).toEqual({ name: '%' })
	})

	it('does not match a pathname with an empty interior segment ("//")', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/users/:id', meta: { page: 'user' } })
		expect(router.match('/users//')).toBeUndefined()
	})

	it('matches a very long pathname without throwing or hanging', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/files/:name', meta: { page: 'file' } })
		const long = 'x'.repeat(5000)
		expect(router.match(`/files/${long}`)?.params).toEqual({ name: long })
	})

	it('matches a unicode path segment as a literal', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/café', meta: { page: 'cafe' } })
		expect(router.match('/café')?.meta.page).toBe('cafe')
	})

	it('captures a unicode value in a :param segment', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/users/:name', meta: { page: 'user' } })
		expect(router.match('/users/日本語')?.params).toEqual({ name: '日本語' })
	})
})

describe('Router — regex-metacharacter literals matched literally, not as regex syntax', () => {
	it('matches a literal segment containing "." exactly, never as a wildcard character', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/files/report.json', meta: { page: 'report' } })
		expect(router.match('/files/reportXjson')).toBeUndefined()
		expect(router.match('/files/report.json')?.meta.page).toBe('report')
	})

	it('matches a literal segment containing "+" and "(" exactly', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/a+b/(c)', meta: { page: 'metachars' } })
		expect(router.match('/a+b/(c)')?.meta.page).toBe('metachars')
		expect(router.match('/ab/c')).toBeUndefined()
	})
})

describe('Router — wildcard + trailing-slash interplay', () => {
	it('captures an empty-string rest is NOT possible — a bare wildcard prefix requires a segment', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/files/*rest', meta: { page: 'file' } })
		expect(router.match('/files')).toBeUndefined()
	})

	it('captures the rest including a trailing slash on the request path', () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/files/*rest', meta: { page: 'file' } })
		expect(router.match('/files/a/b/')?.params).toEqual({ rest: 'a/b/' })
	})

	it(`folds the wildcard pattern's own registered trailing slash the same as any other pattern`, () => {
		const router = new Router<PageMeta>()
		router.add({ path: '/files/*rest/', meta: { page: 'file' } })
		expect(router.match('/files/a/b.png')?.params).toEqual({ rest: 'a/b.png' })
	})
})

describe('Router — answers-seam filtering leaves specificity intact', () => {
	const byTag =
		(tag: string) =>
		(meta: MethodMeta): boolean =>
			meta.tag === tag

	it('still ranks literal over param over wildcard among only the answering candidates', () => {
		const router = new Router<MethodMeta>()
		router.add({ path: '/users/*rest', meta: { method: 'GET', tag: 'shared' } })
		router.add({ path: '/users/:id', meta: { method: 'GET', tag: 'shared' } })
		router.add({ path: '/users/me', meta: { method: 'GET', tag: 'shared' } })
		router.add({ path: '/users/me', meta: { method: 'POST', tag: 'other' } })
		expect(router.match('/users/me', byTag('shared'))?.path).toBe('/users/me')
		expect(router.match('/users/7', byTag('shared'))?.path).toBe('/users/:id')
	})
})

// ── Cross-face grammar parity fixture (§8 "similar surface" pin) ────────────
//
// The SAME route table is driven through `Router.match` (here), `Dispatcher.match`
// (core/Dispatcher.test.ts), and `Navigator.match` (browser/Navigator.test.ts) — one
// one `it` case per face, asserting the shared grammar resolves identically everywhere. The
// table is a tiny local constant (not a shared setup helper, per this unit's file
// ownership) duplicated verbatim across the three files.
const CROSS_FACE_TABLE = [
	{ pattern: '/users/:id', request: '/users/7', params: { id: '7' } },
	{ pattern: '/users/me', request: '/users/me', params: {} },
	{ pattern: '/files/*rest', request: '/files/a/b.png', params: { rest: 'a/b.png' } },
	{ pattern: '/about', request: '/about/', params: {} },
] as const

describe('Router — cross-face grammar parity fixture', () => {
	it('resolves every fixture case to its expected pattern + params', () => {
		const router = new Router<PageMeta>()
		router.add(CROSS_FACE_TABLE.map((row) => ({ path: row.pattern, meta: { page: row.pattern } })))
		for (const row of CROSS_FACE_TABLE) {
			const match = router.match(row.request)
			expect(match?.path).toBe(row.pattern)
			expect(match?.params).toEqual(row.params)
		}
	})
})
