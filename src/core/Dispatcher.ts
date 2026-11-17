import type {
	DispatchGroupInterface,
	DispatcherEventMap,
	DispatcherInterface,
	DispatcherOptions,
	DispatchResult,
	Method,
	RouteContext,
	RouteEntry,
	RouteInput,
	RouteRecord,
	RouterInterface,
	RouterMatch,
} from './types.js'
import type { EmitterInterface } from '@orkestrel/emitter'
import { Emitter } from '@orkestrel/emitter'
import { isFunction, isString, refuseValue } from '@orkestrel/contract'
import { HTTP_METHODS } from './constants.js'
import { collectInputs, computeDispatchKey } from './helpers.js'
import { parseMethod } from './parsers.js'
import { Router } from './Router.js'
import { DispatchGroup } from './DispatchGroup.js'

/**
 * Represents the fetch-standard, method-dimensioned dispatch entity — layers HTTP
 * method dispatch and web-standard `Request`/`Response` handling over one internal
 * `Router<RouteRecord<TState>>`. The core machine the server face and any
 * fetch-native runtime consume directly.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * - **Dedup by `method + canonicalizePath`.** The underlying `Router` is
 *   constructed with a `key` function so registering the same method+path
 *   twice REPLACES the prior route in place.
 * - **Registration boundary guard.** `add` validates each input's
 *   `handler` (`isFunction`) and `method` (must be in {@link HTTP_METHODS}) —
 *   throws a `ContractError` on a malformed registration; path validation is
 *   delegated to the underlying `Router`'s own guard. `match`/`handle` stay
 *   guard-free.
 * - **Auto-`HEAD` / auto-`OPTIONS`.** A `HEAD` request with no registered
 *   `HEAD` route runs the matching `GET` handler, cancels its response body,
 *   and answers with the status and headers alone; an `OPTIONS` request with no
 *   registered `OPTIONS` route answers `204` with the derived `Allow` header,
 *   the same set a `405` carries, `OPTIONS` included.
 * - **Handler throws propagate.** `handle` never invents an error boundary —
 *   a handler throw reaches the caller uncaught.
 * - **Emitter.** Owns a `#emitter` for {@link DispatcherEventMap};
 *   `match`/`miss` fire AFTER resolution, before the handler/responder runs.
 *
 * @example
 * ```ts
 * const dispatcher = new Dispatcher<{ readonly userId: string }>()
 * dispatcher.add({
 * 	method: 'GET',
 * 	path: '/users/:id',
 * 	handler: (request, context) => Response.json({ id: context.params.id }),
 * })
 * const response = await dispatcher.handle(new Request('http://x/users/7'), { userId: 'me' })
 * ```
 */
export class Dispatcher<TState = undefined> implements DispatcherInterface<TState> {
	readonly #router: RouterInterface<RouteRecord<TState>>
	readonly #emitter: Emitter<DispatcherEventMap>
	readonly #unmatched: DispatcherOptions<TState>['unmatched']
	readonly #unmethoded: DispatcherOptions<TState>['unmethoded']

