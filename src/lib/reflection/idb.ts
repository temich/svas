import type { Comparable } from '../sync'

/** What IndexedDB keeps of a reflection: its entries, and where its reading stands. */

export interface Stored<T> {
  id: string
  /**
   * The entry as it is answered: the server's state, with what the device wrote and the server has
   * not confirmed yet over it. Absent while a deletion the device made waits to be confirmed
   */
  value?: T
  /** the read that last found it, which a read of the whole collection sweeps by */
  g: number
  /** what the device wrote and the server has not confirmed: `1` while there is any, as an index wants a key */
  p?: 1
  /** the server's state under what is pending; absent for an entry the server has never had */
  server?: T
  /** the fields written and not confirmed */
  pending?: Partial<T>
  /** the device deleted the entry, and the server has not confirmed it */
  removed?: true
  /** the `VERSION` the device had when it began writing: what the server compares the change with */
  base?: number
  /** counts the writes, so that one made while a push was on its way is not taken as confirmed */
  stamp?: number
}

/** A change the device made, as it is pushed: the fields written, or `null` for a deletion */
export interface Push<T> {
  id: string
  base: number
  set: Partial<T> | null
}

export interface Meta {
  /** what the next read starts from: `undefined` reads the whole collection */
  token?: string | null
  /** whether the copy holds the whole collection, and queries may answer from it */
  complete: boolean
  generation: number
  /** the indexes the database was made with */
  declaration: string
  /** what the copy was read under: a token is of it, and of no other */
  scope?: string
}

export type Indexes = Record<string, string | string[]>

/** An entry that left the collection, remembered so that an older state of it does not bring it back */
export interface Gone {
  id: string
  /** the version it left at, where whoever said so knew it: a later one is the entry again */
  version?: number
  /** when it was said: a read that began before may still hold the entry */
  at: number
}

const ENTRIES = 'entries'
const GONE = 'gone'
const META = 'meta'
const KEY = 'meta'
const VERSION = 3

/**
 * The database of a reflection, made with its indexes. A database made with other indexes is
 * deleted and made again: a copy can always be read again, and an index cannot be added to one
 * without a version of its own.
 */
export async function open(name: string, indexes: Indexes): Promise<Database> {
  const declaration = JSON.stringify(indexes)
  let db = await connect(name, indexes)
  let meta = await read<Meta>(db, META, KEY)

  if (meta !== undefined && meta.declaration !== declaration) {
    db.close()
    await remove(name)
    db = await connect(name, indexes)
    meta = undefined
  }

  if (meta === undefined) {
    meta = { complete: false, generation: 0, declaration }
    await write(db, META, meta, KEY)
  }

  return new Database(db, meta)
}

export async function remove(name: string): Promise<void> {
  await done(indexedDB.deleteDatabase(database(name)))
}

export class Database {
  public meta: Meta
  private readonly db: IDBDatabase

  public constructor(db: IDBDatabase, meta: Meta) {
    this.db = db
    this.meta = meta
  }

  /** Reads where the reading stands again, which another tab may have moved. */
  public async reload(): Promise<Meta> {
    this.meta = (await read<Meta>(this.db, META, KEY)) ?? this.meta

    return this.meta
  }

  public async entry<T>(id: string): Promise<T | undefined> {
    return (await read<Stored<T>>(this.db, ENTRIES, id))?.value
  }

  /**
   * Writes fields of an entry, or deletes it, on the device: what is written stays over the
   * server's state until a push confirms it. An entry the server has never had, deleted, is gone.
   */
  public async write<T extends Comparable>(id: string, set: Partial<T> | null): Promise<Array<Change<T>>> {
    const tx = this.db.transaction(ENTRIES, 'readwrite')
    const entries = tx.objectStore(ENTRIES)
    const held = (await done(entries.get(id))) as Stored<T> | undefined
    const server = held === undefined ? undefined : serverOf(held)
    const base = held?.p === 1 ? (held.base ?? 0) : (server?.VERSION ?? 0)
    const stamp = (held?.stamp ?? 0) + 1
    const g = held?.g ?? this.meta.generation
    let after: T | undefined

    if (set === null) {
      if (server === undefined) entries.delete(id)
      else entries.put({ id, g, p: 1, server, pending: {}, removed: true, base, stamp } satisfies Stored<T>)
    } else {
      const pending = { ...(held?.removed === true ? {} : held?.pending), ...set }

      after = view(id, server, pending)
      entries.put({ id, value: after, g, p: 1, server, pending, base, stamp } satisfies Stored<T>)
    }

    await committed(tx)

    return [{ id, before: held?.value, after }]
  }

