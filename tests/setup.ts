import type { DispatchResult, Method, RouteHandler } from '../src/core/types.js'
import type { RecorderInterface } from '@orkestrel/test'
import { attempt, seededRandom } from '@orkestrel/contract'
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

// ── Router path matrix ────────────────────────────────────────────────────────
//
// The tables and the reference matcher `tests/src/core/integration.test.ts` drives. The
// reference reads the declared path grammar segment by segment, compiles no regular
// expression, and holds its own encode set, refusal list, and method list, so it disagrees
// with `compilePath`, the host `URL` parser, and `src/core` wherever their grammars differ.

/** Names one segment of a route pattern under the declared path grammar. */
export type ReferenceSegment =
	| { readonly shape: 'literal'; readonly text: string }
	| { readonly shape: 'param'; readonly name: string; readonly suffix: string }
	| { readonly shape: 'wildcard'; readonly name: string }

/** Describes one route of a matrix table: the method it answers and its raw pattern. */
export interface MatrixRoute {
	readonly method: Method
	readonly path: string
}

/** Describes one matrix table: its routes and the raw request paths beyond each route's own sample. */
export interface MatrixTable {
	readonly label: string
	readonly routes: readonly MatrixRoute[]
	readonly samples: readonly string[]
}

/** Describes one registration order of a table: its label and the route indices in order. */
export interface MatrixOrder {
	readonly label: string
	readonly indices: readonly number[]
}

/** Describes one request the matrix sends: the form it was derived by and its encoded path. */
export interface MatrixRequest {
	readonly form: string
	readonly path: string
}

/** Describes the route the reference selects for a pathname and the params it decodes. */
export interface ReferenceMatch {
	readonly path: string
	readonly params: Readonly<Record<string, string>>
	readonly tied: boolean
}

/** Describes the answer one dispatch gives: status, `Allow` header, body, and body cancels. */
export interface MatrixOutcome {
	readonly status: number
	readonly allow: string | undefined
	readonly body: unknown
	readonly cancels: number
}

/** Lists the own property names of `Object.prototype`, which the grammar refuses as param names. */
export const PROTOTYPE_NAMES: readonly string[] = Object.freeze(
	Object.getOwnPropertyNames(Object.prototype),
)

/**
 * Lists the printable ASCII members of the declared path encode set: the URL Standard's path
 * percent-encode set (§ 1.3) plus `|`, which Chromium encodes in a path and Node does not.
 * Every C0 control, DEL, and every non-ASCII code point is encoded as well.
 */
export const PATH_ENCODED: readonly string[] = Object.freeze([
	' ',
	'"',
	'#',
	'<',
	'>',
	'?',
	'^',
	'`',
	'{',
	'|',
	'}',
])

/** Lists the code points a pattern must not hold: `\`, tab, line feed, and carriage return. */
export const PATH_REFUSED: readonly string[] = Object.freeze(['\\', '\t', '\n', '\r'])

/** Lists hand-declared encoder pairs: raw text and the canonical text it must encode to. */
export const ENCODER_PAIRS: ReadonlyArray<readonly [text: string, encoded: string]> = Object.freeze(
	[
		['é', '%C3%A9'],
		['日', '%E6%97%A5'],
		['\u{1F600}', '%F0%9F%98%80'],
		['\u0000', '%00'],
		['\u000B', '%0B'],
		['\u001F', '%1F'],
		['\u007F', '%7F'],
		['\uD800', '%EF%BF%BD'],
		['\uDC00x', '%EF%BF%BDx'],
		[' ', '%20'],
		['"', '%22'],
		['#', '%23'],
		['<', '%3C'],
		['>', '%3E'],
		['?', '%3F'],
		['^', '%5E'],
		['`', '%60'],
		['{', '%7B'],
		['}', '%7D'],
		['%41', '%41'],
		['%c3%a9', '%c3%a9'],
		['100%', '100%'],
		['%zz', '%zz'],
		['%', '%'],
		['a/b', 'a/b'],
		['a\\b', 'a\\b'],
		['|', '%7C'],
		['[]$()+*.:@!~', '[]$()+*.:@!~'],
		['/café/a b', '/caf%C3%A9/a%20b'],
		['', ''],
	],
)

