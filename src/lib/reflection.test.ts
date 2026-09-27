import { describe, it, expect, beforeEach } from 'vitest'
import { get, writable, type Readable } from 'svelte/store'
import { reflection, expired, type StreamPart } from './reflection'
import type { Maybe } from './Maybe'

interface Pot {
	id: string
	VERSION: number
	type: string
	title: string
}

type Parts = Array<StreamPart<Pot>>

/** A server: what it answers from each token, and the tokens it was asked with. */
function server(reads: Record<string, Parts | typeof expired | Error>) {
	const asked: Array<string | undefined> = []

	const stream = async (token: string | undefined) => {
		asked.push(token)

		const answer = reads[token ?? '']

		if (answer === undefined) throw new Error(`Unexpected read from ${token}`)
		if (answer === expired) return expired
		if (answer instanceof Error) throw answer

		return (async function* () {
			for (const part of answer) yield part
		})()
	}

	return { stream, asked }
}

let n = 0
const name = () => `pots-${++n}`

const pot = (id: string, VERSION: number, type = 'green', title = id): Pot => ({ id, VERSION, type, title })

/** The next value a store takes that satisfies the test. */
function next<T>(store: Readable<T>, test: (value: T) => boolean = (value) => value !== null): Promise<T> {
	return new Promise((resolve) => {
		let unsubscribe: () => void = () => {}

		unsubscribe = store.subscribe((value) => {
			if (!test(value)) return

			queueMicrotask(() => unsubscribe())
			resolve(value)
		})
	})
}

const ids = (value: Maybe<Pot[]>) => (Array.isArray(value) ? value.map((pot) => pot.id) : value)

