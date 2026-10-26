import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { get, writable, type Readable } from 'svelte/store'
import { reflection, expired, type StreamPart, type Push } from './reflection'
import type { Maybe } from './Maybe'

interface Pot {
	id: string
	VERSION: number
	DELETED?: number | null
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
		;(globalThis as { window?: unknown }).window = globalThis
	})

	afterEach(() => {
		delete (globalThis as { window?: unknown }).window
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

	it('should read no further where the stream says a read was the last', async () => {
		const { stream, asked } = server({
			'': [{ entry: pot('a', 1) }, { entry: pot('b', 1) }, { token: 'T1', final: true }],
			T1: [{ entry: pot('c', 1) }, { token: 'T2', final: true }]
		})

		const pots = reflection<Pot>({ name: db, stream })
		const all = pots.query('id')

		// whole after one read, which a read that brought entries otherwise is not
		expect(ids(await next(all))).toEqual(['a', 'b'])
		expect(asked).toEqual([undefined])

		expect(await pots.sync()).toBeNull()
		expect(asked).toEqual([undefined, 'T1'])
		expect(ids(await next(pots.query('id')))).toEqual(['a', 'b', 'c'])
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

	it('should answer the error of the read that was to make the copy whole, and the copy once a read succeeds', async () => {
		const reads: Record<string, Parts | Error> = { '': new Error('Refused') }
		const pots = reflection<Pot>({ name: db, stream: server(reads).stream })
		const all = pots.query('id')

		const failed = await next(all, (value) => value instanceof Error)

		expect(failed).toBeInstanceOf(Error)

		reads[''] = [{ entry: pot('a', 1) }, { token: null }]

		expect(await pots.sync()).toBeNull()
		expect(ids(await next(all, Array.isArray))).toEqual(['a'])
	})

	it('should go on answering from a whole copy where a later read fails', async () => {
		const { stream } = server({
			'': [{ entry: pot('a', 1) }, { token: 'T1' }],
			T1: [{ token: 'T2' }],
			T2: new Error('Refused')
		})

		const pots = reflection<Pot>({ name: db, stream })
		const all = pots.query('id')

		expect(ids(await next(all))).toEqual(['a'])
		expect(await pots.sync()).toBeInstanceOf(Error)
		expect(ids(get(all))).toEqual(['a'])
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

		const pots = reflection<Pot>({ name: db, stream })

		await pots.empty()

		expect(await next(pots.query('id'))).toEqual([])
		expect(asked).toEqual([])

		const all = pots.query('id')
		const read = next(all, (value) => Array.isArray(value) && value.length === 1)

		await pots.sync()

		expect(ids(await read)).toEqual(['a'])
	})

	it('should do nothing where a read has already started', async () => {
		const { stream } = server({
			'': [{ entry: pot('a', 1) }, { token: 'T1' }],
			T1: [{ token: 'T2' }]
		})

		const pots = reflection<Pot>({ name: db, stream })
		const all = pots.query('id')

		expect(ids(await next(all, (value) => Array.isArray(value) && value.length === 1))).toEqual(['a'])

		await pots.empty()

		const seen: Array<Maybe<Pot[]>> = []
		const unsubscribe = all.subscribe((value) => seen.push(value))

		await new Promise((resolve) => setTimeout(resolve, 20))
		unsubscribe()

		expect(ids(seen.at(-1)!)).toEqual(['a'])
	})

	it('should read on the next start after the collection was said to be empty', async () => {
		const { stream, asked } = server({
			'': [{ entry: pot('a', 1) }, { token: 'T1' }],
			T1: [{ token: 'T2' }]
		})

		await reflection<Pot>({ name: db, stream }).empty()

		const later = reflection<Pot>({ name: db, stream })
		const all = next(later.query('id'), (value) => Array.isArray(value) && value.length === 1)

		expect(ids(await all)).toEqual(['a'])
		expect(asked[0]).toBeUndefined()
	})

	it('should answer null until the copy holds the whole collection', async () => {
		// the first page is held before the second is read, and answers nothing by itself
		const { stream } = server({
			'': [{ entry: pot('a', 1) }, { token: 'T1' }],
			T1: [{ entry: pot('b', 1) }, { token: 'T2' }],
			T2: [{ token: 'T3' }]
		})

		const pots = reflection<Pot>({ name: db, stream })
		const all = pots.query('id')

		const seen: Array<Maybe<Pot[]>> = []
		const unsubscribe = all.subscribe((value) => seen.push(value))

		await pots.sync()
		unsubscribe()

		expect(seen.filter((value) => value !== null).map(ids)).toEqual([['a', 'b']])
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

		await new Promise((resolve) => setTimeout(resolve, 10))

		const again = reflection<Pot>({ name: db, stream: async () => expired })

		await again.empty()

		expect(get(again.query('id'))).toBeNull()
		expect(await next(again.query('id'))).toEqual([])
	})

	it('should take the state a write answered without reading it', async () => {
		const { stream, asked } = server({
			'': [{ entry: pot('a', 1) }, { token: 'T1' }],
			T1: [{ token: 'T2' }]
		})

		const pots = reflection<Pot>({ name: db, stream, indexes: { type: 'type' } })

		const green = pots.query('type', 'green')
		const seen = next(green, (value) => Array.isArray(value) && value.length === 2)

		// the subscription reads once, and nothing reads after it
		await pots.sync()

		const reads = asked.length

		await pots.apply(pot('b', 1))

		expect(ids(await seen)).toEqual(['a', 'b'])
		expect(asked.length).toBe(reads)
	})

	it('should keep the copy where the state it is given is older', async () => {
		const { stream } = server({
			'': [{ entry: pot('a', 3, 'green', 'new') }, { token: 'T1' }],
			T1: [{ token: 'T2' }]
		})

		const pots = reflection<Pot>({ name: db, stream })

		await pots.sync()
		await pots.apply(pot('a', 2, 'green', 'old'))

		expect(await next(pots.query('id'))).toEqual([pot('a', 3, 'green', 'new')])
	})

	it('should take out an entry it is given deleted', async () => {
		const { stream } = server({
			'': [{ entry: pot('a', 1) }, { entry: pot('b', 1) }, { token: 'T1' }],
			T1: [{ token: 'T2' }]
		})

		const pots = reflection<Pot>({ name: db, stream })

		await pots.sync()
		await pots.apply({ ...pot('a', 2), DELETED: Date.now() })

		expect(ids(await next(pots.query('id')))).toEqual(['b'])
	})

	it('should take out an entry the application says has left, without reading', async () => {
		const { stream, asked } = server({
			'': [{ entry: pot('a', 1) }, { entry: pot('b', 1) }, { token: 'T1', final: true }]
		})

		const pots = reflection<Pot>({ name: db, stream })

		expect(ids(await next(pots.query('id')))).toEqual(['a', 'b'])

		await pots.remove('a')

		expect(ids(await next(pots.query('id')))).toEqual(['b'])
		expect(asked).toEqual([undefined])
	})

	it('should take the parts an event carries, without reading', async () => {
		const { stream, asked } = server({
			'': [{ entry: pot('a', 1) }, { token: 'T1', final: true }]
		})

		const pots = reflection<Pot>({ name: db, stream })

		expect(ids(await next(pots.query('id')))).toEqual(['a'])

		await pots.apply({ entry: pot('b', 1) })
		await pots.apply({ removed: 'a' })

		expect(ids(await next(pots.query('id')))).toEqual(['b'])
		expect(asked).toEqual([undefined])
	})

	it('should not bring back what was removed by an older state of it', async () => {
		const { stream } = server({
			'': [{ entry: pot('a', 1) }, { token: 'T1', final: true }]
		})

		const pots = reflection<Pot>({ name: db, stream })

		expect(ids(await next(pots.query('id')))).toEqual(['a'])

		await pots.apply({ removed: 'a', VERSION: 3 })
		await pots.apply({ entry: pot('a', 2) })
		await pots.apply(pot('a', 3))

		expect(ids(await next(pots.query('id')))).toEqual([])

		// a later version is the entry again
		await pots.apply({ entry: pot('a', 4) })

		expect(ids(await next(pots.query('id')))).toEqual(['a'])
	})

	it('should not bring back what was removed with no version said, until a read does', async () => {
		const reads: Record<string, Parts> = {
			'': [{ entry: pot('a', 1) }, { token: 'T1' }],
			T1: [{ token: 'T1' }]
		}

		const { stream } = server(reads)
		const pots = reflection<Pot>({ name: db, stream })

		expect(ids(await next(pots.query('id')))).toEqual(['a'])

		await pots.remove('a')
		await pots.apply({ entry: pot('a', 9) })

		expect(ids(await next(pots.query('id')))).toEqual([])

		// the read began after the entry was said to have left, and it is the collection that says
		await new Promise((resolve) => setTimeout(resolve, 2))
		reads.T1 = [{ entry: pot('a', 2) }, { token: 'T2' }]
		reads.T2 = [{ token: 'T2' }]
		await pots.sync()

		expect(ids(await next(pots.query('id')))).toEqual(['a'])
	})

	it('should keep an entry where it is said to have left at a version the copy is past', async () => {
		const { stream } = server({
			'': [{ entry: pot('a', 5) }, { token: 'T1', final: true }]
		})

		const pots = reflection<Pot>({ name: db, stream })

		expect(ids(await next(pots.query('id')))).toEqual(['a'])

		await pots.apply({ removed: 'a', VERSION: 4 })

		expect(ids(await next(pots.query('id')))).toEqual(['a'])
	})

	it('should not let a read that began earlier undo what was applied meanwhile', async () => {
		let release: () => void = () => {}

		const held = new Promise<void>((resolve) => (release = resolve))

		// a server that keeps no history: the read is of the whole collection, as it was when it began
		const stream = async () =>
			(async function* (): AsyncGenerator<StreamPart<Pot>> {
				yield { entry: pot('a', 1) }
				yield { entry: pot('b', 1) }
				await held
				yield { token: null }
			})()

		const pots = reflection<Pot>({ name: db, stream })
		const query = pots.query('id')
		const stop = query.subscribe(() => {})

		await new Promise((resolve) => setTimeout(resolve, 5))

		// made and removed after the read began: it brings neither
		await pots.apply({ entry: pot('c', 1) })
		await pots.apply({ removed: 'a' })

		release()

		expect(ids(await next(query))).toEqual(['b', 'c'])

		stop()
	})

	it('should drop the copy and read the collection again when it is reset', async () => {
		const reads: Record<string, Parts> = {
			'': [{ entry: pot('a', 1) }, { token: 'T1', final: true }]
		}

		const { stream, asked } = server(reads)
		const pots = reflection<Pot>({ name: db, stream })

		expect(ids(await next(pots.query('id')))).toEqual(['a'])

		reads[''] = [{ entry: pot('b', 1) }, { token: 'T2', final: true }]

		expect(await pots.reset()).toBeNull()
		expect(asked).toEqual([undefined, undefined])
		expect(ids(await next(pots.query('id')))).toEqual(['b'])
	})

	it('should read the collection again where it is read under another scope', async () => {
		const reads: Record<string, Parts> = {
			'': [{ entry: pot('a', 1) }, { token: 'T1', final: true }],
			T1: [{ token: 'T2' }]
		}

		let scope = 'all'

		const { stream, asked } = server(reads)
		const pots = reflection<Pot>({ name: db, stream, scope: () => scope })

		expect(ids(await next(pots.query('id')))).toEqual(['a'])

		// the same scope: the token continues
		expect(await pots.sync()).toBeNull()
		expect(asked).toEqual([undefined, 'T1'])

		scope = 'green'
		reads[''] = [{ entry: pot('b', 1) }, { token: 'T3', final: true }]

		expect(await pots.sync()).toBeNull()
		expect(asked).toEqual([undefined, 'T1', undefined])
		expect(ids(await next(pots.query('id')))).toEqual(['b'])
	})

	it('should refuse an index it was not given', () => {
		const pots = reflection<Pot>({ name: db, stream: async () => expired })

		expect(() => pots.query('type')).toThrow(/not declared/)
	})

	it('should not fall back to the request on a server', async () => {
		delete (globalThis as { window?: unknown }).window

		const fetched: string[] = []

		const pots = reflection<Pot>({
			name: db,
			stream: async () => expired,
			get: async (id) => {
				fetched.push(id)

				return pot(id, 1)
			}
		})

		const one = pots.get('a')
		const unsubscribe = one.subscribe(() => {})

		await new Promise((resolve) => setTimeout(resolve, 10))
		unsubscribe()

		expect(fetched).toEqual([])
	})
})

describe('a reflection written on the device', () => {
	let db: string

	beforeEach(() => {
		db = name()
		;(globalThis as { window?: unknown }).window = globalThis
	})

	afterEach(() => {
		delete (globalThis as { window?: unknown }).window
	})

	/** A server that merges what is pushed field by field over what it holds, and answers the states. */
	function merging(held: Record<string, Pot> = {}) {
		const sent: Array<Array<Push<Pot>>> = []
		let failing: Error | null = null

		const push = async (changes: Array<Push<Pot>>): Promise<Pot[] | Error> => {
			sent.push(changes)

			if (failing !== null) return failing

			return changes.map(({ id, set }) => {
				const before = held[id] ?? { id, VERSION: 0, type: 'green', title: '' }
				const after: Pot = set === null
					? { ...before, VERSION: before.VERSION + 1, DELETED: 1 }
					: { ...before, ...set, id, VERSION: before.VERSION + 1 }

				held[id] = after

				return after
			})
		}

		return { push, sent, held, fail: (error: Error | null) => (failing = error) }
	}

	const empty = () => server({ '': [{ token: 'T1', final: true }], T1: [{ token: 'T2' }], T2: [{ token: 'T3' }] })
	const titles = (value: Maybe<Pot[]>) => (Array.isArray(value) ? value.map((pot) => `${pot.id}:${pot.title}`) : value)

	it('should answer what is written at once, and exchange nothing while sync is off', async () => {
		const { stream, asked } = empty()
		const { push, sent } = merging()
		const pots = reflection<Pot>({ name: db, stream, push, sync: writable(false), delay: 60_000 })

		await pots.write('a', { title: 'mine', type: 'green' })

		expect(titles(await next(pots.query('id')))).toEqual(['a:mine'])
		expect(await pots.sync()).toBeNull()
		expect(asked).toEqual([])
		expect(sent).toEqual([])
	})

	it('should push what was written with the VERSION it was written over, and take the answer as the state', async () => {
		const { stream } = empty()
		const { push, sent } = merging()
		const pots = reflection<Pot>({ name: db, stream, push, delay: 60_000 })

		await pots.write('a', { title: 'mine' })
		expect(await pots.sync()).toBeNull()

		expect(sent).toEqual([[{ id: 'a', base: 0, set: { title: 'mine' } }]])
		expect(await next(pots.get('a'))).toMatchObject({ id: 'a', title: 'mine', VERSION: 1 })

		// nothing is pending any more: a later sync sends nothing
		expect(await pots.sync()).toBeNull()
		expect(sent.length).toBe(1)
	})

	it('should keep what was written over a newer state the server streams or tells of', async () => {
		const { stream } = server({ '': [{ entry: pot('a', 1, 'green', 'a') }, { token: 'T1', final: true }], T1: [{ token: 'T2' }] })
		const { push } = merging()
		const pots = reflection<Pot>({ name: db, stream, push, sync: writable(false), delay: 60_000 })

		await pots.write('a', { title: 'mine' })
		await pots.apply(pot('a', 2, 'blue', 'theirs'))

		expect(await next(pots.get('a'), (value) => value !== null && (value as Pot).type === 'blue')).toMatchObject({ title: 'mine', type: 'blue', VERSION: 2 })
	})

	it('should take what the server kept, as it answers a push', async () => {
		const { stream } = empty()
		const { push, held } = merging({ a: pot('a', 3, 'green', 'theirs') })
		const pots = reflection<Pot>({ name: db, stream, push, delay: 60_000 })

		// a server that keeps its own title answers it
		const keeping = async (changes: Array<Push<Pot>>) => {
			await push(changes)

			return [{ ...held.a, title: 'theirs' }]
		}

		const kept = reflection<Pot>({ name: db, stream, push: keeping, delay: 60_000 })

		await pots.write('a', { title: 'mine' })
		expect(await kept.sync()).toBeNull()
		expect(await next(kept.get('a'))).toMatchObject({ title: 'theirs' })
	})

	it('should hide a deletion at once, and push it', async () => {
		const { stream } = server({ '': [{ entry: pot('a', 1) }, { entry: pot('b', 1) }, { token: 'T1', final: true }], T1: [{ token: 'T2' }] })
		const { push, sent } = merging({ a: pot('a', 1), b: pot('b', 1) })
		const pots = reflection<Pot>({ name: db, stream, push, delay: 60_000 })

		expect(ids(await next(pots.query('id'), (value) => Array.isArray(value) && value.length === 2))).toEqual(['a', 'b'])

		await pots.write('a', null)
		expect(ids(await next(pots.query('id')))).toEqual(['b'])

		expect(await pots.sync()).toBeNull()
		expect(sent).toEqual([[{ id: 'a', base: 1, set: null }]])
		expect(ids(await next(pots.query('id')))).toEqual(['b'])
	})

	it('should forget an entry the server never had once it is deleted, and push nothing of it', async () => {
		const { stream } = empty()
		const { push, sent } = merging()
		const pots = reflection<Pot>({ name: db, stream, push, delay: 60_000 })

		await pots.write('a', { title: 'draft' })
		await pots.write('a', null)

		expect(await pots.sync()).toBeNull()
		expect(sent).toEqual([])
		expect(ids(await next(pots.query('id')))).toEqual([])
	})

	it('should keep what was written where a push fails, and send it again', async () => {
		const { stream } = empty()
		const { push, sent, fail } = merging()
		const pots = reflection<Pot>({ name: db, stream, push, delay: 60_000 })

		fail(new Error('offline'))
		await pots.write('a', { title: 'mine' })

		expect(await pots.sync()).toBeInstanceOf(Error)
		expect(titles(await next(pots.query('id')))).toEqual(['a:mine'])

		fail(null)

		expect(await pots.sync()).toBeNull()
		expect(sent.length).toBe(2)
		expect(await next(pots.get('a'))).toMatchObject({ title: 'mine', VERSION: 1 })
	})

	it('should keep a write made while a push was on its way, over the state it answered', async () => {
		const { stream } = empty()
		const { push: merge } = merging()
		const device: { pots?: ReturnType<typeof reflection<Pot>> } = {}

		// the device writes again while the server is merging the first push
		let writing = true

		const push = async (changes: Array<Push<Pot>>) => {
			if (writing) {
				writing = false
				await device.pots?.write('a', { title: 'later' })
			}

			return await merge(changes)
		}

		const pots = reflection<Pot>({ name: db, stream, push, delay: 60_000 })

		device.pots = pots

		await pots.write('a', { title: 'first' })
		expect(await pots.sync()).toBeNull()

		expect(await next(pots.get('a'), (value) => value !== null && (value as Pot).title === 'later')).toMatchObject({ title: 'later' })
	})

	it('should keep what was written when the copy is read again from the start', async () => {
		const { stream } = server({ '': [{ entry: pot('b', 1) }, { token: 'T1', final: true }], T1: [{ token: 'T2' }] })
		const pots = reflection<Pot>({ name: db, stream, push: async () => new Error('offline'), delay: 60_000 })

		await pots.write('a', { title: 'mine' })
		await pots.reset()

		expect(ids(await next(pots.query('id'), (value) => Array.isArray(value) && value.length === 2))).toEqual(['a', 'b'])
	})

	it('should take the entries of another copy as written, and delete that copy', async () => {
		const { stream } = empty()
		const { push, sent } = merging()
		const local = reflection<Pot>({ name: `${db}-local`, stream, push, sync: writable(false), delay: 60_000 })
		const account = reflection<Pot>({ name: db, stream, push, delay: 60_000 })

		await local.write('a', { title: 'mine', type: 'green' })
		await account.absorb(local)

		expect(titles(await next(account.query('id')))).toEqual(['a:mine'])
		expect(await account.sync()).toBeNull()
		expect(sent).toEqual([[{ id: 'a', base: 0, set: { title: 'mine', type: 'green' } }]])
		expect(ids(await next(local.query('id'), (value) => Array.isArray(value)))).toEqual([])
	})

	it('should refuse a write where it has no push', async () => {
		const pots = reflection<Pot>({ name: db, stream: async () => expired })

		await expect(pots.write('a', { title: 'x' })).rejects.toThrow(/without `push`/)
	})
})

