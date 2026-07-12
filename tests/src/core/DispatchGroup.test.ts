import { describe, expect, it } from 'vitest'
import { createDispatcher } from '../../../src/core/factories.js'
import { DispatchGroup } from '../../../src/core/DispatchGroup.js'

// §16 mirror of `src/core/DispatchGroup.ts` — the prefix-scoped registration
// handle split out of `Dispatcher.ts` (§5 one-class-per-file): prefix
// composition, nesting, and direct construction.

describe('DispatchGroup — direct construction', () => {
	it('constructs directly over a parent DispatcherInterface and forwards add()', async () => {
		const dispatcher = createDispatcher()
		const group = new DispatchGroup(dispatcher, '/api')
		expect(group.prefix).toBe('/api')
		group.add({ method: 'GET', path: '/status', handler: () => new Response('api status') })
		const response = await dispatcher.handle(new Request('http://x/api/status'), undefined)
		expect(await response.text()).toBe('api status')
		dispatcher.destroy()
	})
})

describe('Dispatcher — group + nested group registration', () => {
	it('registers routes through a group and a nested group with prefixes composed', async () => {
		const dispatcher = createDispatcher()
		const api = dispatcher.group('/api')
		const v1 = api.group('/v1')
		api.add({ method: 'GET', path: '/status', handler: () => new Response('api status') })
		v1.add({ method: 'GET', path: '/users', handler: () => new Response('v1 users') })

		const statusResponse = await dispatcher.handle(new Request('http://x/api/status'), undefined)
		expect(await statusResponse.text()).toBe('api status')

		const usersResponse = await dispatcher.handle(new Request('http://x/api/v1/users'), undefined)
		expect(await usersResponse.text()).toBe('v1 users')
		dispatcher.destroy()
	})
})
