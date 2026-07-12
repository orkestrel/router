# @orkestrel/emitter

A typed, **synchronous** event emitter — the foundational observable
primitive that stateful entities (a queue, a database table, an agent) own to
expose their lifecycle transitions and observable operations. Deliberately
small: no scheduler (listeners fire in the current tick, in registration
order), no listener cap, no `console` output. What it does carry is the one
invariant a fan-out primitive can't omit — a throwing listener is isolated so
it can never take down its siblings or the emit loop; the throw routes to an
optional `error` handler instead of being rethrown. Part of the `@orkestrel`
line.

## Install

```sh
npm install @orkestrel/emitter
```

## Requirements

- Node.js >= 24
- ESM-only (no CommonJS build)

## Usage

```ts
import { createEmitter } from '@orkestrel/emitter'

// The event map names each event and the argument tuple its listeners receive.
type ClockEventMap = {
	tick: readonly [at: number]
	done: readonly []
}

const clock = createEmitter<ClockEventMap>({
	on: { done: () => stop() }, // initial listeners wired at construction
	error: (cause, event) => logger.warn(`listener for "${event}" threw`, cause),
})

clock.on('tick', (at) => render(at)) // `at` is typed `number` from the map
clock.emit('tick', Date.now()) // synchronous — every `tick` listener runs now
clock.once('done', () => cleanup()) // removes itself after its first call
clock.off('tick', render) // remove a listener by its original handler
clock.count() // live listener count, total or per-event
clock.clear() // drop listeners, total or per-event; emitter stays usable
clock.destroy() // teardown — drops every listener, flips `destroyed`
```

`createEmitter(options)` (or `new Emitter(options)`) returns an
`EmitterInterface<TMap>`. The reserved `on` option wires initial listeners at
construction; the optional `error` option receives any listener's throw as
`(error, event)` so `emit` never has to rethrow — with no `error` handler, a
throw is swallowed silently. `emit` never stops on a throw: every listener
runs regardless, and every throw surfaces (not just the first).

## Guide

For the full surface — the `Emitter` class, `EmitterInterface`, and the
listener-isolation contract — see
[`guides/src/emitter.md`](guides/src/emitter.md).

## Package

Published as a single typed entry point per the `exports` field in
`package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
