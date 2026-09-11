// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants that follow are this
// package's own, as is the executed section that closes the file.
//
// This project runs in Node with the browser disabled, so it cannot execute a fence that
// touches `window`: the `@orkestrel/router/browser` fences are transcribed in
// `tests/src/browser/Navigator.test.ts` instead, and the `@orkestrel/router/server` fences
// are covered by `tests/src/server/handlers.test.ts` over real `node:http` sockets.

import { GuideCommand } from '@orkestrel/guide/server'
import { readInventory } from '@orkestrel/test/server'
import { createVitest } from 'vitest/node'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** The one guide this package sources, whose tagline the README pitch equals. */
const GUIDE_SPEC = 'guides/router.md'
/** The package identity that binds its manifest, module map, and README pitch. */
const PACKAGE_NAME = '@orkestrel/router'
/**
 * Each import specifier this package's own guides may resolve against — the router
 * guide spans the core, browser, and server faces, so a fence importing any of them
 * resolves against that face's own exports rather than only the current entry's.
 */
const MODULES = Object.freeze({
	[PACKAGE_NAME]: 'src/core',
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

await new GuideCommand({
	root: new URL('../', import.meta.url),
	patterns: ['src/**/*.ts', 'tests/**/*.ts', 'guides/*.md', '*.md', 'package.json'],
	modules: MODULES,
	languages: FENCE_LANGUAGES,
	language: EXAMPLE_LANGUAGE,
	reader: readInventory,
	runner: createVitest,
}).execute(async ({ files, report, rows }) => {
	const { isRecord, parseJSON } = await import('@orkestrel/contract')
	const { computeSymbolKey, findMissingSymbols } = await import('@orkestrel/guide')
	const { requireValue } = await import('@orkestrel/test')
	const { createDispatcher, createRouter, defineRoute } = await import('@src/core')
	const { describe, expect, it } = await import('vitest')
	const manifest = parseJSON(requireValue(files['package.json'], 'Missing inventory: package.json'))
	if (!isRecord(manifest)) throw new Error('Invalid package manifest: package.json')

	it('manifest lists at least one guide', () => {
		expect(report.input).toEqual([])
		expect(rows.length).toBeGreaterThan(0)
		expect(rows.map((row) => row.entry.spec)).toContain(GUIDE_SPEC)
	})

	// The example comparison is silent over an empty title population. This assertion pins
	// the title intersection contributed by this package's own guide and source.
	it('pairs at least one example title across the guide and the source', () => {
		expect(report.examples.titles.filter((finding) => finding.spec === GUIDE_SPEC)).toEqual([])
	})

	// The manifest identity prevents a wrong package name from silently selecting no guide
	// and suppressing the README pitch comparison.
	it('opens the README with the guide tagline', () => {
		expect(manifest.name).toBe(PACKAGE_NAME)
		expect(report.pitch).toEqual([])
	})

	for (const { entry, guide, source } of rows) {
		describe(`${entry.concept}`, () => {
			it('uses only listed fence languages', () => {
				expect(report.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
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

			it('documents a populated method group', () => {
				expect(report.sections.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('keeps behavioral interfaces and implementing classes in parity', () => {
				expect(report.methods.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			// The equality gate: a `Summary` cell against its export's description paragraph, a
			// titled fence against the `@example` of that title. The shared report owns the
			// comparison and names both sides; converge through the native entry, never by
			// weakening this assertion. `findDrift` pairs an example only where a title is
			// present on both sides, so an untitled `@example` block is outside this case. Each
			// collected line is the spec, the key, and each side's text or `absent` — the same
			// worklist the native entry prints. Select source authority with `--to guide`, or
			// guide authority with `--to source`.
			it('keeps every compared summary and example equal to its source', () => {
				expect(report.drift.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('documents an example for every Surface function', () => {
				expect(report.examples.functions.filter((finding) => finding.spec === entry.spec)).toEqual(
					[],
				)
			})

			it('documents an example for every method', () => {
				expect(report.examples.methods.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('imports only real exports in every ```ts fence', () => {
				expect(report.imports.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('resolves every relative link', () => {
				expect(report.links.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})
			it('links only to test files that exist', () => {
				expect(report.tests.filter((finding) => finding.spec === entry.spec)).toEqual([])
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
})
