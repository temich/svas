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

	// a template or a `$derived` reads a store: what it reads may not change as it reads, which
	// Svelte refuses (`state_unsafe_mutation`) and stops the page's updates
	it('values read stale are emptied after the read, not by it', async () => {
		;(globalThis as { window?: unknown }).window = globalThis

		const store = values<number>({ get: async () => 2, revalidate: 0 })

		store.set('a', 1)

		const read = store.get('a')

		expect(get(read)).toBe(1)

		await Promise.resolve()

		expect(get(read)).toBe(2)
	})

	it('a collection read stale is emptied after the read, not by it', async () => {
		;(globalThis as { window?: unknown }).window = globalThis

		const { calls, request } = counted([{ id: 'b' }])
		const items = collection({ get: request, revalidate: 0 })

		items.replace([{ id: 'a' }])
		await new Promise((resolve) => setTimeout(resolve, 2))

		let seen: unknown = undefined
		const unsubscribe = items.subscribe((value) => (seen = value))

		expect(seen).toEqual([{ id: 'a' }])

		await Promise.resolve()
		await Promise.resolve()

		expect(get(items)).toEqual([{ id: 'b' }])
		expect(calls.count).toBe(1)

		unsubscribe()
	})
})
