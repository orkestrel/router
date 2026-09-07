// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants that follow are this
// package's own, and are the only part a sibling package changes. Every flagship fence in
// `guides/router.md` that this project can execute is transcribed at the end of the file and
// asserted against what its comments claim: name resolution is not a behavioural proof, so a
// fence documenting a value the code contradicts is exactly what the transcriptions catch.
// Change a fence, change its transcription.
//
// This project runs in Node with the browser disabled, so it cannot execute a fence that
// touches `window`: the `@orkestrel/router/browser` fences are transcribed in
// `tests/src/browser/Navigator.test.ts` instead, and the `@orkestrel/router/server` fences
// are covered by `tests/src/server/handlers.test.ts` over real `node:http` sockets.

import { describe, expect, it } from 'vitest'
import {
	computeSymbolKey,
	createGuide,
	createSource,
	createSourceManager,
	extractFenceImports,
	findDrift,
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
/** The one guide this package sources, whose tagline the README pitch equals. */
const GUIDE_SPEC = 'guides/router.md'
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
 * intentional rather than forgotten — and the assertion that follows it fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

/** Root-level files these checks read. `readInventory` walks directories only. */
const ROOT_FILES = Object.freeze(['AGENTS.md', 'README.md'])

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
const own = requireValue(
	manifest.find((entry) => entry.spec === GUIDE_SPEC),
	`Missing manifest row: ${GUIDE_SPEC}`,
)

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
})

// The example half of the equality case is silent over an empty population: with no
// title on both sides `findDrift` compares no pair and the case passes on the summaries
// alone. This pins the population this repository's own guide contributes, so removing
// every `@example` title reddens the suite instead of quietly retiring half the gate.
// The failure names both title sets, because a pin reporting only its own emptiness
// leaves the reader to work out which side dropped the title.
it('pairs at least one example title across the guide and the source', () => {
	const guide = createGuide(requireValue(files[GUIDE_SPEC], `Missing file: ${GUIDE_SPEC}`))
	const source = createSource({ files, module: own.source })
	const declared = source
		.examples()
		.map((example) => example.title)
		.filter((title) => title !== undefined)
	const titled = new Set(declared)
	const headings: string[] = []
	const paired: string[] = []
	for (const fence of guide.fences()) {
		if (fence.title === undefined) continue
		headings.push(fence.title)
		if (titled.has(fence.title)) paired.push(fence.title)
	}
	const unpaired =
		paired.length > 0
			? []
			: [
					`${GUIDE_SPEC} pairs: guide ${JSON.stringify(headings)} source ${JSON.stringify(declared)}`,
				]
	expect(unpaired).toEqual([])
})

// The README's pitch and the guide's tagline are one text, each read as the blockquote
// under its file's H1. `README.md` is outside the concept index, so the reader is
// applied to it directly rather than through a manifest row. Each side is guarded
// against `undefined` first, so a file that lost its blockquote reports that rather
// than reporting two absences as agreement.
it('opens the README with the guide tagline', () => {
	const pitch = createGuide(requireValue(files['README.md'], 'Missing file: README.md')).tagline()
	const tagline = createGuide(
		requireValue(files[GUIDE_SPEC], `Missing file: ${GUIDE_SPEC}`),
	).tagline()

	expect(pitch).not.toBeUndefined()
	expect(tagline).not.toBeUndefined()
	expect(pitch).toBe(tagline)
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
			const members = source.methods(group.interface).map((method) => method.name)
			const documented = group.methods.map((method) => method.name)
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface}`, () => {
				it('documents at least one method', () => {
					expect(group.methods.length).toBeGreaterThan(0)
				})
				it('documents every interface method', () => {
					expect(findMissing(members, documented)).toEqual([])
				})
				it('documents no phantom method', () => {
					expect(findMissing(documented, members)).toEqual([])
				})
				it(`${entity} exposes no undocumented method`, () => {
					const extra =
						entity === group.interface
							? []
							: findMissing(
									source.methods(entity).map((method) => method.name),
									documented,
								)
					expect(extra).toEqual([])
				})
			})
		}

		// The equality gate: a `Summary` cell against its export's description paragraph, a
		// titled fence against the `@example` of that title. `findDrift` owns the comparison
		// and names both sides; converge the two sides with `npm run docs`, never by
		// weakening this assertion. `findDrift` pairs an example only where a title is
		// present on both sides, so an untitled `@example` block is outside this case. Each
		// collected line is the spec, the key, and each side's text or `absent` — the same
		// worklist `npm run docs` prints, so a failure here is read the way that command's
		// output is.
		it('keeps every compared summary and example equal to its source', () => {
			const disagreeing: string[] = []
			for (const drift of findDrift(guide, source)) {
				const left = drift.guide === undefined ? 'absent' : JSON.stringify(drift.guide)
				const right = drift.source === undefined ? 'absent' : JSON.stringify(drift.source)
				disagreeing.push(`${entry.spec} ${drift.key}: guide ${left} source ${right}`)
			}
			expect(disagreeing).toEqual([])
		})

		it('documents an example for every Surface function', () => {
			const fences = guide
				.fences()
				.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				.map((fence) => fence.code)
			const names = guide
				.surface()
				.filter((symbol) => symbol.keyword === 'function')
				.map((symbol) => symbol.name)
			expect(
				findUnexampled(
					names,
					fences,
					source.examples().map((example) => example.name),
				),
			).toEqual([])
		})

		for (const group of guide.methods()) {
			const entity = group.interface.replace(/Interface$/, '')
			const documented = group.methods.map((method) => method.name)
			const examples =
				entity === group.interface
					? source.examples(group.interface).map((example) => example.name)
					: source
							.examples(group.interface)
							.map((example) => example.name)
							.concat(source.examples(entity).map((example) => example.name))
			describe(`${group.interface} examples`, () => {
				it('documents an example for every method', () => {
					const fences = guide
						.fences()
						.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
						.map((fence) => fence.code)
					expect(findUnexampled(documented, fences, examples)).toEqual([])
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