/** Lists the code points the seeded encoder differential draws from. */
export const ENCODER_ALPHABET: readonly string[] = Object.freeze([
	'%',
	'0',
	'9',
	'A',
	'c',
	'F',
	'z',
	'/',
	'\\',
	'|',
	'.',
	...PATH_ENCODED,
	'\u0000',
	'\t',
	'\n',
	'\r',
	'\u007F',
	'é',
	'É',
	'日',
	'\u{1F600}',
	'\uD800',
	'\uDFFF',
])

/**
 * Builds the seeded text samples of the encoder differential: strings of up to 12 code points
 * drawn from {@link ENCODER_ALPHABET}.
 *
 * @param seed - The seed for the draw
 * @returns The samples
 */
export function buildEncoderSamples(seed: number): readonly string[] {
	const random = seededRandom(seed)
	return Array.from({ length: 2000 }, () =>
		Array.from(
			{ length: Math.floor(random() * 13) },
			() => ENCODER_ALPHABET[Math.floor(random() * ENCODER_ALPHABET.length)] ?? '',
		).join(''),
	)
}

/**
 * Lists the declared case rows against the pattern `/café`: the request text, whether it hits
 * under `sensitive: false`, and whether it hits under `sensitive: true`.
 */
export const CASE_ROWS: ReadonlyArray<readonly [text: string, folded: boolean, exact: boolean]> =
	Object.freeze([
		['/CAFÉ', false, false],
		['/CAF%C3%89', false, false],
		['/CAFé', true, false],
		['/CAF%C3%A9', true, false],
		['/caf%c3%a9', true, false],
		['/café', true, true],
		['/caf%C3%A9', true, true],
	])

/**
 * Describes the code points of a pattern the grammar refuses, as `U+XXXX` labels in order.
 *
 * @param path - A raw route pattern
 * @returns One label per refused code point the pattern holds
 */