describe('reflection', () => {
	let db: string

	beforeEach(() => {
		db = name()
	})

	it('should read the collection in pages, then what changed, and answer queries from the copy', async () => {
		const { stream, asked } = server({
			'': [{ entry: pot('a', 1) }, { entry: pot('b', 1) }, { token: 'T1' }],
			T1: [{ entry: pot('c', 1) }, { token: 'T2' }],
			T2: [{ token: 'T3' }]
		})

		const pots = reflection<Pot>({ name: db, stream, indexes: { type: 'type' } })
		const green = await next(pots.query('type', 'green'))

		expect(ids(green)).toEqual(['a', 'b', 'c'])
		expect(asked).toEqual([undefined, 'T1', 'T2'])
	})

	it('should keep the higher version and drop what was removed', async () => {
		const { stream } = server({
			'': [{ entry: pot('a', 2, 'green', 'new') }, { entry: pot('b', 1) }, { token: 'T1' }],
			T1: [{ entry: pot('a', 1, 'green', 'old') }, { removed: 'b' }, { token: 'T2' }],
			T2: [{ token: 'T3' }]
		})

		const pots = reflection<Pot>({ name: db, stream })

		await pots.sync()

		const all = await next(pots.query('id'))

		expect(all).toEqual([pot('a', 2, 'green', 'new')])
	})

	it('should keep nothing of a read that was cut, and read it again', async () => {
		const reads: Record<string, Parts> = {
			'': [{ entry: pot('a', 1) }, { token: 'T1' }],
			T1: [{ entry: pot('b', 1) }]
		}

		const { stream, asked } = server(reads)
		const pots = reflection<Pot>({ name: db, stream })

		const error = await pots.sync()

		expect(error?.message).toMatch(/cut/)

		reads.T1 = [{ entry: pot('b', 1) }, { token: 'T2' }]
		reads.T2 = [{ token: 'T3' }]

		expect(await pots.sync()).toBeNull()
		expect(asked).toEqual([undefined, 'T1', 'T1', 'T2'])
		expect(ids(await next(pots.query('id')))).toEqual(['a', 'b'])
	})

	it('should read the collection again when the server no longer continues from the token', async () => {
		const reads: Record<string, Parts | typeof expired> = {
			'': [{ entry: pot('a', 1) }, { entry: pot('b', 1) }, { token: 'T1' }],
			T1: [{ token: 'T2' }]
		}

		const { stream, asked } = server(reads)
		const pots = reflection<Pot>({ name: db, stream })

		await pots.sync()

		reads.T2 = expired
		reads[''] = [{ entry: pot('c', 1) }, { token: 'T9' }]
		reads.T9 = [{ token: 'T10' }]

		expect(await pots.sync()).toBeNull()
		expect(asked.slice(2)).toEqual(['T2', undefined, 'T9'])
		expect(ids(await next(pots.query('id')))).toEqual(['c'])
	})

	it('should sweep what a whole read no longer finds, where the server keeps no history', async () => {
		const reads: Record<string, Parts> = {
			'': [{ entry: pot('a', 1) }, { entry: pot('b', 1) }, { token: null }]
		}

		const { stream } = server(reads)
		const pots = reflection<Pot>({ name: db, stream })

		await pots.sync()

		reads[''] = [{ entry: pot('b', 2) }, { token: null }]

		await pots.sync()

		expect(await next(pots.query('id'))).toEqual([pot('b', 2)])
	})

	it('should answer an empty collection at once, and read nothing until asked', async () => {
		const { stream, asked } = server({
			'': [{ entry: pot('a', 1) }, { token: 'T1' }],
			T1: [{ token: 'T2' }]
		})

		const pots = reflection<Pot>({ name: db, stream, empty: true })

		expect(await next(pots.query('id'))).toEqual([])
		expect(asked).toEqual([])

		const all = pots.query('id')
		const read = next(all, (value) => Array.isArray(value) && value.length === 1)

		await pots.sync()

		expect(ids(await read)).toEqual(['a'])
	})

	it('should answer null until the copy holds the whole collection', async () => {
		const { stream } = server({ '': [{ entry: pot('a', 1) }] })
		const pots = reflection<Pot>({ name: db, stream })
		const all = pots.query('id')

		const seen: Array<Maybe<Pot[]>> = []
		const unsubscribe = all.subscribe((value) => seen.push(value))

		await pots.sync()
		unsubscribe()

		expect(seen.every((value) => value === null)).toBe(true)
	})

	it('should answer an entry from the copy, and from get where the copy holds none', async () => {
		const { stream } = server({
			'': [{ entry: pot('a', 1) }, { token: 'T1' }],
			T1: [{ token: 'T2' }]
		})

		const fetched: string[] = []

		const pots = reflection<Pot>({
			name: db,
			stream,
			get: async (id) => {
				fetched.push(id)

				return id === 'old' ? pot('old', 7) : null
			}
		})

		await pots.sync()

		expect(await next(pots.get('a'))).toEqual(pot('a', 1))
		expect(await next(pots.get('old'))).toEqual(pot('old', 7))
		expect(fetched).toEqual(['old'])
	})

	it('should answer an entry the copy takes later from the copy', async () => {
		const reads: Record<string, Parts> = {
			'': [{ token: 'T1' }],
			T1: [{ token: 'T2' }]
		}

		const { stream } = server(reads)
		const pots = reflection<Pot>({ name: db, stream, get: async (id) => pot(id, 1, 'green', 'fetched') })

		await pots.sync()

		const one = pots.get('a')

		expect((await next(one)) as Pot).toEqual(pot('a', 1, 'green', 'fetched'))

		reads.T2 = [{ entry: pot('a', 3, 'green', 'copied') }, { token: 'T3' }]
		reads.T3 = [{ token: 'T4' }]

		const copied = next(one, (value) => (value as Pot | null)?.title === 'copied')

		await pots.sync()

		expect(((await copied) as Pot).VERSION).toBe(3)
	})

	it('should re-read a query only where a change falls in its range', async () => {
		const reads: Record<string, Parts> = {
			'': [{ entry: pot('a', 1, 'green') }, { entry: pot('b', 1, 'brown') }, { token: 'T1' }],
			T1: [{ token: 'T2' }]
		}

		const { stream } = server(reads)
		const pots = reflection<Pot>({ name: db, stream, indexes: { type: 'type' } })

		await pots.sync()

		const green = pots.query('type', 'green')
		const values: Array<Maybe<Pot[]>> = []
		const unsubscribe = green.subscribe((value) => values.push(value))

		await next(green)

		const before = values.length

		reads.T2 = [{ entry: pot('b', 2, 'brown') }, { token: 'T3' }]
		reads.T3 = [{ token: 'T4' }]

		await pots.sync()
		unsubscribe()

		expect(values.length).toBe(before)
	})

	it('should order and bound a query', async () => {
		const { stream } = server({
			'': [
				{ entry: pot('a', 1, 'green', 'x') },
				{ entry: pot('b', 1, 'green', 'y') },
				{ entry: pot('c', 1, 'green', 'z') },
				{ token: 'T1' }
			],
			T1: [{ token: 'T2' }]
		})

		const pots = reflection<Pot>({ name: db, stream, indexes: { title: 'title' } })

		await pots.sync()

		const last = await next(pots.query('title', { gte: 'x' }, { order: 'desc', limit: 2 }))

		expect(ids(last)).toEqual(['c', 'b'])
	})

	it('should delete the copy when the bound store is null', async () => {
		const account = writable<unknown>({ id: 'me' })
		const { stream } = server({
			'': [{ entry: pot('a', 1) }, { token: 'T1' }],
			T1: [{ token: 'T2' }]
		})

		const pots = reflection<Pot>({ name: db, stream, bind: account })

		await pots.sync()
		expect(ids(await next(pots.query('id')))).toEqual(['a'])

		account.set(null)

		const again = reflection<Pot>({ name: db, stream: async () => expired, empty: true })

		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(get(again.query('id'))).toBeNull()
		expect(await next(again.query('id'))).toEqual([])
	})

	it('should refuse an index it was not given', () => {
		const pots = reflection<Pot>({ name: db, stream: async () => expired })

		expect(() => pots.query('type')).toThrow(/not declared/)
	})
})
