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
import { isFunction, isString } from '@orkestrel/contract'
import { METHODS } from './constants.js'
import { canonicalPath, joinPaths, parseMethod } from './helpers.js'
import { Router } from './Router.js'

/**
 * The fetch-standard, method-dimensioned dispatch entity — layers HTTP method
 * dispatch and web-standard `Request`/`Response` handling over one internal
 * `Router<RouteRecord<TState>>`. The core machine the eventual server face
 * (§7) and any fetch-native runtime consumes directly.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * - **Dedup by `method + canonicalPath`.** The underlying `Router` is
 *   constructed with a `key` function so registering the same method+path
 *   twice REPLACES the prior route in place (§5.1).
 * - **Registration boundary guard (§14).** `add` validates each input's
 *   `handler` (`isFunction`) and `method` (must be in {@link METHODS}) —
 *   throws `TypeError` on a malformed registration; path validation is
 *   delegated to the underlying `Router`'s own guard. `match`/`handle` stay
 *   guard-free.
 * - **Auto-`HEAD` / auto-`OPTIONS`.** A `HEAD` request with no registered
 *   `HEAD` route runs the matching `GET` handler and strips the response
 *   body; an `OPTIONS` request with no registered `OPTIONS` route answers
 *   `204` with a derived `Allow` header.
 * - **Handler throws propagate.** `handle` never invents an error boundary —
 *   a handler throw reaches the caller uncaught (§5.1).
 * - **Emitter (§13).** Owns a `#emitter` for {@link DispatcherEventMap};
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
	readonly router: RouterInterface<RouteRecord<TState>>
	readonly #emitter: Emitter<DispatcherEventMap>
	readonly #unmatched: (request: Request) => Response | Promise<Response>
	readonly #unmethoded: (request: Request, allow: readonly Method[]) => Response | Promise<Response>

	constructor(options?: DispatcherOptions<TState>) {
		this.router = new Router<RouteRecord<TState>>({
			sensitive: options?.sensitive,
			key: (entry) => `${entry.meta.method} ${canonicalPath(entry.path)}`,
		})
		this.#emitter = new Emitter<DispatcherEventMap>({ on: options?.on, error: options?.error })
		this.#unmatched =
			options?.unmatched ?? ((_request) => new Response('Not Found', { status: 404 }))
		this.#unmethoded =
			options?.unmethoded ??
			((_request, allow) =>
				new Response('Method Not Allowed', {
					status: 405,
					headers: { Allow: allow.join(', ') },
				}))
		if (options?.routes !== undefined) this.add(options.routes)
	}

	get emitter(): EmitterInterface<DispatcherEventMap> {
		return this.#emitter
	}

	add<Path extends string>(input: RouteInput<Path, TState>): void
	add(inputs: readonly RouteInput<string, TState>[]): void
	add(input: RouteInput<string, TState> | readonly RouteInput<string, TState>[]): void {
		const inputs = Array.isArray(input) ? input : [input]
		for (const route of inputs) this.#register(route)
	}

	group(prefix: string): DispatchGroupInterface<TState> {
		return new DispatchGroup<TState>(this, prefix)
	}

	match(method: Method, pathname: string): DispatchResult<TState> {
		const hit = this.router.match(pathname, (meta) => meta.method === method)
		if (hit !== undefined) return { status: 'matched', match: hit }
		if (method === 'HEAD') {
			const getHit = this.router.match(pathname, (meta) => meta.method === 'GET')
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
				return this.#unmatched(request)
			}
			this.#emitter.emit('miss', requested, pathname, 'unmethoded')
			return this.#unmethoded(request, allow)
		}
		const result = this.match(method, pathname)
		if (result.status === 'matched')
			return this.#respondMatched(request, state, method, result.match, url)
		if (result.status === 'unmethoded') {
			if (method === 'OPTIONS') return this.#respondAutoOptions(pathname, result.allow)
			this.#emitter.emit('miss', method, pathname, 'unmethoded')
			return this.#unmethoded(request, result.allow)
		}
		this.#emitter.emit('miss', method, pathname, 'unmatched')
		return this.#unmatched(request)
	}

	destroy(): void {
		this.#emitter.destroy()
	}

	// Validate the registration boundary (§14: handler function, known method), then delegate
	// path validation + dedup to the underlying `Router`'s own guard.
	#register(input: RouteInput<string, TState>): void {
		if (!isFunction(input.handler))
			throw new TypeError(
				`a route handler must be a function, got ${JSON.stringify(input.handler)}`,
			)
		if (!isString(input.method) || !METHODS.has(input.method))
			throw new TypeError(
				`a route method must be one of ${[...METHODS].join(', ')}, got ${JSON.stringify(input.method)}`,
			)
		this.router.add({
			path: input.path,
			name: input.name,
			meta: { method: input.method, handler: input.handler, name: input.name },
		})
	}

	// The derived `Allow` set for a pathname — every distinct registered method, with `HEAD`
	// added whenever `GET` is present and `HEAD` is not explicitly registered (§5.1).
	#allow(pathname: string): readonly Method[] {
		const entries: readonly RouteEntry<RouteRecord<TState>>[] = this.router.entries(pathname)
		const methods = new Set<Method>()
		for (const entry of entries) methods.add(entry.meta.method)
		if (methods.has('GET')) methods.add('HEAD')
		return [...methods]
	}

	// A matched dispatch — either the winning handler runs directly, or (for a derived `HEAD`
	// with no explicit `HEAD` route) the `GET` handler runs and the response body is stripped.
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
		if (method === 'HEAD' && match.meta.method === 'GET')
			return new Response(null, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			})
		return response
	}

	// Derived `OPTIONS` — no explicit `OPTIONS` route registered for this pathname: answer
	// `204` with the derived `Allow` set (adding `OPTIONS` itself, always answerable).
	#respondAutoOptions(pathname: string, allow: readonly Method[]): Response {
		this.#emitter.emit('match', 'OPTIONS', pathname)
		const headers = new Headers({ Allow: [...allow, 'OPTIONS'].join(', ') })
		return new Response(null, { status: 204, headers })
	}
}

/**
 * A prefix-scoped registration handle over a {@link Dispatcher} — the
 * method-dimensioned counterpart of `Group` (`Router.ts`).
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
