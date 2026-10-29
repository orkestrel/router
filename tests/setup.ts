import type { DispatchResult, RouteHandler } from '../src/core/types.js'
import { afterEach, expectTypeOf, vi } from 'vitest'

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

/** Represents a finite counting `ReadableStream` fixture and its observed pull total. */
export interface TestBodyInterface {
	readonly body: ReadableStream<Uint8Array>
	readonly pulls: number
}

/** Counts pulls made by one stream fixture. */
export class TestPullCounter {
	#count = 0

	get count(): number {
		return this.#count
	}

	advance(): number {
		return ++this.#count
	}
}

/**
 * Creates a finite byte stream that records each pull from its consumer.
 *
 * @param chunk - The bytes to enqueue for each pull
 * @param count - The number of chunks to produce before closing
 * @returns A stream fixture exposing the body and its current pull total
 */
export function createTestBody(chunk: Uint8Array, count: number): TestBodyInterface {
	const pulls = new TestPullCounter()
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const pulled = pulls.advance()
			controller.enqueue(chunk)
			if (pulled === count) controller.close()
		},
	})
	return {
		body,
		get pulls() {
			return pulls.count
		},
	}
}

/** Describes the state carried through a dispatcher scenario. */
export interface AppState {
	readonly userId: string
}

/** Returns a route parameter while checking its inferred context. */
export const handleParams: RouteHandler<'/users/:id/posts/:slug'> = (_request, context) => {
	expectTypeOf(context.params).toEqualTypeOf<{ readonly id: string; readonly slug: string }>()
	return new Response(context.params.id)
}

/** Returns the user identifier while checking its inferred state. */
export const handleState: RouteHandler<'/health', AppState> = (_request, context) => {
	expectTypeOf(context.state).toEqualTypeOf<AppState>()
	return new Response(context.state.userId)
}

/** Requires a matched dispatch result and returns its narrowed value. */
export function matchedResult<TState>(
	result: DispatchResult<TState>,
): Extract<DispatchResult<TState>, { readonly status: 'matched' }> {
	if (result.status !== 'matched')
		throw new Error(`expected a "matched" DispatchResult, got "${result.status}"`)
	return result
}

/** Describes method and tag metadata for route matching. */
export interface MethodMeta {
	readonly method: 'GET' | 'POST'
	readonly tag: string
}

/** Creates a predicate selecting a route's method. */
export function matchMethod(method: MethodMeta['method']): (meta: MethodMeta) => boolean {
	return (meta) => meta.method === method
}

/** Creates a predicate selecting a route's tag. */
export function matchTag(tag: string): (meta: MethodMeta) => boolean {
	return (meta) => meta.tag === tag
}
