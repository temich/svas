import {
  writable,
  type Readable,
  type Writable,
  type Subscriber,
  type Unsubscriber
} from 'svelte/store'
import type { Maybe } from './Maybe'
import type { GetOptions, Values } from './values'

export class Collection<T extends Identifiable, E extends Error = Error> implements Readable<Maybe<T[], E>> {
  private readonly store: Writable<Maybe<T[], E>>
  private readonly values?: Values<T, E>
  private readonly request: Options<T, E>['get']
  private readonly revalidate: number
  private readonly stale: boolean
  private timestamp: number = 0

  public constructor(options: Options<T, E>) {
    this.store = writable(null)
    this.values = options.values
    this.request = options.get
    this.revalidate = options.revalidate ?? DEFAULTS.revalidate
    this.stale = options.stale ?? DEFAULTS.stale

    if (options.persist !== undefined)
      this.persist(options.persist)

    if (options.bind !== undefined)
      this.bind(options.bind)
  }

  public subscribe(run: Subscriber<Maybe<T[], E>>, invalidate?: () => void): Unsubscriber {
    // a server renders what the store holds: it cannot wait for a request, and a store is shared by
    // every request the server renders
    if (typeof window !== 'undefined')
      this.sync()

    return this.store.subscribe(run, invalidate)
  }

  public add(item: T): void {
    this.values?.set(item.id, item)

    this.store.update((items) => {
      if (items === null || items instanceof Error) return [item]
      else if (items.find((i) => i.id === item.id) !== undefined) return items
      else return [item, ...items]
    })
  }

  public get(id: string, options?: GetOptions): Readable<Maybe<T, E>> {
    if (this.values === undefined) throw new Error('Collection: values is not defined')

    return this.values.get(id, options)
  }

  public extract(id: string): T | null {
    if (this.values === undefined) throw new Error('Collection: values is not defined')

    return this.values.extract(id)
  }

  public delete(id: string): void {
    this.values?.delete(id)

    this.store.update((items) => {
      if (items === null || items instanceof Error) return items
      else return items.filter((item) => item.id !== id)
    })
  }

  public set(item: T, options?: SetOptions): void {
    this.store.update((items) => {
      if (items === null || items instanceof Error) return [item]

      const index = items.findIndex((i) => i.id === item.id)

      if (index === -1)
        return options?.add === true ? [item, ...items] : items

      items[index] = item

      return items
    })

    this.values?.set(item.id, item)
  }

  public update(id: string, update: (item: T) => T | void, options?: SetOptions): void {
    if (this.values === undefined)
      throw new Error('Collection: values is not defined')

    const asis = this.values.extract(id)

    if (asis === null)
      return

    const tobe = update(asis) ?? asis

    this.set(tobe, options)
  }

  public sync(): this {
    const stale = this.timestamp === 0 || this.timestamp + this.revalidate < Date.now()

    if (stale) {
      if (!this.stale)
        this.clear()

      void this.refresh()
    }

    return this
  }

  public async fetch() {
    await this.refresh()

    return this
  }

  public replace(items: T[]): void {
    const values = items

    this.store.set(values)
    this.timestamp = Date.now()

    if (this.values !== undefined)
      for (const value of values)
        this.values.set(value.id, value)
  }

  private async refresh() {
    if (this.request === undefined) return

    this.timestamp = Date.now()
    const items = await this.request()

    if (!(items instanceof Error)) this.replace(items)
    else this.store.set(items)
  }

  private persist(key: string) {
    if (typeof window === 'undefined')
      return

    const items = this.load(key)

    if (items !== null) {
      this.store.set(items)

      if (this.values?.persistent === false)
        for (const item of items) this.values.set(item.id, item)
    }

    this.store.subscribe((items) => {
      if (items instanceof Error) return

      if (items === null) localStorage.removeItem(key)
      else localStorage.setItem(key, JSON.stringify(items))
    })
  }

  private load(key: string): T[] | null {
    if (typeof window === 'undefined')
      return null

    const stored = localStorage.getItem(key)

    if (stored === null)
      return null

    try {
      const items = JSON.parse(stored) as T[]

      if (!Array.isArray(items)) {
        console.error(`Storage value for ${key} is not an array:`, items)

        return null
      }

      return items
    } catch (error) {
      console.error(`Invalid storage value for ${key}`, error)

      return null
    }
  }

  private bind(store: Readable<unknown | null>): void {
    store.subscribe((value) => {
      if (value === null) this.clear()
    })
  }

  private clear(): void {
    this.store.set(null)
    this.values?.clear()
    this.timestamp = 0
  }
}

interface Options<T = unknown, E extends Error = Error> {
  /** Fetches the collection. */
  get?: () => Promise<T[] | E>

  /** Time in milliseconds before revalidating the collection. Defaults to 300 seconds. */
  revalidate?: number

  /** Whether to keep the collection while revalidating. Defaults to false. */
  stale?: boolean

  /** Values store. */
  values?: Values<T, E>

  /** Key to persist the collection. */
  persist?: string

  /** Nullifies the collection when the bound store is null. */
  bind?: Readable<unknown | null>
}

export interface Identifiable {
  id: string
}

export interface SetOptions {
  /** Whether to add the item to the collection if it does not exist. Defaults to false. */
  add?: boolean
}

export function collection<T extends Identifiable, E extends Error = Error>(
  options: Options<T, E>
): Collection<T, E> {
  return new Collection(options)
}

const DEFAULTS = {
  revalidate: 300_000,
  stale: false
} as const satisfies Omit<Options, 'get'>
