import { readable, type Readable, type Subscriber } from 'svelte/store'
import { open, remove, type Change, type Database, type Indexes, type Meta, type Part } from './reflection/idb'
import type { Maybe } from './Maybe'
import type { Comparable } from './sync'

/** What `stream` answers where the server no longer continues from the token it was given. */
export const expired: unique symbol = Symbol('expired')

/**
 * A copy of a collection a server streams, kept in IndexedDB and kept current. It reads the
 * collection once, and from then on what changed in it, from the token the last read ended with.
 * Queries answer from the copy.
 */
export class Reflection<T extends Comparable> {
  private readonly options: Options<T>
  private readonly indexes: Indexes
  private readonly queries = new Set<Query<T>>()
  private readonly entries = new Map<string, Entry<T>>()
  private readonly fallbacks = new Map<string, Promise<Maybe<T>>>()
  private readonly channel: BroadcastChannel | null

  private database: Promise<Database> | null = null
  private started = false

  /** the read in flight, and the one that starts after it */
  private syncing: Promise<Error | null> | null = null
  private queued: Promise<Error | null> | null = null

  public constructor(options: Options<T>) {
    this.options = options
    this.indexes = options.indexes ?? {}

    for (const name of Object.keys(this.indexes))
      if (name === 'id' || name === 'g') throw new Error(`Reflection: index '${name}' is reserved`)

    this.channel = available() && typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(`svas:${options.name}`)
      : null

    if (this.channel !== null) this.channel.onmessage = (event) => void this.changed(event.data)

    options.bind?.subscribe((value) => {
      if (value === null) void this.clear()
    })
  }

  /**
   * The entries an index range selects, in the order of the index: a key, or bounds of one.
   * `null` until the copy holds the whole collection.
   */
  public query(index: string, criteria?: Criteria, options?: QueryOptions): Readable<Maybe<T[]>> {
    if (index !== 'id' && !(index in this.indexes))
      throw new Error(`Reflection: index '${index}' is not declared`)

    const range = keyRange(criteria)

    return readable<Maybe<T[]>>(null, (set) => {
      const query: Query<T> = { index, range, options, set, path: this.indexes[index] ?? 'id' }

      this.queries.add(query)
      void this.run(query)
      this.start()

      return () => this.queries.delete(query)
    })
  }

  /** The entry of an id: from the copy, or from `get` where the copy holds none. */
  public get(id: string): Readable<Maybe<T>> {
    return readable<Maybe<T>>(null, (set) => {
      const entry: Entry<T> = { id, set }
      const key = id

      this.entries.set(key, entry)
      void this.lookup(entry)
      this.start()

      return () => this.entries.delete(key)
    })
  }

  /**
   * Takes an entry the application was given — the state a write answered — without reading it:
   * kept where its `VERSION` is higher than the copy's, taken out where it is `DELETED`. The next
   * read may bring it again, and changes nothing then.
   */
  public async apply(entry: T): Promise<void> {
    const db = await this.db()

    if (db === null) return

    const changes = await db.put(entry)

    if (changes.length === 0) return

    await this.changed({ changes })
    this.broadcast({ changes })
  }

  /**
   * Says the collection is empty, as it is for an account just made: queries answer `[]`, and
   * nothing is read until `sync`. It saves the first read, so once a read has started — something
   * subscribed first — it does nothing, and the copy is what that read makes of it.
   */
  public async empty(): Promise<void> {
    if (this.started) return

    this.started = true

    const db = await this.db()

    if (db === null) return

    await db.clear({ ...db.meta, token: undefined, complete: true })
    await this.changed({ all: true })
    this.broadcast({ all: true })
  }

  /**
   * Reads what is left to read: the rest of the collection, then what changed in it. One tab
   * reads at a time; the others learn what it read.
   */
  public async sync(): Promise<Error | null> {
    if (!available()) return null

    // a read in flight began before this call, and may miss what the caller knows has changed:
    // one more starts after it, and every call made meanwhile waits for that one
    if (this.syncing !== null) {
      this.queued ??= this.syncing.then(() => {
        this.queued = null

        return this.sync()
      })

      return await this.queued
    }

    this.syncing = this.locked().finally(() => {
      this.syncing = null
    })

    return await this.syncing
  }