  /** How many entries hold what the device wrote and the server has not confirmed */
  public async waiting(): Promise<number> {
    const tx = this.db.transaction(ENTRIES, 'readonly')

    return await new Promise<number>((resolve, reject) => {
      const request = tx.objectStore(ENTRIES).index('p').count(IDBKeyRange.only(1))

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
  }

  /** What the device wrote and the server has not confirmed: up to `limit` entries, as they are stored */
  public async pending<T>(limit: number): Promise<Array<Stored<T>>> {
    const tx = this.db.transaction(ENTRIES, 'readonly')
    const records: Array<Stored<T>> = []

    await new Promise<void>((resolve, reject) => {
      const request = tx.objectStore(ENTRIES).index('p').openCursor(IDBKeyRange.only(1))

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const cursor = request.result

        if (cursor === null || records.length >= limit) return resolve()

        records.push(cursor.value as Stored<T>)
        cursor.continue()
      }
    })

    return records
  }

  /**
   * What a push answered: the entries as the server has them after it. A write sent and not
   * written again since is confirmed, whatever the server took of it; one written again keeps
   * what is pending, now over the server's new state. A change the server answered nothing for was
   * refused: it is dropped, and an entry the server has never had goes with it.
   */
  public async confirm<T extends Comparable>(sent: Array<Stored<T>>, answered: T[]): Promise<Array<Change<T>>> {
    const tx = this.db.transaction(ENTRIES, 'readwrite')
    const entries = tx.objectStore(ENTRIES)
    const states = new Map(answered.map((entry) => [entry.id, entry]))
    const changes: Array<Change<T>> = []

    for (const record of sent) {
      const held = (await done(entries.get(record.id))) as Stored<T> | undefined

      if (held === undefined) continue

      const state = states.get(record.id)
      const server = state ?? serverOf(held)
      const deleted = server === undefined || (server.DELETED !== null && server.DELETED !== undefined)

      if (deleted) {
        entries.delete(record.id)
        changes.push({ id: record.id, before: held.value })

        continue
      }

      const confirmed = held.stamp === record.stamp

      if (confirmed || held.pending === undefined) {
        entries.put({ id: record.id, value: server, g: held.g } satisfies Stored<T>)
        changes.push({ id: record.id, before: held.value, after: server })

        continue
      }

      const after = held.removed === true ? undefined : view(record.id, server, held.pending)

      entries.put({ ...held, value: after, server, base: server.VERSION } satisfies Stored<T>)
      changes.push({ id: record.id, before: held.value, after })
    }

    await committed(tx)

    return changes
  }

  /** Every entry as it is answered, for the entries of one copy to be written into another */
  public async all<T>(): Promise<T[]> {
    return await this.range<T>('id', null, 'next')
  }

  public async range<T>(index: string, range: IDBKeyRange | null, order: IDBCursorDirection, limit?: number): Promise<T[]> {
    const tx = this.db.transaction(ENTRIES, 'readonly')
    const source = index === 'id' ? tx.objectStore(ENTRIES) : tx.objectStore(ENTRIES).index(index)
    const values: T[] = []

    await new Promise<void>((resolve, reject) => {
      const request = source.openCursor(range, order)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const cursor = request.result

        if (cursor === null || (limit !== undefined && values.length >= limit)) return resolve()

        // a deletion the device made, not confirmed yet, is answered by nothing
        const value = (cursor.value as Stored<T>).value

        if (value !== undefined) values.push(value)

        cursor.continue()
      }
    })

    return values
  }

