/** What IndexedDB keeps of a reflection: its entries, and where its reading stands. */

export interface Stored<T> {
  id: string
  value: T
  /** the read that last found it, which a read of the whole collection sweeps by */
  g: number
}

export interface Meta {
  /** what the next read starts from: `undefined` reads the whole collection */
  token?: string | null
  /** whether the copy holds the whole collection, and queries may answer from it */
  complete: boolean
  generation: number
  /** the indexes the database was made with */
  declaration: string
}

export type Indexes = Record<string, string | string[]>

const ENTRIES = 'entries'
const META = 'meta'
const KEY = 'meta'

/**
 * The database of a reflection, made with its indexes. A database made with other indexes is
 * deleted and made again: a copy can always be read again, and an index cannot be added to one
 * without a version of its own.
 */
export async function open(name: string, indexes: Indexes, empty: boolean): Promise<Database> {
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
    meta = { complete: empty, generation: 0, declaration }
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

        values.push((cursor.value as Stored<T>).value)
        cursor.continue()
      }
    })

    return values
  }

  /**
   * Applies what one read yielded, and the token it ended with, as one transaction: a read is
   * kept whole or not at all. Answers what changed.
   */
  public async apply<T extends Versioned>(parts: Array<Part<T>>, meta: Meta): Promise<Array<Change<T>>> {
    const tx = this.db.transaction([ENTRIES, META], 'readwrite')
    const entries = tx.objectStore(ENTRIES)
    const changes: Array<Change<T>> = []

    for (const part of parts) {
      const id = 'entry' in part ? part.entry.id : part.removed
      const held = (await done(entries.get(id))) as Stored<T> | undefined

      if ('removed' in part) {
        if (held === undefined) continue

        entries.delete(id)
        changes.push({ id, before: held.value })
      } else if (held === undefined || held.value.VERSION < part.entry.VERSION) {
        entries.put({ id, value: part.entry, g: meta.generation })
        changes.push({ id, before: held?.value, after: part.entry })
      } else entries.put({ ...held, g: meta.generation })
    }

    tx.objectStore(META).put(meta, KEY)

    await committed(tx)

    this.meta = meta

    return changes
  }

  /** Deletes what a read of the whole collection did not find. */
  public async sweep<T>(generation: number): Promise<Array<Change<T>>> {
    const tx = this.db.transaction(ENTRIES, 'readwrite')
    const index = tx.objectStore(ENTRIES).index('g')
    const changes: Array<Change<T>> = []

    await new Promise<void>((resolve, reject) => {
      const request = index.openCursor(IDBKeyRange.upperBound(generation, true))

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const cursor = request.result

        if (cursor === null) return resolve()

        const stored = cursor.value as Stored<T>

        changes.push({ id: stored.id, before: stored.value })
        cursor.delete()
        cursor.continue()
      }
    })

    await committed(tx)

    return changes
  }

  public async clear(meta: Meta): Promise<void> {
    const tx = this.db.transaction([ENTRIES, META], 'readwrite')

    tx.objectStore(ENTRIES).clear()
    tx.objectStore(META).put(meta, KEY)

    await committed(tx)

    this.meta = meta
  }

  public close(): void {
    this.db.close()
  }
}

export interface Versioned {
  id: string
  VERSION: number
}

export type Part<T> = { entry: T } | { removed: string }

export interface Change<T> {
  id: string
  before?: T
  after?: T
}

function database(name: string): string {
  return `svas:${name}`
}

async function connect(name: string, indexes: Indexes): Promise<IDBDatabase> {
  const request = indexedDB.open(database(name), 1)

  request.onupgradeneeded = () => {
    const db = request.result
    const entries = db.createObjectStore(ENTRIES, { keyPath: 'id' })

    entries.createIndex('g', 'g')

    for (const [name, path] of Object.entries(indexes))
      entries.createIndex(name, Array.isArray(path) ? path.map(valued) : valued(path))

    db.createObjectStore(META)
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
