import type { GroupInterface, RouteEntry, RouterInterface } from './types.js'
import { joinPaths } from './helpers.js'

/**
 * A prefix-scoped registration handle over a {@link import('./Router.js').Router} —
 * pure string composition (AGENTS §4.2.2), no independent state or storage.
 *
 * @typeParam Meta - The entry payload type, matching the owning router
 *
 * @remarks
 * Every `add` composes `entry.path` as `joinPaths(prefix, entry.path)` and
 * forwards to the OWNING router, so grouped routes land in the SAME registry.
 * `group(prefix)` nests, composing prefixes via {@link joinPaths}.
 *
 * @example
 * ```ts
 * import { Router } from '@src/core'
 *
 * const router = new Router<{ readonly page: string }>()
 * const api = router.group('/api')
 * api.add({ path: '/users', meta: { page: 'list' } })
 * router.match('/api/users')?.path // '/api/users'
 * ```
 */
export class Group<Meta> implements GroupInterface<Meta> {
	readonly prefix: string
	readonly #parent: RouterInterface<Meta>

	constructor(parent: RouterInterface<Meta>, prefix: string) {
		this.#parent = parent
		this.prefix = prefix
	}

	add(entry: RouteEntry<Meta>): void
	add(entries: readonly RouteEntry<Meta>[]): void
	add(input: RouteEntry<Meta> | readonly RouteEntry<Meta>[]): void {
		const inputs = Array.isArray(input) ? input : [input]
		this.#parent.add(
			inputs.map((entry) => ({ ...entry, path: joinPaths(this.prefix, entry.path) })),
		)
	}

	group(prefix: string): GroupInterface<Meta> {
		return new Group<Meta>(this.#parent, joinPaths(this.prefix, prefix))
	}
}
