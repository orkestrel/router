import { describe, expect, it } from 'vitest'
import { createTestBody } from './setup.js'

describe('createTestBody', () => {
	it('produces exactly the requested chunk count before closing, pulling the passed bytes each time', async () => {
		const chunk = new Uint8Array([1, 2, 3])
		const fixture = createTestBody(chunk, 3)
		const reader = fixture.body.getReader()
		const seen: Uint8Array[] = []
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			seen.push(value)
		}
		expect(seen).toHaveLength(3)
		for (const value of seen) expect(value).toEqual(chunk)
		expect(fixture.pulls).toBe(3)
	})

	it('reports a live pull total that grows as the stream is consumed, not only after it is fully drained', async () => {
		const chunk = new Uint8Array([9])
		const fixture = createTestBody(chunk, 2)
		expect(fixture.pulls).toBe(0)
		const reader = fixture.body.getReader()
		await reader.read()
		expect(fixture.pulls).toBe(1)
		await reader.read()
		expect(fixture.pulls).toBe(2)
	})
})
