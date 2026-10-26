import { readable, type Readable, type Subscriber } from 'svelte/store'
import { open, remove, type Change, type Database, type Indexes, type Meta, type Part, type Push } from './reflection/idb'
import type { Maybe } from './Maybe'
import type { Comparable } from './sync'

/** What `stream` answers where the server no longer continues from the token it was given. */
export const expired: unique symbol = Symbol('expired')

/** Fields that are the server's, which a copy moved into another does not carry over as written */
const SYSTEM = new Set(['id', 'VERSION', 'CREATED', 'UPDATED', 'DELETED', 'REGION'])

/**
 * A copy of a collection a server streams, kept in IndexedDB and kept current. It reads the
 * collection once, and from then on what changed in it, from the token the last read ended with.
 * Queries answer from the copy.
 *
 * Given `push`, it is written on the device too: `write` changes the copy at once, offline or not,
 * and what was written goes to the server with the `VERSION` it was written over, while `sync` is
 * on. What the server answers is the state; until then, what was written stays over it.
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

  /** the next read starts by dropping the copy */
  private dropping = false

  /** the read in flight, and the one that starts after it */
  private syncing: Promise<Error | null> | null = null
  private queued: Promise<Error | null> | null = null

  /** the generation of the read in flight: what is applied meanwhile is found by it */
  private reading: number | null = null

  /** whether the copy is exchanged with the server: always, unless `sync` says otherwise */
  private enabled = true

  /** the push that waits for writing to pause */
  private pushing: ReturnType<typeof setTimeout> | null = null

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

    // turned on, what was written goes, and what changed comes; turned off, nothing is exchanged
    options.sync?.subscribe((on) => {
      this.enabled = on

      if (on && this.started) void this.sync()
    })
  }

  /**
   * Writes fields of an entry on the device, or deletes it with `null`: the copy answers them at
   * once, and they go to the server while `sync` is on. An entry the copy does not hold is made.
   */
  public async write(id: string, set: Partial<T> | null): Promise<void> {
    if (this.options.push === undefined) throw new Error('Reflection: a copy without `push` is not written')

    const db = await this.db()

    if (db === null) return

    const changes = await db.write<T>(id, set)

    await this.changed({ changes })
    this.broadcast({ changes })
    this.schedule()
  }

  /**
   * Writes the entries of another copy into this one, as written on the device, and deletes that
   * copy: what was kept without an account goes into the account's.
   */
  public async absorb(source: Reflection<T>): Promise<void> {
    const from = await source.db()

    if (from === null) return

    for (const entry of await from.all<T>()) {
      const fields = Object.fromEntries(Object.entries(entry).filter(([key]) => !SYSTEM.has(key)))

      await this.write(entry.id, fields as Partial<T>)
    }

    await source.clear()
  }

  /**
   * The entries an index range selects, in the order of the index: a key, or bounds of one.
   * `null` until the copy holds the whole collection, and the error of the read that was to make
   * it whole, where it failed.
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
   * Takes a change the application was told of — an event that carries it, or the state a write
   * answered — without reading the collection: an entry, or a part as a stream yields them,
   * `{ entry }` or `{ removed }`. An entry is kept where its `VERSION` is higher than the copy's,
   * and taken out where it is `DELETED`. One that was removed is not brought back by an older
   * state of it, whichever comes first: told the `VERSION` it left at, a later one is the entry
   * again, and otherwise the next read says.
   */
  public async apply(change: T | Part<T>): Promise<void> {
    const db = await this.db()

    if (db === null) return

    let changes: Array<Change<T>>

    // an entry has an id, and a part has none: an entry may well have a property named as a part's
    if ('id' in change) changes = await db.put(change, this.reading ?? db.meta.generation)
    else if ('entry' in change) changes = await db.put(change.entry, this.reading ?? db.meta.generation)
    else changes = await db.drop<T>(change.removed, change.VERSION)

    if (changes.length === 0) return

    await this.changed({ changes })
    this.broadcast({ changes })
  }

  /**
   * Takes an entry out of the copy without reading it: one the application knows has left the
   * collection. The same as applying `{ removed: id }`.
   */
  public async remove(id: string): Promise<void> {
    await this.apply({ removed: id })
  }

  /**
   * Drops the copy and reads the collection again from the start: what the application knows the
   * token no longer continues, before a server has to say so.
   */
  public async reset(): Promise<Error | null> {
    this.dropping = true

    return await this.sync()
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
    if (!available() || !this.enabled) return null

    // a read in flight began before this call, and may miss what the caller knows has changed:
    // one more starts after it, and every call made meanwhile waits for that one
    if (this.syncing !== null) {
      this.queued ??= this.syncing.then(() => {
        this.queued = null

        return this.sync()
      })

      return await this.queued
    }

    this.syncing = this.locked()
      .then(async (result) => {
        if (result instanceof Error) await this.failed(result)

        return result
      })
      .finally(() => {
        this.syncing = null
      })

    return await this.syncing
  }

  private start(): void {
    if (this.started) return

    this.started = true

    void this.sync()
  }

  /** What was written goes once writing pauses, as a key is held or a list is typed */
  private schedule(): void {
    if (!this.enabled) return

    if (this.pushing !== null) clearTimeout(this.pushing)

    this.pushing = setTimeout(() => {
      this.pushing = null
      void this.sync()
    }, this.options.delay ?? 1000)
  }

  /**
   * What was written goes first, then what changed comes: one tab at a time. A push refused does not
   * keep what changed from coming, and is tried again on the next `sync`
   */
  private async locked(): Promise<Error | null> {
    const work = async () => {
      const pushed = await this.push()
      const read = await this.read()

      return pushed ?? read
    }

    if (typeof navigator === 'undefined' || navigator.locks === undefined) return await work()

    return await navigator.locks.request(`svas:${this.options.name}`, work)
  }

  /** Sends what was written, a batch at a time, and takes what the server answers as the state */
  private async push(): Promise<Error | null> {
    const push = this.options.push

    if (push === undefined) return null

    const db = await this.db()

    if (db === null) return null

    while (true) {
      const sent = await db.pending<T>(this.options.batch ?? 100)

      if (sent.length === 0) return null

      const changes: Array<Push<T>> = sent.map((record) => ({
        id: record.id,
        base: record.base ?? 0,
        set: record.removed === true ? null : (record.pending ?? {})
      }))

      let answered: T[] | Error

      try {
        answered = await push(changes)
      } catch (error) {
        answered = error instanceof Error ? error : new Error(String(error))
      }

      if (answered instanceof Error) return answered

      const confirmed = await db.confirm<T>(sent, answered)

      await this.changed({ changes: confirmed })
      this.broadcast({ changes: confirmed })
    }
  }

  private async read(): Promise<Error | null> {
    try {
      const db = await this.db()

      if (db === null) return null

      // what was said to have left after this moment, the read may not know of
      const started = Date.now()

      let meta = { ...(await db.reload()) }

      const scope = await this.scope()
      const held = meta.complete || (meta.token !== undefined && meta.token !== null)

      // a copy read under another scope, or one the application gave up, is no copy of this
      // collection: it goes, and the collection is read from the start
      if (this.dropping || (held && meta.scope !== scope)) {
        this.dropping = false
        meta = { ...meta, token: undefined, complete: false, generation: meta.generation + 1 }
        await db.clear(meta)
        await this.changed({ all: true })
        this.broadcast({ all: true })
      }

      meta = { ...meta, scope }

      let whole = meta.token === undefined || meta.token === null

      if (whole) meta = { ...meta, token: undefined, generation: meta.generation + 1 }

      while (true) {
        this.reading = meta.generation

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

        const { parts, token, ended, final } = await collect(source)

        // a read that ends without a token was cut: nothing of it is kept, and it is read again
        if (!ended) return new Error('Reflection: the stream was cut')

        const complete = meta.complete || parts.length === 0 || token === null || final
        const all = complete && !meta.complete

        meta = { ...meta, token, complete }

        const changes = await db.apply(parts, meta, started)

        if (token === null && whole) changes.push(...(await db.sweep<T>(meta.generation)))

        // a copy that has just become whole answers every query, whichever changes it took
        await this.changed({ changes, all })
        this.broadcast({ changes, all })

        // nothing is left to read: the server keeps no history, the read brought nothing, or
        // whoever read it says it was the last
        if (token === null || parts.length === 0 || final) return null
      }
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    } finally {
      this.reading = null
    }
  }

  /** What the collection is read under, as the application has it now: `undefined` where it names none. */
  private async scope(): Promise<string | undefined> {
    const scope = await this.options.scope?.()

    return scope === undefined ? undefined : String(scope)
  }

  /**
   * A read failed. Where the copy is not whole yet, nothing answers the queries, so the error
   * does — as a fetch error is the value of any other store — until a later read succeeds. A whole
   * copy goes on answering: what it missed is read on the next `sync`.
   */
  private async failed(error: Error): Promise<void> {
    const db = await this.db()

    // a copy written on the device answers what it holds, as it always does
    if (db === null || db.meta.complete || this.options.push !== undefined) return

    for (const query of this.queries) query.set(error)
  }

  private async db(): Promise<Database | null> {
    if (!available()) return null

    this.database ??= open(this.options.name, this.indexes)

    return await this.database
  }

  private async run(query: Query<T>): Promise<void> {
    const db = await this.db()

    // a copy written on the device answers what it holds from the start: it is the device's first
    if (db === null || (!db.meta.complete && this.options.push === undefined)) return

    const order = query.options?.order === 'desc' ? 'prev' : 'next'
    const values = await db.range<T>(query.index, query.range, order, query.options?.limit)

    query.set(values)
  }

  private async lookup(entry: Entry<T>): Promise<void> {
    const db = await this.db()
    const held = await db?.entry<T>(entry.id)

    if (held !== undefined) return entry.set(held)

    if (this.options.get === undefined) {
      if (db?.meta.complete === true || this.options.push !== undefined) entry.set(null)

      return
    }

    // a server renders what the copy holds, as a `value` does
    if (typeof window === 'undefined') return

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

/**
 * What a stream yields: an entry, the id of one that left the collection, or — last — the token.
 * With `final`, whoever read the stream says nothing is left behind the token: a window shorter
 * than was asked for, or a read that was told to go no deeper. The copy is whole then, and no
 * read follows to find that out.
 */
export type StreamPart<T> = Part<T> | { token: string | null; final?: boolean }

export interface Options<T> {
  /** The IndexedDB database the copy is kept in, as `svas:<name>`. */
  name: string

  /**
   * Reads the collection from a token, or from the start without one. A read that cannot be made
   * throws: nothing of it is kept, `sync` answers the error, and the next `sync` reads again.
   */
  stream: (token: string | undefined) => Promise<AsyncIterable<StreamPart<T>> | typeof expired>

  /**
   * What the collection is read under — the criteria of the request, whatever `stream` adds to it
   * beside the token. A token is of the scope it was issued under: where the scope is another
   * than the copy was read under, the copy is dropped and the collection read again, without the
   * server having to refuse the token first.
   */
  scope?: () => string | number | undefined | Promise<string | number | undefined>

  /** Answers an entry the copy does not hold. */
  get?: (id: string) => Promise<Maybe<T>>

  /** Indexes by name: a property of the entry, or a list of them. */
  indexes?: Indexes

  /** Deletes the copy when the bound store is `null`. */
  bind?: Readable<unknown | null>

  /**
   * Sends what was written on the device: each change with the `VERSION` it was written over, and
   * the fields, or `null` for a deletion. Answers the entries as the server has them after it — a
   * change it answers nothing for was refused — or an error, and what was written is sent again on
   * the next `sync`. Given, the copy is written with `write`, and answers what it holds at once.
   */
  push?: (changes: Array<Push<T>>) => Promise<T[] | Error>

  /** Whether the copy is exchanged with the server: off, nothing is read or sent. On where not given. */
  sync?: Readable<boolean>

  /** How many changes a push sends at most. */
  batch?: number

  /** How long writing pauses before what was written is sent, in milliseconds. */
  delay?: number
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

async function collect<T>(source: AsyncIterable<StreamPart<T>>): Promise<{ parts: Array<Part<T>>; token: string | null; ended: boolean; final: boolean }> {
  const parts: Array<Part<T>> = []
  let token: string | null = null
  let ended = false
  let final = false

  try {
    for await (const part of source) {
      if ('token' in part) {
        token = part.token
        final = part.final === true
        ended = true
      } else parts.push(part)
    }
  } catch {
    return { parts, token, ended: false, final: false }
  }

  return { parts, token, ended, final }
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

export type { Meta, Part, Push }
