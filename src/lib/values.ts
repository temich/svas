import { get, type Readable, writable, type Writable } from 'svelte/store'
import type { Maybe } from './Maybe'

class Values<T, E extends Error = Error> {
  public readonly persistent: boolean

  private readonly values: Record<string, Value<T, E>> = {}
  private readonly fetch: Options<T, E>['get']
  private readonly revalidate: number
  private readonly permanent: boolean
  private readonly stale: boolean
  private readonly persist?: string

  private ready = false
  private dumping: ReturnType<typeof setTimeout> | null = null

  public constructor(options: Options<T, E>) {
    this.fetch = options.get
    this.revalidate = options.revalidate ?? DEFAULTS.revalidate
    this.permanent = options.permanent ?? DEFAULTS.permanent
    this.stale = options.stale ?? DEFAULTS.stale
    this.persist = options.persist

    this.persistent = this.persist !== undefined
    this.load()

    if (options.bind !== undefined)
      this.bind(options.bind)
  }

  public set(key: string, item: T | E, options?: SetOptions): Readable<T | E> {
    const value = item
    const entry = this.values[key] ?? (this.values[key] = this.create(value))

    if (options?.stash === true) this.stash(key)
    else delete entry.stash

    entry.store.set(value)

    if (!(value instanceof Error) && this.ready && options?.stash !== true) this.dump()

    return this.values[key].store as Readable<T | E>
  }

  /**
   * Restores persistent value.
   */
  public reset(key: string): Maybe<T | E> {
    const stash = this.values[key]?.stash

    if (stash === undefined) return this.extract(key)

    if (stash === null) this.delete(key)
    else this.set(key, stash)

    return stash
  }

  public get(key: string, options?: GetOptions): Readable<Maybe<T, E>> {
    this.ready = true

    const value = (this.values[key] ??= this.create())

    // a server renders what the store holds, as `Value` does
    if (this.fetch === undefined || options?.fetch === false || typeof window === 'undefined')
      return value.store

    const stale = value.timestamp === 0 || value.timestamp + this.revalidate < Date.now()

    if (stale) {
      if (!this.stale) value.store.set(null)

      value.timestamp = Date.now()
      this.fetch(key).then((data) => this.set(key, data))
    }

    return value.store
  }

  public extract(key: string): T | null {
    if (this.values[key] === undefined) return null

    const value = get(this.values[key].store)

    return value instanceof Error ? null : value
  }

  public delete(key: string): void {
    if (!(key in this.values)) return

    const value = this.values[key]

    value.store.set(null)
    value.timestamp = 0
    delete value.stash

    this.dump()
  }

  public clear(): void {
    for (const key of Object.keys(this.values)) this.delete(key)

    this.ready = false
  }

  private create(value?: T | E): Value<T, E> {
    return {
      store: writable<Maybe<T, E>>(value ?? null),
      timestamp: this.permanent && value !== undefined ? Date.now() : 0
    }
  }

  private stash(key: string): void {
    const entry = this.values[key]

    if (entry.stash !== undefined) {
      console.warn('Stash overlap, skipping')

      return
    }

    const store = this.get(key, { fetch: false })

    entry.stash ??= get(store)
  }

  private dump(delay = true) {
    if (this.persist === undefined || typeof window === 'undefined')
      return

    if (delay) {
      this.dumping ??= setTimeout(() => this.dump(false), DUMP_GAP)

      return
    } else this.dumping = null

    const data: Record<string, T> = {}

    for (const [key, value] of Object.entries(this.values)) {
      const state = value.stash ?? get(value.store)

      if (state !== null && !(state instanceof Error)) data[key] = state
    }

    if (Object.keys(data).length === 0) localStorage.removeItem(this.persist)
    else localStorage.setItem(this.persist, JSON.stringify(data))
  }

  private load() {
    if (this.persist === undefined || typeof window === 'undefined')
      return

    const data = localStorage.getItem(this.persist)

    if (data === null) return

    try {
      const values = JSON.parse(data) as Record<string, T>

      if (values === null || typeof values !== 'object') {
        console.error(`Storage value for ${this.persist} is not an object:`, values)

        return
      }

      for (const [key, value] of Object.entries(values)) this.set(key, value)
    } catch (error) {
      console.error(`Invalid storage value for ${this.persist}`, error)
    }
  }

  private bind(store: Readable<unknown | null>) {
    store.subscribe((value) => {
      if (value === null) this.clear()
    })
  }
}

interface Options<T = unknown, E extends Error = Error> {
  /**
   * Fetches the value
   */
  get?: (key: string) => Promise<T | E>

  /**
   * Time in milliseconds before revalidating the value.
   * Default is 60 seconds.
   */
  revalidate?: number

  /**
   * Whether to keep the values while revalidating.
   * Default is false.
   */
  stale?: boolean

  /**
   * Key to persist values.
   */
  persist?: string

  /**
   * Do not refresh persistent values on application restart.
   * Default is false.
   *
   * { permanent: true, revalidate: Infinity } prevents revalidation entirely.
   */
  permanent?: boolean

  /**
   * Nullify values when the bound store is null.
   */
  bind?: Readable<unknown | null>
}

export interface GetOptions {
  /**
   * Whether to fetch the value if it's not in the store. Defaults to true.
   */
  fetch?: boolean
}

export interface SetOptions {
  /**
   * Whether value is transient. Defaults to false.
   */
  stash?: boolean
}

interface Value<T, E extends Error = Error> {
  store: Writable<Maybe<T, E>>
  timestamp: number

  /**
   * Contains last persisted value if current value is transient.
   */
  stash?: Maybe<T, E>
}

const DUMP_GAP = 100 // should not be 0 to prevent unnecessary disk writes

const DEFAULTS = {
  revalidate: 300_000,
  permanent: false,
  stale: false
} as const satisfies Omit<Options, 'get'>

function values<T, E extends Error = Error>(options: Options<T, E> = {}): Values<T, E> {
  return new Values<T, E>(options)
}

export { values, type Values }