  /**
   * Applies what one read yielded, and the token it ended with, as one transaction: a read is
   * kept whole or not at all. Answers what changed.
   */
  public async apply<T extends Comparable>(parts: Array<Part<T>>, meta: Meta, started: number): Promise<Array<Change<T>>> {
    const tx = this.db.transaction([ENTRIES, GONE, META], 'readwrite')
    const entries = tx.objectStore(ENTRIES)
    const gone = tx.objectStore(GONE)
    const changes: Array<Change<T>> = []

    for (const part of parts) {
      const id = 'entry' in part ? part.entry.id : part.removed
      const held = (await done(entries.get(id))) as Stored<T> | undefined

      // a deleted entry a stream brings is one that left, and what the device wrote of it goes too
      if ('removed' in part || (part.entry.DELETED !== null && part.entry.DELETED !== undefined)) {
        gone.delete(id)

        if (held === undefined) continue

        entries.delete(id)
        changes.push({ id, before: held.value })

        continue
      }

      const left = (await done(gone.get(id))) as Gone | undefined

      // the read began before the entry was said to have left, and may not know of it
      if (left !== undefined && left.at >= started && !later(part.entry, left)) continue

      if (left !== undefined) gone.delete(id)

      const server = held === undefined ? undefined : serverOf(held)

      if (server === undefined || server.VERSION < part.entry.VERSION) {
        const record = settled(held, part.entry, meta.generation)

        entries.put(record)
        changes.push({ id, before: held?.value, after: record.value })
      } else entries.put({ ...held!, g: meta.generation })
    }

    // what a read that began later did not bring back is gone for it as well
    await sweep<Gone>(gone.index('at'), IDBKeyRange.upperBound(started, true))

    tx.objectStore(META).put(meta, KEY)

    await committed(tx)

    this.meta = meta

    return changes
  }

  /**
   * An entry the application was given, as a write answers the state it made or an event tells
   * of it: kept where its `VERSION` is higher than the copy's, and taken out where it is
   * `DELETED`. One that left the collection since is not brought back by an older state of it.
   * `generation` is the read the entry is found by, so that one in flight does not sweep it.
   */
  public async put<T extends Comparable>(entry: T, generation: number): Promise<Array<Change<T>>> {
    if (entry.DELETED !== null && entry.DELETED !== undefined) return await this.drop<T>(entry.id, entry.VERSION)

    const tx = this.db.transaction([ENTRIES, GONE], 'readwrite')
    const entries = tx.objectStore(ENTRIES)
    const gone = tx.objectStore(GONE)
    const held = (await done(entries.get(entry.id))) as Stored<T> | undefined
    const left = (await done(gone.get(entry.id))) as Gone | undefined
    const changes: Array<Change<T>> = []

    const server = held === undefined ? undefined : serverOf(held)

    if ((left === undefined || later(entry, left)) && (server === undefined || server.VERSION < entry.VERSION)) {
      if (left !== undefined) gone.delete(entry.id)

      const record = settled(held, entry, Math.max(held?.g ?? 0, generation))

      entries.put(record)
      changes.push({ id: entry.id, before: held?.value, after: record.value })
    }

    await committed(tx)

    return changes
  }

  /**
   * Takes an entry out, as the application says it left the collection, and remembers that it
   * did. Told the `version` it left at, an entry the copy holds at that version or a later one
   * stays: what is said is older than what is held.
   */
  public async drop<T extends Comparable>(id: string, version?: number): Promise<Array<Change<T>>> {
    const tx = this.db.transaction([ENTRIES, GONE], 'readwrite')
    const entries = tx.objectStore(ENTRIES)
    const gone = tx.objectStore(GONE)
    const held = (await done(entries.get(id))) as Stored<T> | undefined
    const server = held === undefined ? undefined : serverOf(held)
    const stale = server !== undefined && version !== undefined && server.VERSION >= version

    if (!stale) {
      const left: Gone = { id, at: Date.now() }

      if (version !== undefined) left.version = version

      gone.put(left)

      if (held !== undefined) entries.delete(id)
    }

    await committed(tx)

    return held === undefined || stale ? [] : [{ id, before: held.value }]
  }

