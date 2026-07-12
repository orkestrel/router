import { describe, expect, expectTypeOf, it } from 'vitest'
import type { GroupInterface } from '../../../src/core/types.js'
import { Group } from '../../../src/core/Group.js'
import { Router } from '../../../src/core/Router.js'

// §16 mirror of `src/core/Group.ts` — the prefix-scoped registration handle
// split out of `Router.ts` (§5 one-class-per-file): prefix composition,
// nesting, batch registration, dedup-key collision across differently-nested
// group chains, direct construction, and `GroupInterface` member shape.

interface PageMeta {
	readonly page: string
}

describe('Group — direct construction', () => {
	it('constructs directly over a parent RouterInterface and forwards add()', () => {
		const router = new Router<PageMeta>()
		const group = new Group<PageMeta>(router, '/api')
		expect(group.prefix).toBe('/api')
		group.add({ path: '/users', meta: { page: 'list' } })
		expect(router.match('/api/users')?.meta.page).toBe('list')
	})
})

describe('Router — group(prefix) registration', () => {
	it('prepends the group prefix to every route added through it', () => {
		const router = new Router<PageMeta>()
		const api = router.group('/api')
		api.add({ path: '/users', meta: { page: 'list' } })
		expect(router.entries().map((entry) => entry.path)).toEqual(['/api/users'])
		expect(router.match('/api/users')?.meta.page).toBe('list')
	})

	it('registers a batch through the group (§9.2 array overload)', () => {
		const router = new Router<PageMeta>()
		const api = router.group('/api')
		api.add([
			{ path: '/a', meta: { page: 'a' } },
			{ path: '/b', meta: { page: 'b' } },
		])
		expect(router.entries().map((entry) => entry.path)).toEqual(['/api/a', '/api/b'])
	})

	it('nested groups concatenate prefixes', () => {
		const router = new Router<PageMeta>()
		const api = router.group('/api')
		const v1 = api.group('/v1')
		v1.add({ path: '/users', meta: { page: 'list' } })
		expect(router.match('/api/v1/users')?.meta.page).toBe('list')
	})

	it('a group is sugar over the SAME registry — grouped routes count toward the parent', () => {
		const router = new Router<PageMeta>()
		const api = router.group('/api')
		api.add({ path: '/users', meta: { page: 'list' } })
		expect(router.count).toBe(1)
	})
})

describe('Router — dedup-key collision across group prefixes', () => {
	it('two differently-nested group chains composing the SAME final path collide on a path-based key', () => {
		const router = new Router<PageMeta>({ key: (entry) => entry.path })
		const flat = router.group('/api/v1')
		const nested = router.group('/api').group('/v1')
		// `joinPaths` is pure string composition — a flat group and a nested group
		// chain that resolve to the identical final path collide on the same dedup key.
		flat.add({ path: '/users', meta: { page: 'first' } })
		nested.add({ path: '/users', meta: { page: 'second' } })
		expect(router.count).toBe(1)
		expect(router.match('/api/v1/users')?.meta.page).toBe('second')
	})
})

describe('GroupInterface — member shape', () => {
	it('exposes prefix, add, group on GroupInterface', () => {
		expectTypeOf<GroupInterface<PageMeta>>().toHaveProperty('prefix')
		expectTypeOf<GroupInterface<PageMeta>['add']>().toBeFunction()
		expectTypeOf<GroupInterface<PageMeta>['group']>().toBeFunction()
	})
})
