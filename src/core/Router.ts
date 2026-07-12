import type {
	CompiledPath,
	GroupInterface,
	RouteEntry,
	RouterAnswers,
	RouterInterface,
	RouterMatch,
	RouterOptions,
} from './types.js'
import { isString } from '@orkestrel/contract'
import { compareSpecificity, compilePath, joinPaths, matchPath } from './helpers.js'

/**
 * The path-matching + registry engine — registers `{ path, meta, name? }`
 * entries (compiling each path once) and resolves a concrete pathname to the
 * MOST SPECIFIC matching entry. The shared machine both the `Navigator`
 * (browser) and the `Dispatcher` (core, method-dimensioned) compose.
 *
 * @typeParam Meta - The opaque payload each entry carries and a match returns
 *
 * @remarks
 * - **Registration boundary guard (§14).** `add` validates each entry's
 *   `path` — `isString` plus a leading `/` — and throws `TypeError` on a
 *   malformed registration; `match` stays guard-free (the hot path).
 * - **Compile-once.** Each path is compiled exactly once at registration into
 *   a parallel `#compiled` array, so `match` runs only a cached `exec` per
 *   candidate.
 * - **Dedup via `key`.** When `options.key` is set, an entry whose computed
 *   key already exists REPLACES the prior one IN PLACE (both the `#entries`
 *   and `#compiled` arrays, at the existing index) — last write wins, no
 *   engine rebuild. Omitted ⇒ every entry is kept, even duplicate paths.
 * - **Groups.** `group(prefix)` returns a {@link GroupInterface} that composes
 *   `prefix` onto every entry it registers, nesting via {@link joinPaths}.
 *
 * @example
 * ```ts
 * const router = new Router<{ readonly page: string }>()
 * router.add({ path: '/users/:id', meta: { page: 'profile' } })
 * router.match('/users/7') // { path: '/users/:id', params: { id: '7' }, meta: { page: 'profile' } }
 * ```
 */
export class Router<Meta> implements RouterInterface<Meta> {
	readonly #entries: RouteEntry<Meta>[] = []
	readonly #compiled: CompiledPath[] = []
	readonly #sensitive: boolean
	readonly #key: ((entry: RouteEntry<Meta>) => string) | undefined
	readonly #index: Map<string, number> = new Map()

	constructor(options?: RouterOptions<Meta>) {
		this.#sensitive = options?.sensitive ?? true
		this.#key = options?.key
		if (options?.entries !== undefined) this.add(options.entries)
	}

	get count(): number {
		return this.#entries.length
	}

	add(entry: RouteEntry<Meta>): void
	add(entries: readonly RouteEntry<Meta>[]): void
	add(input: RouteEntry<Meta> | readonly RouteEntry<Meta>[]): void {
		const inputs = Array.isArray(input) ? input : [input]
		for (const entry of inputs) this.#register(entry)
	}

	match(pathname: string, answers?: RouterAnswers<Meta>): RouterMatch<Meta> | undefined {
		let best: { entry: RouteEntry<Meta>; params: Readonly<Record<string, string>> } | undefined
		for (let index = 0; index < this.#entries.length; index += 1) {
			const entry = this.#entries[index]
			const compiled = this.#compiled[index]
			if (entry === undefined || compiled === undefined) continue
			if (answers !== undefined && !answers(entry.meta)) continue
			const params = matchPath(compiled, pathname)
			if (params === undefined) continue
			if (best === undefined || compareSpecificity(entry.path, best.entry.path) < 0)
				best = { entry, params }
		}
		if (best === undefined) return undefined
		return {
			path: best.entry.path,
			params: best.params,
			meta: best.entry.meta,
			name: best.entry.name,
		}
	}

	entries(): readonly RouteEntry<Meta>[]
	entries(pathname: string): readonly RouteEntry<Meta>[]
	entries(pathname?: string): readonly RouteEntry<Meta>[] {
		if (pathname === undefined) return [...this.#entries]
		const out: RouteEntry<Meta>[] = []
		for (let index = 0; index < this.#entries.length; index += 1) {
			const entry = this.#entries[index]
			const compiled = this.#compiled[index]
			if (entry === undefined || compiled === undefined) continue
			if (matchPath(compiled, pathname) !== undefined) out.push(entry)
		}
		return out
	}

	group(prefix: string): GroupInterface<Meta> {
		return new Group<Meta>(this, prefix)
	}

	clear(): void {
		this.#entries.length = 0
		this.#compiled.length = 0
		this.#index.clear()
	}

	// Validate the registration boundary (§14: isString + leading '/'), then either replace an
	// existing entry IN PLACE (dedup via `#key`, last write wins) or append a new one — the
	// engine's compile-once invariant, kept in sync across the `#entries`/`#compiled` pair.
	#register(entry: RouteEntry<Meta>): void {
		if (!isString(entry.path) || !entry.path.startsWith('/'))
			throw new TypeError(
				`a route path must be a string starting with "/", got ${JSON.stringify(entry.path)}`,
			)
		const compiled = compilePath(entry.path, this.#sensitive)
		if (this.#key === undefined) {
			this.#entries.push(entry)
			this.#compiled.push(compiled)
			return
		}
		const key = this.#key(entry)
		const existing = this.#index.get(key)
		if (existing !== undefined) {
			this.#entries[existing] = entry
			this.#compiled[existing] = compiled
			return
		}
		this.#index.set(key, this.#entries.length)
		this.#entries.push(entry)
		this.#compiled.push(compiled)
	}
}

/**
 * A prefix-scoped registration handle over a {@link Router} — pure string
 * composition (AGENTS §4.2.2), no independent state or storage.
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
