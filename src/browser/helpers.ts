// The PURE browser-navigation primitives (AGENTS §4.3 multi-word names — module
// scope, no entity context). Every one is exported (the centralized-file rule,
// §5): the `Navigator` composes them, and each has its own unit test. NO `node:*`
// — DOM-typed only (`Location`, `Event`, `HTMLAnchorElement`), valid under the
// `src:browser` scoped check (AGENTS §17.7).

/**
 * Extract the `/`-prefixed pathname from a `location.hash` value — strip the
 * leading `#` (keeping the route's own leading `/`) and any `?query` suffix.
 *
 * @remarks
 * The grammar this package matches everywhere is `/`-prefixed (§4 path
 * grammar), so a hash-mode location's `'#/users/7?x'` becomes `'/users/7'`
 * — a hash pattern is expected to start `'#/'`; anything else (an empty hash,
 * or one that does not begin `'#/'`) yields `''` (the `Navigator` then falls
 * back). Total — never throws.
 *
 * @param hash - The raw `window.location.hash` value (e.g. `'#/users/7?x'`)
 * @returns The `/`-prefixed pathname to match, or `''` for an empty / non-`#/` hash
 *
 * @example
 * ```ts
 * extractHashPath('#/users/7?x') // '/users/7'
 * extractHashPath('#/tokens') // '/tokens'
 * extractHashPath('') // '' — the Navigator falls back
 * extractHashPath('#other') // '' — not a `#/` route hash
 * ```
 */
export function extractHashPath(hash: string): string {
	if (!hash.startsWith('#/')) return ''
	const withoutHash = hash.slice(1)
	const queryIndex = withoutHash.indexOf('?')
	return queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex)
}

/**
 * Resolve the `/`-prefixed pathname to match for the CURRENT location, in
 * either navigation mode — the one seam `extractHashPath` (hash mode) and
 * history-mode base-stripping share.
 *
 * @remarks
 * Hash mode (`history: false`) reads `location.hash` through
 * {@link extractHashPath}. History mode (`history: true`) reads
 * `location.pathname` and strips a leading `base` prefix when one is
 * configured: `base` itself maps to the root `'/'`; a pathname that is not
 * under `base` is returned unchanged (a base mismatch is not this helper's
 * concern — the `Navigator`'s match then simply misses). Total — never throws.
 *
 * @param location - The `hash` + `pathname` pair to resolve from (accepts a
 *   real `Location` or any object shaped the same, for pure unit testing)
 * @param history - The navigation substrate: `false` for hash mode, `true`
 *   for history mode
 * @param base - The history-mode path prefix to strip (ignored in hash mode;
 *   omit for no prefix)
 * @returns The `/`-prefixed pathname to match
 *
 * @example
 * ```ts
 * resolveLocationPath({ hash: '#/users/7', pathname: '/' }, false) // '/users/7'
 * resolveLocationPath({ hash: '', pathname: '/app/users/7' }, true, '/app') // '/users/7'
 * resolveLocationPath({ hash: '', pathname: '/app' }, true, '/app') // '/'
 * resolveLocationPath({ hash: '', pathname: '/other/users' }, true, '/app') // '/other/users'
 * ```
 */
export function resolveLocationPath(
	location: Pick<Location, 'hash' | 'pathname'>,
	history: boolean,
	base?: string,
): string {
	if (!history) return extractHashPath(location.hash)
	const pathname = location.pathname
	if (base === undefined || base === '') return pathname
	const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base
	if (pathname === normalizedBase) return '/'
	if (pathname.startsWith(`${normalizedBase}/`)) return pathname.slice(normalizedBase.length)
	return pathname
}

/**
 * Find the nearest enclosing `<a>` element a DOM event originated from, by
 * walking its composed path — the pure lookup behind history-mode link
 * interception.
 *
 * @remarks
 * Uses `event.composedPath()` (not `event.target`) so a click on a styled
 * child INSIDE an anchor (an icon, a span) still resolves to the anchor.
 * Total — never throws; returns `undefined` when no anchor is found on the
 * path.
 *
 * @param event - The DOM event to search (typically a `click`)
 * @returns The nearest enclosing `HTMLAnchorElement`, or `undefined`
 *
 * @example
 * ```ts
 * document.addEventListener('click', (event) => {
 * 	const anchor = findAnchor(event)
 * 	if (anchor !== undefined) console.log(anchor.href)
 * })
 * ```
 */
export function findAnchor(event: Event): HTMLAnchorElement | undefined {
	for (const node of event.composedPath()) {
		if (node instanceof HTMLAnchorElement) return node
	}
	return undefined
}
