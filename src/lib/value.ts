import {
  get,
  writable,
  type Readable,
  type Subscriber,
  type Unsubscriber,
  type Updater,
  type Writable
} from 'svelte/store'

export class Value<T> implements Writable<T | null> {
  private readonly store: Writable<T | null>
  private readonly default: T | null
  private readonly request: Options<T>['get']
  private readonly revalidate: number
  private timestamp: number = 0

  public constructor(options: Options<T>) {
    this.default = options.default ?? null
    this.request = options.get
    this.revalidate = options.revalidate ?? DEFAULTS.revalidate

    this.store = options.persist === undefined || typeof window === 'undefined'
      ? writable<T | null>(this.default)
      : persistent<T>(options.persist as string, this.default, options.session)

    if (options.bind)
      this.bind(options.bind)
  }

  public set(value: T | null): void {
    this.store.set(value)
  }

  public update(updater: Updater<T | null>): void {
    this.store.update((value) => {
      const updated = updater(value)

      return updated
    })
  }

  public subscribe(run: Subscriber<T | null>, invalidate?: () => void): Unsubscriber {
    // a server renders what the store holds: it cannot wait for a request, and a store is shared by
    // every request the server renders
    if (typeof window !== 'undefined')
      this.sync()

    return this.store.subscribe(run, invalidate)
  }

  public extract(): T | null {
    return get(this.store)
  }

  public sync(): void {
    if (this.request === undefined) return

    const stale = this.timestamp + this.revalidate < Date.now()

    if (stale) 
      void this.refresh()    
  }

  private async refresh(): Promise<void> {
    if (this.request === undefined) return

    this.timestamp = Date.now()

    const value = await this.request()

    if (!(value instanceof Error))
      this.set(value)
  }

  private bind(store: Readable<unknown | null>): void {
    store.subscribe((value) => {
      if (value === null)
        this.store.set(this.default)
    })
  }
}

export function value<T>(options: Options<T> = {}): Value<T> {
  return new Value<T>(options)
}

function persistent<T>(key: string, def: T | null, session?: boolean): Writable<T | null> {
  const store = writable(load<T>(key) ?? def)
  const type = session ? 'sessionStorage' : 'localStorage'

  store.subscribe((value) => {
    if (value === null) window[type].removeItem(key)
    else window[type].setItem(key, JSON.stringify(value))
  })

  return store
}

function load<T>(key: string): T | null {
  const json = window.localStorage.getItem(key)

  if (json === null) return null

  try {
    return JSON.parse(json) as T
  } catch (error) {
    console.error(`Invalid storage value for ${key}`, error)

    return null
  }
}

interface Options<T = unknown> {
  /**
   * Fetches the value
   */
  get?: () => Promise<T | Error>

  /** Time in milliseconds before revalidating the collection. Defaults to 300 seconds. */
  revalidate?: number

  /**
   * Key to persist the collection.
   */
  persist?: string

  /**
   * Persist the collection in the session storage.
   * If `persist` is not set, `session` is ignored.
   */
  session?: boolean

  /**
   * Nullify values when the bound store is null.
   */
  bind?: Readable<unknown | null>

  /**
   * Default value.
   */
  default?: T
}

const DEFAULTS = {
  revalidate: 300_000,
} as const satisfies Omit<Options, 'get'>
