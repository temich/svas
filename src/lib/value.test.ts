import { describe, it, expect, afterEach } from 'vitest'
import { get } from 'svelte/store'
import { value } from './value'
import { collection } from './collection'
import { values } from './values'

/** A request that counts its calls. */
function counted<T>(answer: T) {
	const calls = { count: 0 }
	const request = async () => {
		calls.count++

		return answer
	}

	return { calls, request }
}

describe('on a server', () => {
	it('a value fetches nothing', () => {
		const { calls, request } = counted(1)

		expect(get(value({ get: request }))).toBeNull()
		expect(calls.count).toBe(0)
	})

	it('a collection fetches nothing', () => {
		const { calls, request } = counted([{ id: 'a' }])

		expect(get(collection({ get: request }))).toBeNull()
		expect(calls.count).toBe(0)
	})

	it('values fetch nothing', () => {
		const { calls, request } = counted(1)

		expect(get(values({ get: request }).get('a'))).toBeNull()
		expect(calls.count).toBe(0)
	})
})

describe('in a browser', () => {
	afterEach(() => {
		delete (globalThis as { window?: unknown }).window
	})

	it('a value fetches on subscribe', async () => {
		;(globalThis as { window?: unknown }).window = globalThis

		const { calls, request } = counted(1)
		const store = value({ get: request })

		get(store)
		await Promise.resolve()

		expect(calls.count).toBe(1)
		expect(get(store)).toBe(1)
	})
})
