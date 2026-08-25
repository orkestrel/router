import { describe, expect, it } from 'vitest'
import { createRecorder } from '@orkestrel/test'
import { createRouter } from '@src/core'
import { createEmitter } from '@orkestrel/emitter'
import type { NavigatorInterface } from '../src/browser/types.js'
import { drainNavigators } from './setupBrowser.js'

// The `setup` project runs in Node with the browser disabled, so only `drainNavigators` — the one
// export with no `window`/`document` dependency — is proven here. `settleHash`, `setHash`,
// `settleHistory`, `createAnchor`, `click`, and `safeClick` drive real `location`/`history`/DOM
// APIs and are proven by the consuming `src:browser` suites (for example
// `tests/src/browser/Navigator.test.ts`), which run in a real browser instance.

function createStubNavigator(
	recorder: ReturnType<typeof createRecorder<readonly [string]>>,
	id: string,
): NavigatorInterface<unknown> {
	return {
		router: createRouter(),
		emitter: createEmitter(),
		active: undefined,
		start: () => {},
		stop: () => {},
		navigate: () => {},
		match: () => undefined,
		destroy: () => recorder.handler(id),
	}
}

describe('drainNavigators', () => {
	it('destroys every tracked navigator and empties the array in place', () => {
		const recorder = createRecorder<readonly [string]>()
		const navigators = [
			createStubNavigator(recorder, 'a'),
			createStubNavigator(recorder, 'b'),
			createStubNavigator(recorder, 'c'),
		]
		drainNavigators(navigators)
		expect(navigators).toHaveLength(0)
		expect(recorder.calls.map(([id]) => id)).toEqual(['c', 'b', 'a'])
	})

	it('leaves an already-empty array untouched and destroys nothing', () => {
		const recorder = createRecorder<readonly [string]>()
		const navigators: Array<NavigatorInterface<unknown>> = []
		drainNavigators(navigators)
		expect(navigators).toHaveLength(0)
		expect(recorder.count).toBe(0)
	})
})
