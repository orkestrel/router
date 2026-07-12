import type { DispatchGroupInterface, DispatcherInterface, RouteInput } from './types.js'
import { joinPaths } from './helpers.js'

/**
 * A prefix-scoped registration handle over a
 * {@link import('./Dispatcher.js').Dispatcher} — the method-dimensioned
 * counterpart of `Group` (`Group.ts`).
 *
 * @typeParam TState - The consumer's opaque per-request state type, matching
 *   the owning dispatcher
 *
 * @remarks
 * Every `add` composes `input.path` via {@link joinPaths} against
 * `this.prefix` and forwards to the OWNING dispatcher's `add` (its own §14
 * boundary guard still applies). Pure string composition (§4.2.2) — no
 * independent state or storage.
 *
 * @example
 * ```ts
 * import { Dispatcher } from '@src/core'
 *
 * const dispatcher = new Dispatcher()
 * const api = dispatcher.group('/api')
 * api.add({ method: 'GET', path: '/users', handler: () => new Response('ok') })
 * ```
 */
export class DispatchGroup<TState> implements DispatchGroupInterface<TState> {
	readonly prefix: string
	readonly #parent: DispatcherInterface<TState>

	constructor(parent: DispatcherInterface<TState>, prefix: string) {
		this.#parent = parent
		this.prefix = prefix
	}

	add<Path extends string>(input: RouteInput<Path, TState>): void
	add(inputs: readonly RouteInput<string, TState>[]): void
	add(input: RouteInput<string, TState> | readonly RouteInput<string, TState>[]): void {
		const inputs = Array.isArray(input) ? input : [input]
		this.#parent.add(
			inputs.map((route) => ({ ...route, path: joinPaths(this.prefix, route.path) })),
		)
	}

	group(prefix: string): DispatchGroupInterface<TState> {
		return new DispatchGroup<TState>(this.#parent, joinPaths(this.prefix, prefix))
	}
}
