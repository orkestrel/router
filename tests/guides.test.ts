// The guides-parity gate: `@orkestrel/guide`'s checks run against this repository's own
// `guides/README.md` manifest, and every flagship fence in `guides/router.md` that this project
// can execute is transcribed here and asserted against what its comments claim. Name resolution
// is not a behavioural proof, so a fence documenting a value the code contradicts is exactly what
// the transcriptions catch. Change a fence, change its transcription.
//
// This project runs in Node with the browser disabled, so it cannot execute a fence that touches
// `window`: the `@orkestrel/router/browser` fences are transcribed in
// `tests/src/browser/Navigator.test.ts` instead, and the `@orkestrel/router/server` fences are
// covered by `tests/src/server/handlers.test.ts` over real `node:http` sockets.

import { describe, expect, it } from 'vitest'
import {
	computeSymbolKey,
	createGuide,
	createSource,
	createSourceManager,
	extractFenceImports,
	findMissing,
	findMissingSymbols,
	findUnexampled,
	findUnlisted,
	isExternalLink,
	parseManifest,
	resolveLink,
} from '@orkestrel/guide'
import { readFileSync } from 'node:fs'
import { requireValue } from '@orkestrel/test'
import { readInventory } from '@orkestrel/test/server'
import { createDispatcher, createRouter, defineRoute } from '@src/core'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/**
 * Each import specifier this package's own guides may resolve against — the router
 * guide spans the core, browser, and server faces, so a fence importing any of them
 * resolves against that face's own exports rather than only the current entry's.
 */
const MODULES = Object.freeze({
	'@orkestrel/router': 'src/core',
	'@orkestrel/router/browser': 'src/browser',
	'@orkestrel/router/server': 'src/server',
	'@src/browser': 'src/browser',
	'@src/core': 'src/core',
	'@src/server': 'src/server',
})
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the following second assertion fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

/** Root-level files this package's guides link to. `readInventory` walks directories only. */
const ROOT_FILES = Object.freeze(['AGENTS.md'])

const root = new URL('../', import.meta.url)
const files: Record<string, string> = {
	...readInventory(root, ['src', 'guides', 'tests'], { extensions: ['.ts', '.md'] }),
}
for (const name of ROOT_FILES) files[name] = readFileSync(new URL(name, root), 'utf8')
const manifest = parseManifest(
	requireValue(files['guides/README.md'], 'Missing file: guides/README.md'),
	'guides',
)
const sources = createSourceManager({ files, modules: MODULES })

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
})

for (const entry of manifest) {
	const guide = createGuide(requireValue(files[entry.spec], `Missing file: ${entry.spec}`))
	const source = createSource({ files, module: entry.source })

	describe(`${entry.concept}`, () => {
		it('uses only listed fence languages', () => {
			expect(findUnlisted(guide.fences(), FENCE_LANGUAGES)).toEqual([])
		})

		it('extracts a non-empty documented surface', () => {
			expect(guide.surface().length).toBeGreaterThan(0)
		})
		it('re-exports every direct declaration that is not named internal', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(stranded.filter((key) => !INTERNAL.includes(key))).toEqual([])
		})
		it('names no symbol internal that the barrel already exports', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(INTERNAL.filter((key) => !stranded.includes(key))).toEqual([])
		})
		it('re-exports only direct declarations', () => {
			expect(findMissingSymbols(source.surface(), source.exports())).toEqual([])
		})
		it('documents every barrel export', () => {
			expect(findMissingSymbols(source.surface(), guide.surface())).toEqual([])
		})
		it('documents only barrel exports', () => {
			expect(findMissingSymbols(guide.surface(), source.surface())).toEqual([])
		})

		it('exposes no hidden module-scope declarations', () => {
			expect(source.hidden().map(computeSymbolKey)).toEqual([])
		})

		for (const group of guide.methods()) {
			const members = source.methods(group.interface)
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface}`, () => {
				it('documents at least one method', () => {
					expect(group.methods.length).toBeGreaterThan(0)
				})
				it('documents every interface method', () => {
					expect(findMissing(members, group.methods)).toEqual([])
				})
				it('documents no phantom method', () => {
					expect(findMissing(group.methods, members)).toEqual([])
				})
				it(`${entity} exposes no undocumented method`, () => {
					const extra =
						entity === group.interface ? [] : findMissing(source.methods(entity), group.methods)
					expect(extra).toEqual([])
				})
			})
		}

		it('documents an example for every Surface function', () => {
			const fences = guide
				.fences()
				.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				.map((fence) => fence.code)
			const names = guide
				.surface()
				.filter((symbol) => symbol.kind === 'function')
				.map((symbol) => symbol.name)
			expect(findUnexampled(names, fences, source.examples())).toEqual([])
		})

		for (const group of guide.methods()) {
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface} examples`, () => {
				it('documents an example for every method', () => {
					const fences = guide
						.fences()
						.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
						.map((fence) => fence.code)
					const examples =
						entity === group.interface
							? source.examples(group.interface)
							: source.examples(group.interface).concat(source.examples(entity))
					expect(findUnexampled(group.methods, fences, examples)).toEqual([])
				})
			})
		}

		it('imports only real exports in every ```ts fence', () => {
			const fences = guide.fences().filter((fence) => fence.language === EXAMPLE_LANGUAGE)
			for (const fence of fences) {
				for (const { specifier, names } of extractFenceImports(fence.code)) {
					const imported = sources.source(specifier)
					if (imported === undefined) continue
					const surface = imported.surface().map((symbol) => symbol.name)
					expect(findMissing(names, surface)).toEqual([])
				}
			}
		})

		it('resolves every relative link', () => {
			const broken = guide
				.links()
				.filter((href) => !isExternalLink(href))
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(broken).toEqual([])
		})
		it('links only to test files that exist', () => {
			const missing = guide
				.tests()
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(missing).toEqual([])
		})
	})
}

