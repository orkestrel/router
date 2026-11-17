import type {
	AnswerHandler,
	CompiledPath,
	GroupInterface,
	RouteEntry,
	RouterInterface,
	RouterMatch,
	RouterOptions,
} from './types.js'
import { ContractError, isString, preview } from '@orkestrel/contract'
import { collectInputs, compareSpecificity, compilePath, encodePath, matchPath } from './helpers.js'
import { Group } from './Group.js'

/**
 * Represents the path-matching + registry engine — registers `{ path, meta, name? }`
 * entries (compiling each path once) and resolves raw or encoded text to the most
 * specific matching entry. The shared machine both the `Navigator` (browser) and
 * the `Dispatcher` (core, method-dimensioned) compose.
 *
 * @typeParam Meta - The opaque payload each entry carries and a match returns
 *
 * @remarks
 * - **Registration boundary guard.** `add` validates each entry's
 *   `path` — `isString` plus a leading `/` — and throws a `ContractError` on a
 *   malformed registration; `match` stays guard-free (the hot path).
 * - **Compile-once.** Each path is compiled exactly once at registration into
 *   one record beside its entry, so `match` runs only a cached regex test per
 *   candidate, compares the precomputed specificity vectors, and decodes params
 *   for the winner alone. A remaining tie keeps the earlier registration.
 * - **Dedup through `key`.** When `options.key` is set, an entry whose computed
 *   key already exists REPLACES the prior record IN PLACE (at the existing
 *   index) — last write wins, no engine rebuild. Omitted ⇒ every entry is kept,
 *   even duplicate paths.
 * - **Groups.** `group(prefix)` returns a {@link GroupInterface} that composes
 *   `prefix` onto every entry it registers, nesting through {@link joinPaths}.
 *
 * @example
 * ```ts
 * const router = new Router<{ readonly page: string }>()
 * router.add({ path: '/users/:id', meta: { page: 'profile' } })
 * router.match('/users/7') // { path: '/users/:id', params: { id: '7' }, meta: { page: 'profile' } }
 * ```
 */
export class Router<Meta> implements RouterInterface<Meta> {
	readonly #records: Array<{ readonly entry: RouteEntry<Meta>; readonly compiled: CompiledPath }> =
		[]
	readonly #sensitive: boolean
	readonly #key: ((entry: RouteEntry<Meta>) => string) | undefined
	readonly #index: Map<string, number> = new Map()

	constructor(options?: RouterOptions<Meta>) {
		this.#sensitive = options?.sensitive ?? true
		this.#key = options?.key
		if (options?.entries !== undefined) this.add(options.entries)
	}

	get count(): number {
		return this.#records.length
	}

	add(entry: RouteEntry<Meta>): void
	add(entries: ReadonlyArray<RouteEntry<Meta>>): void
	add(input: RouteEntry<Meta> | ReadonlyArray<RouteEntry<Meta>>): void {
		// Every entry is admitted before any registers, so a refused batch changes nothing.
		const admitted = collectInputs(input).map((entry) => this.#admit(entry))
		for (const { entry, compiled, key } of admitted) this.#register({ entry, compiled }, key)
	}

	match(pathname: string, answers?: AnswerHandler<Meta>): RouterMatch<Meta> | undefined {
		const text = encodePath(pathname)
		// A later record replaces the leader only when it ranks strictly higher: a tie keeps the earlier.
		const selected = this.#records.reduce((current, record, index) => {
			if (answers !== undefined && !answers(record.entry.meta)) return current
			if (!record.compiled.regex.test(text)) return current
			const leader = this.#records[current]
			return leader === undefined ||
				compareSpecificity(record.compiled.specificity, leader.compiled.specificity) < 0
				? index
				: current
		}, -1)
		const best = this.#records[selected]
		const params = best === undefined ? undefined : matchPath(best.compiled, text)
		if (best === undefined || params === undefined) return undefined
		return {
			path: best.entry.path,
			params,
			meta: best.entry.meta,
			...(best.entry.name === undefined ? {} : { name: best.entry.name }),
		}
	}

	entries(): ReadonlyArray<RouteEntry<Meta>>
	entries(pathname: string): ReadonlyArray<RouteEntry<Meta>>
	entries(pathname?: string): ReadonlyArray<RouteEntry<Meta>> {
		const text = pathname === undefined ? undefined : encodePath(pathname)
		return this.#records
			.filter((record) => text === undefined || record.compiled.regex.test(text))
			.map((record) => record.entry)
	}

	group(prefix: string): GroupInterface<Meta> {
		return new Group<Meta>(this, prefix)
	}

	clear(): void {
		this.#records.length = 0
		this.#index.clear()
	}

	// Check the path, compile it, and compute the entry's key, registering nothing.
	#admit(entry: RouteEntry<Meta>): {
		readonly entry: RouteEntry<Meta>
		readonly compiled: CompiledPath
		readonly key: string | undefined
	} {
		if (!isString(entry.path))
			throw new ContractError('a route path must be a string', {
				code: 'literal',
				context: { path: ['entry', 'path'], limit: 'string', received: preview(entry.path) },
			})
		if (!entry.path.startsWith('/'))
			throw new ContractError('a route path must start with "/"', {
				code: 'pattern',
				context: {
					path: ['entry', 'path'],
					limit: 'a "/"-prefixed path pattern',
					received: preview(entry.path),
				},
			})
		return { entry, compiled: compilePath(entry.path, this.#sensitive), key: this.#key?.(entry) }
	}

	// A keyed record replaces the earlier one in place (last write wins); any other record appends.
	#register(
		record: { readonly entry: RouteEntry<Meta>; readonly compiled: CompiledPath },
		key: string | undefined,
	): void {
		const existing = key === undefined ? undefined : this.#index.get(key)
		if (existing !== undefined) {
			this.#records[existing] = record
			return
		}
		if (key !== undefined) this.#index.set(key, this.#records.length)
		this.#records.push(record)
	}
}
