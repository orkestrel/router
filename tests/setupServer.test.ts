import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import {
	countResponseListeners,
	startPausedResponse,
	startServer,
	WORKSPACE_ROOT,
} from './setupServer.js'

describe('WORKSPACE_ROOT', () => {
	it('anchors to the real workspace root, not an arbitrary ancestor', () => {
		expect(existsSync(WORKSPACE_ROOT + '/package.json')).toBe(true)
		expect(existsSync(WORKSPACE_ROOT + '/vite.config.ts')).toBe(true)
	})
})

describe('startServer', () => {
	it('binds a real socket on 127.0.0.1 and serves the passed listener', async () => {
		const server = await startServer((_request, response) => response.end('router-fixture'))
		try {
			expect(server.url.startsWith('http://127.0.0.1:')).toBe(true)
			expect(server.port).toBeGreaterThan(0)
			const response = await fetch(server.url)
			const body = await response.text()
			expect(body).toBe('router-fixture')
		} finally {
			await server.close()
		}
	})

	it('closes the real listening socket, so a request after close is refused', async () => {
		const server = await startServer((_request, response) => response.end('ok'))
		await server.close()
		await expect(fetch(server.url)).rejects.toThrow('fetch failed')
	})
})

describe('startPausedResponse', () => {
	it('returns a response paused before any body bytes are delivered to the client', async () => {
		const fixture = await startPausedResponse((_request, response) => {
			response.write('chunk')
			response.end()
		})
		try {
			expect(fixture.response.readableFlowing).not.toBe(true)
			expect(fixture.server.url.startsWith('http://127.0.0.1:')).toBe(true)
		} finally {
			fixture.request.destroy()
			await fixture.server.close()
		}
	})
})

describe('countResponseListeners', () => {
	it('reads the real listener totals installed on a live response, rising and falling with them', async () => {
		const server = await startServer((_request, response) => {
			const before = countResponseListeners(response)
			const onDrain = () => {}
			response.on('drain', onDrain)
			const after = countResponseListeners(response)
			expect(after.drain).toBe(before.drain + 1)
			response.off('drain', onDrain)
			const restored = countResponseListeners(response)
			expect(restored.drain).toBe(before.drain)
			response.end('done')
		})
		try {
			await fetch(server.url)
		} finally {
			await server.close()
		}
	})
})