export function describeRefusedPoints(path: string): readonly string[] {
	return [...path]
		.filter((char) => PATH_REFUSED.includes(char))
		.map((char) => `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
}

/** Lists the methods the declared dispatch semantics register and answer. */
export const REFERENCE_METHODS: readonly string[] = Object.freeze([
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'HEAD',
	'OPTIONS',
])

/** Lists the request methods every matrix request is sent with: registered, derived, and unknown. */
export const MATRIX_METHODS: readonly string[] = Object.freeze([
	'GET',
	'POST',
	'HEAD',
	'OPTIONS',
	'PURGE',
])

/** Lists the route tables of the path matrix, each driven through every form, method, and order. */
export const MATRIX_TABLES: readonly MatrixTable[] = Object.freeze([
	{
		label: 'rest',
		routes: [
			{ method: 'GET', path: '/users' },
			{ method: 'POST', path: '/users' },
			{ method: 'GET', path: '/users/me' },
			{ method: 'GET', path: '/users/:id' },
			{ method: 'PUT', path: '/users/:id' },
			{ method: 'DELETE', path: '/users/:id' },
			{ method: 'GET', path: '/users/:id/posts/:slug' },
		],
		samples: ['/', '/users/7/posts', '/users/a.b'],
	},
	{
		label: 'files',
		routes: [
			{ method: 'GET', path: '/files/report.json' },
			{ method: 'GET', path: '/files/:name.json' },
			{ method: 'GET', path: '/files/:name' },
			{ method: 'GET', path: '/files/:name.tar.gz' },
			{ method: 'GET', path: '/files/:name.gz' },
			{ method: 'POST', path: '/files/*rest' },
			{ method: 'GET', path: '/files/*rest' },
		],
		samples: ['/files/a.tar.gz', '/files/a/b.json', '/files/.json', '/files'],
	},
	{
		label: 'literals',
		routes: [
			{ method: 'GET', path: '/café' },
			{ method: 'GET', path: '/a b' },
			{ method: 'GET', path: '/日本/:id' },
			{ method: 'GET', path: '/v1.0/c++' },
			{ method: 'GET', path: '/(x)|[y]' },
			{ method: 'GET', path: '/^w$/{c}' },
			{ method: 'GET', path: '/a:b/*rest' },
			{ method: 'GET', path: '/a*b' },
			{ method: 'GET', path: '/docs/:page.café' },
			{ method: 'GET', path: '/q?a#b' },
			{ method: 'GET', path: '/100%' },
		],
		samples: ['/cafe', '/v1x0/c++', '/docs/.café'],
	},
	{
		label: 'counts',
		routes: [
			{ method: 'GET', path: '/' },
			{ method: 'GET', path: '/a' },
			{ method: 'GET', path: '/a/b' },
			{ method: 'GET', path: '/a/b/c' },
			{ method: 'GET', path: '/:x' },
			{ method: 'GET', path: '/:x/:y' },
			{ method: 'GET', path: '/:x/:y/:z' },
			{ method: 'GET', path: '/a/*rest' },
			{ method: 'GET', path: '/docs/' },
		],
		samples: ['/a/b/c/d', '/q/r/s/t'],
	},
	{
		label: 'ties',
		routes: [
			{ method: 'GET', path: '/t/:a.js' },
			{ method: 'GET', path: '/t/:b.js' },
			{ method: 'GET', path: '/t/:c' },
			{ method: 'GET', path: '/w/*a' },
			{ method: 'GET', path: '/w/*b' },
			{ method: 'GET', path: '/m/:x/:y.json' },
			{ method: 'GET', path: '/m/:x.v/:y' },
			{ method: 'GET', path: '/e/:aé' },
			{ method: 'GET', path: '/e/:b%A9' },
		],
		samples: ['/m/a.v/b.json', '/t/.js', '/e/report%C3%A9'],
	},
] satisfies readonly MatrixTable[])

/**
 * Lists route patterns the grammar refuses: a suffixed or non-final wildcard, a bad param name,
 * and a refused code point in a literal or a suffix.
 */
export const REFUSED_PATHS: readonly string[] = Object.freeze([
	'/files/*rest.json',
	'/files/*rest/more',
	'/x/:__proto__',
	'/x/:constructor',
	'/x/:toString.json',
	'/a/:id/b/:id',
	'/a/:id/*id',
	'/a\\b',
	'/x\\y/:p',
	'/x/a\\..',
	'/a\tb',
	'/a\nb',
	'/a\rb',
	'/x/:p.\t',
	'/x/:p.\n',
	'/x/:p.\r',
])

/** Lists the accepted neighbours of each refused pattern, so the refusal stays narrow. */
export const ACCEPTED_PATHS: readonly string[] = Object.freeze([
	'/files/*rest',
	'/files/x*rest.json',
	'/files/*',
	'/x/:proto',
	'/x/:__proto',
	'/a/:id/b/:other',
	'/a/:id/*rest',
	'/a%5Cb',
	'/a%09b',
	'/a|b',
	'/a\u000Bb',
	'/a\u007Fb',
	'/q?a#b',
	'/100%',
])

/**
 * Checks whether one character may open a param or wildcard name.
 *
 * @param char - One character
 * @returns True if `char` is an ASCII letter or `_`; false otherwise
 */
export function matchesIdentifierStart(char: string): boolean {
	return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_'
}

/**
 * Checks whether one character may continue a param or wildcard name.
 *
 * @param char - One character
 * @returns True if `char` is an ASCII letter, digit, or `_`; false otherwise
 */
export function matchesIdentifierChar(char: string): boolean {
	return matchesIdentifierStart(char) || (char >= '0' && char <= '9')
}

/**
 * Extracts the name that opens a text: an identifier start followed by identifier characters.
 *
 * @param text - The text after a `:` or `*`
 * @returns The name, or `''` when the text opens with no identifier start
 */
export function extractIdentifier(text: string): string {
	if (!matchesIdentifierStart(text.charAt(0))) return ''
	const end = [...text].findIndex((char, index) => index > 0 && !matchesIdentifierChar(char))
	return end === -1 ? text : text.slice(0, end)
}

/**
 * Extracts one segment's shape, or `undefined` for a wildcard that is not final or carries a suffix.
 *
 * @param part - One `/`-separated part of a canonical pattern
 * @param final - If `true`, the part is the pattern's last; if `false`, it is not
 * @returns The segment, or `undefined` when the grammar refuses it
 */
export function extractSegment(part: string, final: boolean): ReferenceSegment | undefined {
	const wildcard = part.startsWith('*') ? extractIdentifier(part.slice(1)) : ''
	if (wildcard !== '')
		return final && wildcard.length + 1 === part.length
			? { shape: 'wildcard', name: wildcard }
			: undefined
	const param = part.startsWith(':') ? extractIdentifier(part.slice(1)) : ''
	if (param !== '') return { shape: 'param', name: param, suffix: part.slice(1 + param.length) }
	return { shape: 'literal', text: part }
}

/**
 * Parses a route pattern into its segments under the declared grammar.
 *
 * @param path - The raw route pattern
 * @returns The segments of the canonical pattern, or `undefined` when the grammar refuses it
 */
export function parseReference(path: string): readonly ReferenceSegment[] | undefined {
	if ([...path].some((char) => PATH_REFUSED.includes(char))) return undefined
	const canonical = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
	const parts = canonical.split('/')
	const extracted = parts.map((part, index) => extractSegment(part, index === parts.length - 1))
	const segments = extracted.filter((segment) => segment !== undefined)
	if (segments.length !== extracted.length) return undefined
	const names = segments.flatMap((segment) => (segment.shape === 'literal' ? [] : [segment.name]))
	if (names.some((name) => PROTOTYPE_NAMES.includes(name))) return undefined
	return new Set(names).size === names.length ? segments : undefined
}

/**
 * Computes the UTF-8 bytes of one code point, writing a lone surrogate as U+FFFD.
 *
 * @param code - The code point
 * @returns Its UTF-8 bytes
 */
export function computeReferenceBytes(code: number): readonly number[] {
	const point = code >= 0xd800 && code <= 0xdfff ? 0xfffd : code
	if (point < 0x80) return [point]
	if (point < 0x800) return [0xc0 | (point >> 6), 0x80 | (point & 0x3f)]
	if (point < 0x10000)
		return [0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f)]
	return [
		0xf0 | (point >> 18),
		0x80 | ((point >> 12) & 0x3f),
		0x80 | ((point >> 6) & 0x3f),
		0x80 | (point & 0x3f),
	]
}

/**
 * Encodes text by the declared path percent-encode set: every member becomes its UTF-8
 * escapes in uppercase hex, and every other code point, `%` included, stays as written.
 *
 * @param text - Raw text
 * @returns The canonical text
 */
export function encodeReference(text: string): string {
	return [...text]
		.map((char) => {
			const code = char.codePointAt(0) ?? 0
			if (code > 0x1f && code < 0x7f && !PATH_ENCODED.includes(char)) return char
			return computeReferenceBytes(code)
				.map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
				.join('')
		})
		.join('')
}

/**
 * Encodes a raw `/`-separated path segment by segment.
 *
 * @param path - A raw path
 * @returns The path with each segment encoded by {@link encodeReference}
 */
export function encodeReferencePath(path: string): string {
	return path
		.split('/')
		.map((part) => encodeReference(part))
		.join('/')
}

/**
 * Decodes one capture: `decodeURIComponent`, or the raw text when its escapes are malformed.
 *
 * @param value - The raw capture
 * @returns The decoded capture
 */
export function decodeReference(value: string): string {
	const decoded = attempt(() => decodeURIComponent(value))
	return decoded.success ? decoded.value : value
}

/**
 * Folds ASCII letters to lower case and leaves every other character as it is.
 *
 * @param text - The text to fold
 * @returns The folded text
 */
export function foldReference(text: string): string {
	return [...text].map((char) => (char >= 'A' && char <= 'Z' ? char.toLowerCase() : char)).join('')
}

/**
 * Checks whether a pattern's encoded text equals request text under the case rule.
 *
 * @param pattern - The encoded pattern text
 * @param text - The request text
 * @param sensitive - If `true`, compares exactly; if `false`, folds ASCII case first
 * @returns True if the two texts are equal under the rule; false otherwise
 */
export function matchesReferenceText(pattern: string, text: string, sensitive: boolean): boolean {
	return sensitive ? pattern === text : foldReference(pattern) === foldReference(text)
}

/**
 * Matches one segment against one request part.
 *
 * @param segment - The pattern segment
 * @param part - The request part; for a wildcard, the rest of the path
 * @param sensitive - If `true`, literal text compares exactly; if `false`, ASCII case folds
 * @returns The captured name and decoded value pairs, or `undefined` on a miss
 */
export function matchReferenceSegment(
	segment: ReferenceSegment,
	part: string,
	sensitive: boolean,
): ReadonlyArray<readonly [string, string]> | undefined {
	if (segment.shape === 'literal')
		return matchesReferenceText(encodeReference(segment.text), part, sensitive) ? [] : undefined
	if (segment.shape === 'wildcard')
		return part === '' ? undefined : [[segment.name, decodeReference(part)]]
	const suffix = encodeReference(segment.suffix)
	if (part.length <= suffix.length) return undefined
	const capture = part.slice(0, part.length - suffix.length)
	return matchesReferenceText(suffix, part.slice(capture.length), sensitive)
		? [[segment.name, decodeReference(capture)]]
		: undefined
}

/**
 * Matches every segment against the parts of one request path.
 *
 * @param segments - The pattern segments
 * @param parts - The request path split on `/`
 * @param sensitive - If `true`, literal text compares exactly; if `false`, ASCII case folds
 * @returns The decoded params, or `undefined` on a miss
 */
export function matchReferenceParts(
	segments: readonly ReferenceSegment[],
	parts: readonly string[],
	sensitive: boolean,
): Readonly<Record<string, string>> | undefined {
	const open = segments.at(-1)?.shape === 'wildcard'
	if (open ? parts.length < segments.length : parts.length !== segments.length) return undefined
	const captures = segments.map((segment, index) =>
		matchReferenceSegment(
			segment,
			segment.shape === 'wildcard' ? parts.slice(index).join('/') : (parts[index] ?? ''),
			sensitive,
		),
	)
	const matched = captures.filter((capture) => capture !== undefined)
	return matched.length === captures.length ? Object.fromEntries(matched.flat()) : undefined
}

/**
 * Matches a pattern against path text, raw or encoded, after encoding the text by the
 * declared set. One trailing slash is optional, except against the root pattern, and the text
 * as sent is tried before the folded one.
 *
 * @param segments - The pattern segments
 * @param text - The request path text
 * @param sensitive - If `true`, literal text compares exactly; if `false`, ASCII case folds
 * @returns The decoded params, or `undefined` on a miss
 */
export function matchReference(
	segments: readonly ReferenceSegment[],
	text: string,
	sensitive: boolean,
): Readonly<Record<string, string>> | undefined {
	const pathname = encodeReferencePath(text)
	const root =
		segments.length === 2 &&
		segments.every((segment) => segment.shape === 'literal' && segment.text === '')
	if (root) return pathname === '/' ? {} : undefined
	const attempts = pathname.endsWith('/') ? [pathname, pathname.slice(0, -1)] : [pathname]
	return attempts
		.map((candidate) => matchReferenceParts(segments, candidate.split('/'), sensitive))
		.find((params) => params !== undefined)
}

/**
 * Computes one segment's rank: its tier, then the encoded length of the literal text it carries.
 *
 * @param segment - The segment, or `undefined` past the end of a shorter pattern
 * @returns The tier (literal 2, param 1, wildcard 0, absent -1) and the literal length
 */
export function computeReferenceRank(
	segment: ReferenceSegment | undefined,
): readonly [tier: number, length: number] {
	if (segment === undefined) return [-1, 0]
	if (segment.shape === 'literal') return [2, encodeReference(segment.text).length]
	if (segment.shape === 'param') return [1, encodeReference(segment.suffix).length]
	return [0, 0]
}

/**
 * Compares two patterns by the declared precedence: segment by segment, the higher tier wins,
 * then the longer literal text within that segment.
 *
 * @param a - The first pattern's segments
 * @param b - The second pattern's segments
 * @returns A negative number when `a` ranks first, a positive number when `b` does, else `0`
 */
export function compareReference(
	a: readonly ReferenceSegment[],
	b: readonly ReferenceSegment[],
): number {
	const ranks = Array.from({ length: Math.max(a.length, b.length) }, (_, index) => [
		computeReferenceRank(a[index]),
		computeReferenceRank(b[index]),
	])
	const differing = ranks.find(([left, right]) => left?.join() !== right?.join())
	const [left, right] = differing ?? []
	if (left === undefined || right === undefined) return 0
	return left[0] === right[0] ? right[1] - left[1] : right[0] - left[0]
}

/**
 * Selects the route the declared precedence picks for a pathname: every matching route sorted by
 * rank, a remaining tie going to the earlier registration.
 *
 * @param routes - The routes in registration order
 * @param pathname - The encoded request pathname
 * @param sensitive - If `true`, literal text compares exactly; if `false`, ASCII case folds
 * @returns The winning pattern, its params, and whether it tied with the runner-up, or `undefined`
 */
export function selectReference(
	routes: readonly MatrixRoute[],
	pathname: string,
	sensitive: boolean,
): ReferenceMatch | undefined {
	const candidates = routes.flatMap((route, index) => {
		const segments = parseReference(route.path)
		const params =
			segments === undefined ? undefined : matchReference(segments, pathname, sensitive)
		return segments === undefined || params === undefined
			? []
			: [{ route, index, segments, params }]
	})
	const sorted = candidates.toSorted(
		(a, b) => compareReference(a.segments, b.segments) || a.index - b.index,
	)
	const [first, second] = sorted
	if (first === undefined) return undefined
	return {
		path: first.route.path,
		params: first.params,
		tied: second !== undefined && compareReference(first.segments, second.segments) === 0,
	}
}

/**
 * Derives the `Allow` list for a pathname: each matching route's method in registration order,
 * `HEAD` when `GET` is present, then `OPTIONS`.
 *
 * @param routes - The routes in registration order
 * @param pathname - The encoded request pathname
 * @param sensitive - If `true`, literal text compares exactly; if `false`, ASCII case folds
 * @returns The derived methods, empty when no route matches the pathname
 */
export function deriveReferenceAllow(
	routes: readonly MatrixRoute[],
	pathname: string,
	sensitive: boolean,
): readonly string[] {
	const methods = routes
		.filter((route) => {
			const segments = parseReference(route.path)
			return segments !== undefined && matchReference(segments, pathname, sensitive) !== undefined
		})
		.map((route) => route.method)
	if (methods.length === 0) return []
	return [...new Set([...methods, ...(methods.includes('GET') ? ['HEAD'] : []), 'OPTIONS'])]
}

/**
 * Decides the answer the declared dispatch semantics give one request.
 *
 * @param routes - The routes in registration order
 * @param method - The raw request method
 * @param pathname - The encoded request pathname
 * @param sensitive - If `true`, literal text compares exactly; if `false`, ASCII case folds
 * @returns The expected status, `Allow` header, body, and number of body cancels
 */
export function dispatchReference(
	routes: readonly MatrixRoute[],
	method: string,
	pathname: string,
	sensitive: boolean,
): MatrixOutcome {
	const known = REFERENCE_METHODS.find((entry) => entry === method)
	const own = routes.filter((route) => route.method === known)
	const hit = known === undefined ? undefined : selectReference(own, pathname, sensitive)
	if (hit !== undefined)
		return {
			status: 200,
			allow: undefined,
			body: { pattern: hit.path, params: hit.params },
			cancels: 0,
		}
	const derived =
		known === 'HEAD'
			? selectReference(
					routes.filter((route) => route.method === 'GET'),
					pathname,
					sensitive,
				)
			: undefined
	if (derived !== undefined) return { status: 200, allow: undefined, body: null, cancels: 1 }
	const allow = deriveReferenceAllow(routes, pathname, sensitive)
	if (allow.length === 0) return { status: 404, allow: undefined, body: 'Not Found', cancels: 0 }
	if (known === 'OPTIONS') return { status: 204, allow: allow.join(', '), body: null, cancels: 0 }
	return { status: 405, allow: allow.join(', '), body: 'Method Not Allowed', cancels: 0 }
}

/**
 * Builds the raw sample path that a route pattern matches: each literal as written, `7` plus
 * the suffix for a param, and `a/b.txt` for a wildcard.
 *
 * @param path - The raw route pattern
 * @returns A raw request path the pattern matches
 */
export function buildSamplePath(path: string): string {
	return path
		.split('/')
		.map((part, index, parts) => {
			const segment = extractSegment(part, index === parts.length - 1)
			if (segment === undefined || segment.shape === 'literal') return part
			if (segment.shape === 'wildcard') return 'a/b.txt'
			return `${segment.suffix === '' ? '7' : 'report'}${segment.suffix}`
		})
		.join('/')
}

/**
 * Builds every request form of one raw path: exact, slashed, doubled slash, an encoded
 * unreserved letter, an encoded reserved slash, a malformed `%`, upper case, and lower case.
 *
 * @param raw - A raw request path
 * @returns The forms, each with its encoded path
 */
export function buildRequestForms(raw: string): readonly MatrixRequest[] {
	const exact = encodeReferencePath(raw)
	const slash = exact.lastIndexOf('/')
	const letter = [...exact].findIndex((char) => foldReference(char) !== char.toUpperCase())
	const code = exact.charCodeAt(letter).toString(16).toUpperCase()
	return [
		{ form: 'exact', path: exact },
		{ form: 'slashed', path: `${exact}/` },
		{ form: 'doubled', path: `${exact.slice(0, slash)}/${exact.slice(slash)}` },
		{
			form: 'unreserved',
			path: letter === -1 ? exact : `${exact.slice(0, letter)}%${code}${exact.slice(letter + 1)}`,
		},
		{
			form: 'reserved',
			path: slash > 0 ? `${exact.slice(0, slash)}%2F${exact.slice(slash + 1)}` : `${exact}%2F`,
		},
		{ form: 'malformed', path: `${exact}%` },
		{ form: 'upper', path: exact.toUpperCase() },
		{ form: 'lower', path: exact.toLowerCase() },
	]
}

/**
 * Builds every request a table sends: each form of each route's sample and of each extra sample.
 *
 * @param table - The matrix table
 * @returns The requests, with no two sharing a path
 */
export function buildMatrixRequests(table: MatrixTable): readonly MatrixRequest[] {
	const raws = [...table.routes.map((route) => buildSamplePath(route.path)), ...table.samples]
	const requests = raws.flatMap((raw) => buildRequestForms(raw))
	return [...new Map(requests.map((request) => [request.path, request])).values()]
}

/**
 * Builds every raw text a table hands to `Router.match` directly: each route's sample and each
 * extra sample as written, slashed, upper case, and lower case, with no encoding.
 *
 * @param table - The matrix table
 * @returns The text requests, with no two sharing a path
 */
export function buildTextRequests(table: MatrixTable): readonly MatrixRequest[] {
	const raws = [...table.routes.map((route) => buildSamplePath(route.path)), ...table.samples]
	const requests = raws.flatMap((raw) => [
		{ form: 'raw', path: raw },
		{ form: 'raw slashed', path: `${raw}/` },
		{ form: 'raw upper', path: raw.toUpperCase() },
		{ form: 'raw lower', path: raw.toLowerCase() },
	])
	return [...new Map(requests.map((request) => [request.path, request])).values()]
}

/**
 * Builds the registration orders a table is driven in: as declared, reversed, and three seeded
 * shuffles.
 *
 * @param length - The number of routes
 * @returns The orders, each with its label and route indices
 */
export function buildMatrixOrders(length: number): readonly MatrixOrder[] {
	const declared = Array.from({ length }, (_, index) => index)
	const shuffles = [1, 2, 3].map((seed) => {
		const random = seededRandom(seed)
		return {
			label: `shuffle ${seed}`,
			indices: declared
				.map((index) => [random(), index] as const)
				.toSorted((a, b) => a[0] - b[0])
				.map(([, index]) => index),
		}
	})
	return [
		{ label: 'declared', indices: declared },
		{ label: 'reversed', indices: declared.toReversed() },
		...shuffles,
	]
}

/**
 * Reorders routes by a list of indices.
 *
 * @param routes - The routes as declared
 * @param indices - The declared indices in the order to register them
 * @returns The routes in that order
 */
export function orderRoutes(
	routes: readonly MatrixRoute[],
	indices: readonly number[],
): readonly MatrixRoute[] {
	return indices.flatMap((index) => {
		const route = routes[index]
		return route === undefined ? [] : [route]
	})
}

/**
 * Keeps the first route of each pattern, for a method-less router that registers a pattern once.
 *
 * @param routes - The routes in registration order
 * @returns The routes whose pattern no earlier route carries
 */
export function filterDistinctPaths(routes: readonly MatrixRoute[]): readonly MatrixRoute[] {
	return routes.filter(
		(route, index) => routes.findIndex((other) => other.path === route.path) === index,
	)
}

/**
 * Creates the route handler every matrix route registers: a JSON body of the winning pattern and
 * its params, served from a stream whose cancel the recorder counts.
 *
 * @param cancels - The recorder each body cancel reports to
 * @returns The handler
 */
export function createMatrixHandler(cancels: RecorderInterface<readonly unknown[]>): RouteHandler {
	return (_request, context) => {
		const text = JSON.stringify({ pattern: context.pattern, params: context.params })
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new TextEncoder().encode(text))
				controller.close()
			},
			cancel: cancels.handler,
		})
		return new Response(body, { headers: { 'content-type': 'application/json' } })
	}
}

/**
 * Reads the answer of one dispatch: status, `Allow` header, the body as JSON or text, and how
 * many body cancels the dispatch caused.
 *
 * @param response - The dispatch's response
 * @param cancels - The number of body cancels the dispatch caused
 * @returns The outcome
 */
export async function readMatrixOutcome(
	response: Response,
	cancels: number,
): Promise<MatrixOutcome> {
	const allow = response.headers.get('allow') ?? undefined
	const json = response.headers.get('content-type') === 'application/json'
	const text = response.body === null ? undefined : await response.text()
	const body: unknown = text === undefined ? null : json ? JSON.parse(text) : text
	return { status: response.status, allow, body, cancels }
}

/** Lists the patterns of the dispatcher the cost row times: a REST-shaped table of ten routes. */
export const COST_PATHS: readonly string[] = Object.freeze([
	'/users',
	'/users/:id',
	'/users/:id/edit',
	'/posts',
	'/posts/:id',
	'/files/*rest',
	'/a/b',
	'/c/:d',
	'/e',
	'/f/:g.json',
])

/**
 * Measures the median milliseconds one `Dispatcher.handle` call spends on `/users/<text>`: seven
 * samples, each the mean of five sequential calls.
 *
 * @param dispatcher - The dispatcher to time
 * @param text - The path text after `/users/`
 * @returns The median per-call duration in milliseconds
 */
export async function measureDispatchCost(
	dispatcher: { readonly handle: (request: Request, state: undefined) => Promise<Response> },
	text: string,
): Promise<number> {
	const request = new Request(`http://x/users/${text}`)
	const samples = await Array.from({ length: 7 }).reduce<Promise<readonly number[]>>(
		async (previous) => {
			const earlier = await previous
			const start = performance.now()
			await Array.from({ length: 5 }).reduce<Promise<unknown>>(async (pending) => {
				await pending
				return dispatcher.handle(request, undefined)
			}, Promise.resolve())
			return [...earlier, (performance.now() - start) / 5]
		},
		Promise.resolve([]),
	)
	return samples.toSorted((a, b) => a - b)[3] ?? Number.NaN
}

/**
 * Lists the text-door cost inputs: a label, the unit a run repeats — `^`, a lone surrogate, an
 * astral code point, and a mix of ASCII members, plain letters, and non-ASCII text — and the
 * bound on the run's cost growth from 500 to 2,000 repetitions.
 *
 * @remarks
 * A linear encoder grows by about 4. Ten runs on 2026-11-16 at load average 1.3 read growth
 * 3.35 to 3.91 for the single units and 4.02 to 5.64 for the mixed unit; each bound is twice
 * that maximum, rounded up, for host load: 2 × 3.91 = 7.82, so 8, and 2 × 5.64 = 11.28, so 12.
 */
export const COST_UNITS: ReadonlyArray<readonly [label: string, unit: string, bound: number]> =
	Object.freeze([
		['caret', '^', 8],
		['surrogate', '\uD800', 8],
		['astral', '\u{1F600}', 8],
		['mixed', 'a^é{b}|日', 12],
	])

/**
 * Measures the median milliseconds one `Router.match` call spends on raw `/users/<text>`: seven
 * samples, each the mean of five calls.
 *
 * @param router - The router to time
 * @param text - The raw path text after `/users/`
 * @returns The median per-call duration in milliseconds
 */
export function measureMatchCost(
	router: { readonly match: (pathname: string) => unknown },
	text: string,
): number {
	const pathname = `/users/${text}`
	const samples = Array.from({ length: 7 }, () => {
		const start = performance.now()
		Array.from({ length: 5 }).forEach(() => router.match(pathname))
		return (performance.now() - start) / 5
	})
	return samples.toSorted((a, b) => a - b)[3] ?? Number.NaN
}