  /** Deletes what a read of the whole collection did not find, but what the device wrote and has not pushed. */
  public async sweep<T>(generation: number): Promise<Array<Change<T>>> {
    const tx = this.db.transaction(ENTRIES, 'readwrite')
    const swept = await sweep<Stored<T>>(tx.objectStore(ENTRIES).index('g'), IDBKeyRange.upperBound(generation, true), (stored) => stored.p !== 1)

    await committed(tx)

    return swept.map((stored) => ({ id: stored.id, before: stored.value }))
  }

  /** Drops the copy, but what the device wrote and has not pushed: that is the device's, not the copy's. */
  public async clear(meta: Meta): Promise<void> {
    const tx = this.db.transaction([ENTRIES, GONE, META], 'readwrite')

    await sweep<Stored<unknown>>(tx.objectStore(ENTRIES), null, (stored) => stored.p !== 1)
    tx.objectStore(GONE).clear()
    tx.objectStore(META).put(meta, KEY)

    await committed(tx)

    this.meta = meta
  }

  public close(): void {
    this.db.close()
  }
}

/** `VERSION` beside `removed` is the version the entry left at, where whoever says so knows it */
export type Part<T> = { entry: T } | { removed: string; VERSION?: number }

export interface Change<T> {
  id: string
  before?: T
  after?: T
}

/** Whether the entry is of a later version than the one it left at: where that is not known, it is not */
function later(entry: Comparable, left: Gone): boolean {
  return left.version !== undefined && entry.VERSION > left.version
}

async function sweep<T>(source: IDBIndex | IDBObjectStore, range: IDBKeyRange | null, which: (value: T) => boolean = () => true): Promise<T[]> {
  const swept: T[] = []

  await new Promise<void>((resolve, reject) => {
    const request = source.openCursor(range)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result

      if (cursor === null) return resolve()

      if (which(cursor.value as T)) {
        swept.push(cursor.value as T)
        cursor.delete()
      }

      cursor.continue()
    }
  })

  return swept
}

/** The server's state of a stored entry: under what is pending, or the entry itself where nothing is */
function serverOf<T>(stored: Stored<T>): T | undefined {
  return stored.p === 1 ? stored.server : stored.value
}

/** The entry as it is answered: the server's state, or a blank where there is none, with what is pending over it */
function view<T>(id: string, server: T | undefined, pending: Partial<T>): T {
  return { ...(server ?? ({ VERSION: 0 } as T)), ...pending, id } as T
}

/** A new state of the server's taken by a stored entry: what is pending stays over it */
function settled<T>(held: Stored<T> | undefined, server: T, g: number): Stored<T> {
  if (held?.p !== 1) return { id: (server as { id: string }).id, value: server, g }

  const value = held.removed === true ? undefined : view(held.id, server, held.pending ?? {})

  return { ...held, value, server, g }
}

function database(name: string): string {
  return `svas:${name}`
}

async function connect(name: string, indexes: Indexes): Promise<IDBDatabase> {
  const request = indexedDB.open(database(name), VERSION)

  request.onupgradeneeded = () => {
    const db = request.result

    if (!db.objectStoreNames.contains(ENTRIES)) {
      const entries = db.createObjectStore(ENTRIES, { keyPath: 'id' })

      entries.createIndex('g', 'g')

      for (const [name, path] of Object.entries(indexes))
        entries.createIndex(name, Array.isArray(path) ? path.map(valued) : valued(path))

      db.createObjectStore(META)
    }

    // a database of the versions before has all but what is remembered of the entries that left,
    // and the index of what the device wrote and has not pushed
    if (!db.objectStoreNames.contains(GONE)) db.createObjectStore(GONE, { keyPath: 'id' }).createIndex('at', 'at')

    const entries = request.transaction!.objectStore(ENTRIES)

    if (!entries.indexNames.contains('p')) entries.createIndex('p', 'p')
  }

  return await done(request)
}

/** An index is over the entry, which a record holds under `value`. */
function valued(path: string): string {
  return `value.${path}`
}

async function read<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return (await done(db.transaction(store, 'readonly').objectStore(store).get(key))) as T | undefined
}

async function write(db: IDBDatabase, store: string, value: unknown, key: string): Promise<void> {
  const tx = db.transaction(store, 'readwrite')

  tx.objectStore(store).put(value, key)

  await committed(tx)
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('The transaction was aborted'))
  })
}