	constructor(options?: DispatcherOptions<TState>) {
		const sensitive = options?.sensitive
		const on = options?.on
		const error = options?.error
		this.#router = new Router<RouteRecord<TState>>({
			...(sensitive === undefined ? {} : { sensitive }),
			key: computeDispatchKey,
		})
		this.#emitter = new Emitter<DispatcherEventMap>({
			...(on === undefined ? {} : { on }),
			...(error === undefined ? {} : { error }),
		})
		this.#unmatched = options?.unmatched
		this.#unmethoded = options?.unmethoded
		if (options?.routes !== undefined) this.add(options.routes)
	}

	get router(): RouterInterface<RouteRecord<TState>> {
		return this.#router
	}

	get emitter(): EmitterInterface<DispatcherEventMap> {
		return this.#emitter
	}

	add<Path extends string>(input: RouteInput<Path, TState>): void
	add(inputs: ReadonlyArray<RouteInput<string, TState>>): void
	add(input: RouteInput<string, TState> | ReadonlyArray<RouteInput<string, TState>>): void {
		this.#router.add(collectInputs(input).map((route) => this.#admit(route)))
	}

	group(prefix: string): DispatchGroupInterface<TState> {
		return new DispatchGroup<TState>(this, prefix)
	}

	match(method: Method, pathname: string): DispatchResult<TState> {
		const hit = this.#router.match(pathname, (meta) => meta.method === method)
		if (hit !== undefined) return { status: 'matched', match: hit }
		if (method === 'HEAD') {
			const getHit = this.#router.match(pathname, (meta) => meta.method === 'GET')
			if (getHit !== undefined) return { status: 'matched', match: getHit }
		}
		const allow = this.#allow(pathname)
		if (allow.length === 0) return { status: 'unmatched' }
		return { status: 'unmethoded', allow }
	}

	async handle(request: Request, state: TState): Promise<Response> {
		const url = new URL(request.url)
		const pathname = url.pathname
		const requested = request.method
		const method = parseMethod(requested)
		if (method === undefined) {
			const allow = this.#allow(pathname)
			if (allow.length === 0) {
				this.#emitter.emit('miss', requested, pathname, 'unmatched')
				return this.#respondUnmatched(request)
			}
			this.#emitter.emit('miss', requested, pathname, 'unmethoded')
			return this.#respondUnmethoded(request, allow)
		}
		const result = this.match(method, pathname)
		if (result.status === 'matched')
			return this.#respondMatched(request, state, method, result.match, url)
		if (result.status === 'unmethoded') {
			if (method === 'OPTIONS') {
				const hit = this.#router.match(pathname)
				if (hit !== undefined) return this.#respondAutoOptions(hit.path, result.allow)
			}
			this.#emitter.emit('miss', method, pathname, 'unmethoded')
			return this.#respondUnmethoded(request, result.allow)
		}
		this.#emitter.emit('miss', method, pathname, 'unmatched')
		return this.#respondUnmatched(request)
	}

	destroy(): void {
		this.#emitter.destroy()
	}

	// Check the handler and method and build the router entry; the router admits the path.
	#admit(input: RouteInput<string, TState>): RouteEntry<RouteRecord<TState>> {
		refuseValue(input.handler, isFunction, 'Dispatcher', {
			path: ['input', 'handler'],
			limit: 'function',
			code: 'literal',
		})
		refuseValue(
			input.method,
			(value): value is Method => isString(value) && HTTP_METHODS.has(value),
			'Dispatcher',
			{ path: ['input', 'method'], limit: [...HTTP_METHODS].join(', '), code: 'literal' },
		)
		const name = input.name
		return {
			path: input.path,
			...(name === undefined ? {} : { name }),
			meta: {
				method: input.method,
				handler: input.handler,
				...(name === undefined ? {} : { name }),
			},
		}
	}

	// Registered methods in order, then `HEAD` when `GET` is present, then `OPTIONS`; empty on a miss.
	#allow(pathname: string): readonly Method[] {
		const registered = this.#router.entries(pathname).map((entry) => entry.meta.method)
		if (registered.length === 0) return []
		const derived: readonly Method[] = registered.includes('GET')
			? ['HEAD', 'OPTIONS']
			: ['OPTIONS']
		return [...new Set<Method>([...registered, ...derived])]
	}

	#respondUnmatched(request: Request): Response | Promise<Response> {
		const responder = this.#unmatched
		if (responder !== undefined) return responder(request)
		return new Response('Not Found', { status: 404 })
	}

	#respondUnmethoded(request: Request, allow: readonly Method[]): Response | Promise<Response> {
		const responder = this.#unmethoded
		if (responder !== undefined) return responder(request, allow)
		return new Response('Method Not Allowed', {
			status: 405,
			headers: { Allow: allow.join(', ') },
		})
	}

	// A matched dispatch — either the winning handler runs directly, or (for a derived `HEAD`
	// with no explicit `HEAD` route) the `GET` handler runs and its response body is cancelled.
	async #respondMatched(
		request: Request,
		state: TState,
		method: Method,
		match: RouterMatch<RouteRecord<TState>>,
		url: URL,
	): Promise<Response> {
		this.#emitter.emit('match', method, match.path)
		const context: RouteContext<string, TState> = {
			params: match.params,
			pattern: match.path,
			url,
			state,
		}
		const response = await match.meta.handler(request, context)
		if (method !== 'HEAD' || match.meta.method !== 'GET') return response
		// A locked or errored body rejects the cancel; the derived answer sends no body either way.
		response.body?.cancel().catch(() => undefined)
		return new Response(null, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		})
	}

	// Derived `OPTIONS` — no explicit `OPTIONS` route registered for this pathname: answer
	// `204` with the derived `Allow` set, emitting `match` under the most-specific REGISTERED
	// pattern the pathname resolved to, so a consumer aggregating by pattern sees bounded
	// cardinality rather than one label per request path.
	#respondAutoOptions(pattern: string, allow: readonly Method[]): Response {
		this.#emitter.emit('match', 'OPTIONS', pattern)
		return new Response(null, { status: 204, headers: { Allow: allow.join(', ') } })
	}
}