  private start(): void {
    if (this.started) return

    this.started = true

    void this.sync()
  }

  private async locked(): Promise<Error | null> {
    if (typeof navigator === 'undefined' || navigator.locks === undefined) return await this.read()

    return await navigator.locks.request(`svas:${this.options.name}`, async () => await this.read())
  }

  private async read(): Promise<Error | null> {
    try {
      const db = await this.db()

      if (db === null) return null

      let meta = { ...(await db.reload()) }
      let whole = meta.token === undefined || meta.token === null

      if (whole) meta = { ...meta, token: undefined, generation: meta.generation + 1 }

      while (true) {
        const source = await this.options.stream(meta.token ?? undefined)

        if (source === expired) {
          if (whole) return new Error('Reflection: the collection refused a read without a token')

          meta = { ...meta, token: undefined, complete: false, generation: meta.generation + 1 }
          await db.clear(meta)
          await this.changed({ all: true })
          this.broadcast({ all: true })
          whole = true

          continue
        }

        const { parts, token, ended } = await collect(source)

        // a read that ends without a token was cut: nothing of it is kept, and it is read again
        if (!ended) return new Error('Reflection: the stream was cut')

        const complete = meta.complete || parts.length === 0 || token === null
        const all = complete && !meta.complete

        meta = { ...meta, token, complete }

        const changes = await db.apply(parts, meta)

        if (token === null && whole) changes.push(...(await db.sweep<T>(meta.generation)))

        // a copy that has just become whole answers every query, whichever changes it took
        await this.changed({ changes, all })
        this.broadcast({ changes, all })

        if (token === null || parts.length === 0) return null
      }
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  private async db(): Promise<Database | null> {
    if (!available()) return null

    this.database ??= open(this.options.name, this.indexes)

    return await this.database
  }

  private async run(query: Query<T>): Promise<void> {
    const db = await this.db()

    if (db === null || !db.meta.complete) return

    const order = query.options?.order === 'desc' ? 'prev' : 'next'
    const values = await db.range<T>(query.index, query.range, order, query.options?.limit)

    query.set(values)
  }

  private async lookup(entry: Entry<T>): Promise<void> {
    const db = await this.db()
    const held = await db?.entry<T>(entry.id)

    if (held !== undefined) return entry.set(held)

    if (this.options.get === undefined) {
      if (db?.meta.complete === true) entry.set(null)

      return
    }

    let fallback = this.fallbacks.get(entry.id)

    if (fallback === undefined) {
      fallback = this.options.get(entry.id)
      this.fallbacks.set(entry.id, fallback)
    }

    const value = await fallback

    // the copy may have taken the entry in the meantime, and the copy wins
    if ((await db?.entry<T>(entry.id)) === undefined) entry.set(value)
  }

  /** Re-reads the queries and entries a change touches, whichever tab read it. */
  private async changed(message: Message<T>): Promise<void> {
    await (await this.db())?.reload()

    if (message.all === true) return await this.refresh()
    if (message.changes === undefined) return

    for (const query of this.queries)
      if (message.changes.some((change) => touches(query, change))) await this.run(query)

    for (const change of message.changes) {
      const entry = this.entries.get(change.id)

      if (entry === undefined) continue

      if (change.after !== undefined) entry.set(change.after)
      else void this.lookup(entry)
    }
  }

  private async refresh(): Promise<void> {
    for (const query of this.queries) await this.run(query)
    for (const entry of this.entries.values()) await this.lookup(entry)
  }

  private broadcast(message: Message<T>): void {
    this.channel?.postMessage(message)
  }

  /** What the bound store says is gone takes its copy with it. */
  private async clear(): Promise<void> {
    const db = this.database

    this.database = null
    this.started = false
    this.fallbacks.clear()

    if (db !== null) (await db).close()
    if (available()) await remove(this.options.name)

    for (const query of this.queries) query.set(null)
    for (const entry of this.entries.values()) entry.set(null)
  }
}

export function reflection<T extends Comparable>(options: Options<T>): Reflection<T> {
  return new Reflection(options)
}

/** What a stream yields, as a toa stream route answers it. */
export type StreamPart<T> = Part<T> | { token: string | null }

export interface Options<T> {
  /** The IndexedDB database the copy is kept in, as `svas:<name>`. */
  name: string

  /** Reads the collection from a token, or from the start without one. */
  stream: (token: string | undefined) => Promise<AsyncIterable<StreamPart<T>> | typeof expired>

  /** Answers an entry the copy does not hold. */
  get?: (id: string) => Promise<Maybe<T>>

  /** Indexes by name: a property of the entry, or a list of them. */
  indexes?: Indexes

  /** Deletes the copy when the bound store is `null`. */
  bind?: Readable<unknown | null>
}

/** A key, or bounds of one. */
export type Criteria = IDBValidKey | { gt?: IDBValidKey; gte?: IDBValidKey; lt?: IDBValidKey; lte?: IDBValidKey }

export interface QueryOptions {
  order?: 'asc' | 'desc'
  limit?: number
}

interface Query<T> {
  index: string
  range: IDBKeyRange | null
  options?: QueryOptions
  path: string | string[]
  set: Subscriber<Maybe<T[]>>
}

interface Entry<T> {
  id: string
  set: Subscriber<Maybe<T>>
}

interface Message<T> {
  changes?: Array<Change<T>>
  /** every query and entry is read again: the copy became whole, or was dropped */
  all?: boolean
}

async function collect<T>(source: AsyncIterable<StreamPart<T>>): Promise<{ parts: Array<Part<T>>; token: string | null; ended: boolean }> {
  const parts: Array<Part<T>> = []
  let token: string | null = null
  let ended = false

  try {
    for await (const part of source) {
      if ('token' in part) {
        token = part.token
        ended = true
      } else parts.push(part)
    }
  } catch {
    return { parts, token, ended: false }
  }

  return { parts, token, ended }
}

function touches<T>(query: Query<T>, change: Change<T>): boolean {
  return [change.before, change.after].some((value) => {
    if (value === undefined) return false
    if (query.range === null) return true

    const key = keyOf(value, query.path)

    return key !== undefined && query.range.includes(key)
  })
}

function keyOf(value: unknown, path: string | string[]): IDBValidKey | undefined {
  if (Array.isArray(path)) {
    const keys = path.map((p) => keyOf(value, p))

    return keys.includes(undefined) ? undefined : (keys as IDBValidKey[])
  }

  let current: unknown = value

  for (const key of path.split('.')) current = (current as Record<string, unknown> | undefined)?.[key]

  return current as IDBValidKey | undefined
}

function keyRange(criteria?: Criteria): IDBKeyRange | null {
  if (criteria === undefined) return null
  if (!isBounds(criteria)) return IDBKeyRange.only(criteria)

  const lower = criteria.gte ?? criteria.gt
  const upper = criteria.lte ?? criteria.lt
  const lowerOpen = criteria.gte === undefined && criteria.gt !== undefined
  const upperOpen = criteria.lte === undefined && criteria.lt !== undefined

  if (lower !== undefined && upper !== undefined) return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen)
  if (lower !== undefined) return IDBKeyRange.lowerBound(lower, lowerOpen)
  if (upper !== undefined) return IDBKeyRange.upperBound(upper, upperOpen)

  return null
}

function isBounds(criteria: Criteria): criteria is { gt?: IDBValidKey; gte?: IDBValidKey; lt?: IDBValidKey; lte?: IDBValidKey } {
  if (typeof criteria !== 'object' || criteria === null || Array.isArray(criteria) || criteria instanceof Date) return false

  return ['gt', 'gte', 'lt', 'lte'].some((key) => key in criteria)
}

/** Nothing is kept where there is no IndexedDB, as while rendering on a server. */
function available(): boolean {
  return typeof indexedDB !== 'undefined'
}

export type { Meta }
