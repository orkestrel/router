import { afterEach, vi } from 'vitest'

// ── Environment-agnostic base setup ───────────────────────────────────────────
//
// Loaded first by every test project (`vite.config.ts` `setupFiles[0]`). Holds
// ONLY helpers with no `node:*` / DOM / Vue dependency, so it is safe for
// `src:core`, `src:browser`, and `src:server` alike. Environment-specific
// helpers live in their own matching setup file (`setupBrowser.ts`,
// `setupServer.ts`).
//
// The fleet-wide helpers live in `@orkestrel/test`. What remains here is what is
// specific to this package.

afterEach(() => {
	vi.restoreAllMocks()
})

/** A finite counting `ReadableStream` fixture and its observed pull total. */
export interface TestBodyInterface {
	readonly body: ReadableStream<Uint8Array>
	readonly pulls: number
}

/**
 * Create a finite byte stream that records each pull from its consumer.
 *
 * @param chunk - The bytes to enqueue for each pull
 * @param count - The number of chunks to produce before closing
 * @returns A stream fixture exposing the body and its current pull total
 */
export function createTestBody(chunk: Uint8Array, count: number): TestBodyInterface {
	let pulls = 0
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulls += 1
			controller.enqueue(chunk)
			if (pulls === count) controller.close()
		},
	})
	return {
		body,
		get pulls() {
			return pulls
		},
	}
}
