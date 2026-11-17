import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import {
	countResponseListeners,
	decodeChunks,
	frameBody,
	handleDrain,
	parseResponses,
	startPausedResponse,
	startServer,
	WORKSPACE_ROOT,
} from './setupServer.js'

describe('WORKSPACE_ROOT', () => {
	it('anchors to the real workspace root, not an arbitrary ancestor', () => {
		expect(existsSync(WORKSPACE_ROOT + '/package.json')).toBe(true)
		expect(existsSync(WORKSPACE_ROOT + '/vite.config.ts')).toBe(true)
	})
})

describe('startServer', () => {
	it('binds a real socket on 127.0.0.1 and serves the passed listener', async () => {
		const server = await startServer((_request, response) => response.end('router-fixture'))
		try {
			expect(server.url.startsWith('http://127.0.0.1:')).toBe(true)
			expect(server.port).toBeGreaterThan(0)
			const response = await fetch(server.url)
			const body = await response.text()
			expect(body).toBe('router-fixture')
		} finally {
			await server.close()
		}
	})

	it('closes the real listening socket, so a request after close is refused', async () => {
		const server = await startServer((_request, response) => response.end('ok'))
		await server.close()
		await expect(fetch(server.url)).rejects.toThrow('fetch failed')
	})
})

describe('startPausedResponse', () => {
	it('returns a response paused before any body bytes are delivered to the client', async () => {
		const fixture = await startPausedResponse((_request, response) => {
			response.write('chunk')
			response.end()
		})
		try {
			expect(fixture.response.readableFlowing).not.toBe(true)
			expect(fixture.server.url.startsWith('http://127.0.0.1:')).toBe(true)
		} finally {
			fixture.request.destroy()
			await fixture.server.close()
		}
	})
})

describe('countResponseListeners', () => {
	it('reads the real listener totals installed on a live response, rising and falling with them', async () => {
		const server = await startServer((_request, response) => {
			const before = countResponseListeners(response)
			response.on('drain', handleDrain)
			const after = countResponseListeners(response)
			expect(after.drain).toBe(before.drain + 1)
			response.off('drain', handleDrain)
			const restored = countResponseListeners(response)
			expect(restored.drain).toBe(before.drain)
			response.end('done')
		})
		try {
			await fetch(server.url)
		} finally {
			await server.close()
		}
	})
})

describe('parseResponses', () => {
	it('frames a Content-Length response, then a chunked one, on one connection', () => {
		const bytes = Buffer.from(
			'HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\n\r\n' +
				'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\nsecond\r\n0\r\n\r\n',
		)

		expect(
			parseResponses(bytes, false, []).map((response) => [
				response.status,
				response.body,
				response.complete,
			]),
		).toEqual([
			[413, '', true],
			[200, 'second', true],
		])
	})

	it('ends a 304 at the blank line whatever its Content-Length says', () => {
		const bytes = Buffer.from(
			'HTTP/1.1 304 Not Modified\r\nContent-Length: 5\r\n\r\n' +
				'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok',
		)

		expect(
			parseResponses(bytes, false, []).map((response) => [response.status, response.body]),
		).toEqual([
			[304, ''],
			[200, 'ok'],
		])
	})

	it('ends a response to HEAD at the blank line whatever its Content-Length says', () => {
		const bytes = Buffer.from(
			'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n' +
				'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok',
		)

		expect(
			parseResponses(bytes, false, ['HEAD', 'GET']).map((response) => [
				response.status,
				response.body,
			]),
		).toEqual([
			[200, ''],
			[200, 'ok'],
		])
	})

	it('skips a trailer section after the last chunk', () => {
		const bytes = Buffer.from(
			'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\nX-Checksum: 1\r\n\r\n' +
				'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok',
		)

		expect(
			parseResponses(bytes, false, []).map((response) => [response.status, response.body]),
		).toEqual([
			[200, 'abc'],
			[200, 'ok'],
		])
	})

	it('keeps the request method of an interim 1xx for the final response', () => {
		const bytes = Buffer.from(
			'HTTP/1.1 100 Continue\r\n\r\n' +
				'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n' +
				'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok',
		)

		expect(
			parseResponses(bytes, false, ['HEAD', 'GET']).map((response) => [
				response.status,
				response.body,
			]),
		).toEqual([
			[100, ''],
			[200, ''],
			[200, 'ok'],
		])
	})

	it('reads a chunked response without its last chunk as incomplete', () => {
		const bytes = Buffer.from(
			'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\npartial\r\n',
		)

		expect(parseResponses(bytes, true, [])).toEqual([
			{
				status: 200,
				headers: { 'transfer-encoding': 'chunked' },
				body: 'partial',
				complete: false,
			},
		])
	})

	it('completes a close-delimited body only after the connection closed, and a 204 at once', () => {
		const open = Buffer.from('HTTP/1.0 200 OK\r\n\r\n{"url":"x"}')

		expect(parseResponses(open, false, [])[0]?.complete).toBe(false)
		expect(parseResponses(open, true, [])[0]?.body).toBe('{"url":"x"}')
		expect(
			parseResponses(Buffer.from('HTTP/1.1 204 No Content\r\n\r\n'), false, [])[0]?.complete,
		).toBe(true)
	})

	it('returns nothing before a status line and its headers arrived', () => {
		expect(parseResponses(Buffer.from('HTTP/1.1 200 OK\r\nContent-Le'), false, [])).toEqual([])
	})
})

describe('decodeChunks and frameBody', () => {
	it('stops where the chunked framing stops, a trailer section included', () => {
		expect(decodeChunks(Buffer.from('3\r\nabc\r\n0\r\n\r\nrest'), 0)).toEqual({
			body: 'abc',
			complete: true,
			end: 13,
		})
		expect(decodeChunks(Buffer.from('3\r\nabc\r\n0\r\nA: b\r\n\r\nrest'), 0)).toEqual({
			body: 'abc',
			complete: true,
			end: 19,
		})
		expect(decodeChunks(Buffer.from('3\r\nabc\r\n0\r\nA: b\r\n'), 0).complete).toBe(false)
	})

	it('frames by Content-Length, and a null-body response by its status or a HEAD request', () => {
		const bytes = Buffer.from('abcdef')

		expect(frameBody(bytes, 0, 200, { 'content-length': '10' }, false, false)).toEqual({
			body: 'abcdef',
			complete: false,
			end: 10,
		})
		expect(frameBody(bytes, 0, 304, { 'content-length': '6' }, false, false)).toEqual({
			body: '',
			complete: true,
			end: 0,
		})
		expect(frameBody(bytes, 0, 200, { 'content-length': '6' }, false, true)).toEqual({
			body: '',
			complete: true,
			end: 0,
		})
	})
})