// ── Flagship fence transcriptions ────────────────────────────────────────────
//
// Each block that follows is one `guides/router.md` fence, run against the real barrel and
// asserting the value its comments claim.

describe('flagship fences', () => {
	it('registers, matches, and dispatches (Surface)', async () => {
		const router = createRouter<{ readonly page: string }>()
		router.add({ path: '/users/:id', meta: { page: 'profile' } })
		expect(router.match('/users/7')).toEqual({
			path: '/users/:id',
			params: { id: '7' },
			meta: { page: 'profile' },
		})

		const dispatcher = createDispatcher<{ readonly userId: string }>({
			routes: [
				{
					method: 'GET',
					path: '/users/:id',
					handler: (_request, context) => Response.json(context.params),
				},
			],
		})
		const response = await dispatcher.handle(new Request('http://x/users/7'), { userId: 'me' })
		expect(await response.json()).toEqual({ id: '7' })
		dispatcher.destroy()
	})

	it('composes a group prefix and replaces on a repeated key (Groups and dedup)', () => {
		const router = createRouter<{ readonly page: string }>({ key: (entry) => entry.path })
		const api = router.group('/api')
		api.add({ path: '/users', meta: { page: 'list' } })
		expect(router.match('/api/users')?.path).toBe('/api/users')

		router.add({ path: '/api/users', meta: { page: 'list-v2' } })
		expect(router.count).toBe(1)
		expect(router.match('/api/users')?.meta).toEqual({ page: 'list-v2' })
	})

	it('ranks literal over param over wildcard (Wildcard capture and precedence)', () => {
		const router = createRouter<{ readonly handler: string }>()
		router.add([
			{ path: '/files/*rest', meta: { handler: 'catchAll' } },
			{ path: '/files/:name', meta: { handler: 'named' } },
			{ path: '/files/readme', meta: { handler: 'literal' } },
		])
		expect(router.match('/files/readme')?.meta.handler).toBe('literal')
		expect(router.match('/files/other')?.meta.handler).toBe('named')
		expect(router.match('/files/a/b.png')?.meta.handler).toBe('catchAll')
	})

	it('derives HEAD, OPTIONS, and 405 (Method-dimensioned dispatch)', async () => {
		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })

		const head = await dispatcher.handle(
			new Request('http://x/health', { method: 'HEAD' }),
			undefined,
		)
		expect(head.body).toBeNull()

		const options = await dispatcher.handle(
			new Request('http://x/health', { method: 'OPTIONS' }),
			undefined,
		)
		expect(options.headers.get('Allow')).toBe('GET, HEAD, OPTIONS')

		const notAllowed = await dispatcher.handle(
			new Request('http://x/health', { method: 'DELETE' }),
			undefined,
		)
		expect(notAllowed.status).toBe(405)
		dispatcher.destroy()
	})

	it('emits a miss for an unregistered path (Observing dispatch outcomes)', async () => {
		const matched: Array<readonly [string, string]> = []
		const missed: Array<readonly [string, string, string]> = []
		const dispatcher = createDispatcher({
			on: {
				match: (method, pattern) => matched.push([method, pattern]),
				miss: (method, pathname, status) => missed.push([method, pathname, status]),
			},
		})
		dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
		await dispatcher.handle(new Request('http://x/missing'), undefined)
		expect(matched).toEqual([])
		expect(missed).toEqual([['GET', '/missing', 'unmatched']])
		dispatcher.destroy()
	})

	it('pins the literal path at the registration site (Typing a route input)', async () => {
		const input = defineRoute({
			method: 'GET',
			path: '/users/:id',
			handler: (_request, context) => new Response(context.params.id),
		})
		expect(input.path).toBe('/users/:id')

		const dispatcher = createDispatcher()
		dispatcher.add(input)
		const response = await dispatcher.handle(new Request('http://x/users/7'), undefined)
		expect(await response.text()).toBe('7')
		dispatcher.destroy()
	})

	it('lists, filters, clears, and destroys (Introspection and reset)', () => {
		const router = createRouter<{ readonly page: string }>()
		router.add([
			{ path: '/users/:id', meta: { page: 'profile' } },
			{ path: '/tokens', meta: { page: 'tokens' } },
		])
		expect(router.entries()).toHaveLength(2)
		expect(router.entries('/users/7')).toHaveLength(1)
		router.clear()
		expect(router.entries()).toHaveLength(0)

		const dispatcher = createDispatcher()
		dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
		dispatcher.destroy()
		expect(dispatcher.router.entries()).toHaveLength(1)
	})
})
