# Svelte Async Stores

Svelte stores for asynchronous data with fetching, caching, revalidation, and persistence.

---

> Everything below this line is written by AI.

- `Maybe<T>` convention (`null | T | Error`) for all async states
- Built-in revalidation with stale-while-revalidate
- Optional `localStorage` / `sessionStorage` persistence
- Composable utilities for guards, awaits, and combinators

## TL;DR

```bash
npm i svas
```

```svelte
<script lang="ts">
  import { value, ok } from 'svas'

  const user = value<User>({
    get: () => fetch('/api/me').then((r) => r.json()),
    persist: 'user'
  })
</script>

{#if $user instanceof Error}
  <p>Failed to load</p>
{:else if $user === null}
  <p>Loading…</p>
{:else}
  <p>Hello, {$user.name}</p>
{/if}
```

## Conventions

All async stores expose their state as `Maybe<T, E> = null | T | E` where `E extends Error`:

- `null` — no data yet (loading, cleared, or not fetched)
- `T` — resolved value
- `E` — fetch error

Stores share a common lifecycle:

- Fetch is triggered lazily on first `subscribe`
- Revalidation happens automatically after `revalidate` ms (default `300_000`)
- `stale: true` keeps the previous value visible while revalidating
- `bind: Readable<unknown | null>` nullifies the store when the bound store becomes `null` (useful for tying data to a session/user)
- `persist: string` mirrors the store into `localStorage` under the given key

## Stores

### `value<T>(options)`

A single asynchronous value.

```ts
import { value } from 'svas'

const profile = value<Profile>({
  get: () => api.getProfile(),
  revalidate: 60_000,
  persist: 'profile',
  session: false,
  default: null,
  bind: session
})
```

Interface:

```ts
class Value<T> implements Writable<T | null> {
  subscribe(run): Unsubscriber   // triggers sync on first subscribe
  set(value: T | null): void
  update(updater): void
  extract(): T | null            // synchronous read
  sync(): void                   // revalidate if stale
}
```

Options:

- `get?: () => Promise<T | Error>` — fetcher
- `revalidate?: number` — ms before re-fetching (default `300_000`)
- `persist?: string` — storage key
- `session?: boolean` — use `sessionStorage` instead of `localStorage`
- `default?: T` — initial value when no persisted data exists
- `bind?: Readable<unknown | null>` — reset to `default` when bound store is `null`

### `values<T>(options)`

A keyed cache of asynchronous values. Each key has its own `Readable<Maybe<T>>` lifecycle.

```ts
import { values } from 'svas'

const products = values<Product>({
  get: (id) => api.getProduct(id),
  revalidate: 60_000,
  permanent: false,
  stale: true,
  persist: 'products',
  bind: session
})

const product = products.get('42')
```

Interface:

```ts
class Values<T, E extends Error = Error> {
  get(key, options?: { fetch?: boolean }): Readable<Maybe<T, E>>
  set(key, value: T | E, options?: { stash?: boolean }): Readable<T | E>
  reset(key): Maybe<T | E>      // restore stashed persistent value
  extract(key): T | null        // synchronous read, ignores errors
  delete(key): void
  clear(): void
}
```

Options:

- `get?: (key: string) => Promise<T | E>` — per-key fetcher
- `revalidate?: number` — ms before re-fetching (default `300_000`)
- `stale?: boolean` — keep value while revalidating (default `false`)
- `persist?: string` — storage key for the whole map
- `permanent?: boolean` — don't revalidate persisted entries on startup; combine with `revalidate: Infinity` to disable revalidation entirely
- `bind?: Readable<unknown | null>` — clear the cache when bound store is `null`

The `stash` flag marks a value as transient: the previously persisted value is remembered and can be restored with `reset(key)`. Useful for optimistic updates.

### `collection<T>(options)`

A list of identifiable items, optionally backed by a `values` store so individual items can be observed independently.

Items must extend `Identifiable`:

```ts
interface Identifiable {
  id: string
}
```

```ts
import { collection, values } from 'svas'

const items = values<Todo>({ persist: 'todos' })

const todos = collection<Todo>({
  get: () => api.listTodos(),
  values: items,
  revalidate: 60_000,
  stale: true,
  persist: 'todos:list',
  bind: session
})
```

Interface:

```ts
class Collection<T extends Identifiable, E extends Error = Error>
  implements Readable<Maybe<T[], E>>
{
  subscribe(run): Unsubscriber
  add(item: T): void
  set(item: T, options?: { add?: boolean }): void
  update(id, updater: (item) => T | void, options?): void
  delete(id): void
  get(id, options?): Readable<Maybe<T, E>>   // requires `values`
  extract(id): T | null                       // requires `values`
  replace(items: T[]): void
  sync(): this
  fetch(): Promise<this>
}
```

Options:

- `get?: () => Promise<T[] | E>` — list fetcher
- `revalidate?: number` — ms before re-fetching (default `300_000`)
- `stale?: boolean` — keep list while revalidating (default `false`)
- `values?: Values<T, E>` — side store for per-item subscriptions
- `persist?: string` — storage key for the list
- `bind?: Readable<unknown | null>` — clear on bound store nullification

When a `values` store is provided, mutations to the collection are mirrored into it, so components subscribed via `get(id)` update without re-fetching.

## Utilities

### `ok(value)`

Type guard narrowing a `Maybe<T>` to `T`:

```ts
import { ok } from 'svas'

if (ok($user)) {
  $user.name // typed as T, excludes null | Error
}
```

### `ensure(store)`

Synchronously reads a store and throws if the value is `null` or an `Error`. Use in code paths where the value is known to be resolved.

```ts
import { ensure } from 'svas'

const user = ensure(userStore)
```

### `having(store)`

Returns a promise that resolves with the first non-null, non-error value of the store.

```ts
import { having } from 'svas'

const user = await having(userStore) // T
```

### `awaited(store)`

Returns a promise that resolves with the first non-null value of the store, including errors.

```ts
import { awaited } from 'svas'

const result = await awaited(userStore) // T | Error
```

### `once(store, condition)`

Returns a promise that resolves with the first value satisfying `condition`. Building block for `having` and `awaited`.

```ts
import { once } from 'svas'

const ready = await once(status, (s) => s === 'ready')
```

### `combined(...stores)`

Combines multiple `Maybe` stores into one. Resolves to the tuple of values when all are non-null, to the first encountered `Error`, or to `null` while any is still loading.

```ts
import { combined } from 'svas'

const both = combined(user, settings)

// $both: [User, Settings] | null | Error
```

### `sync(store, item, options?)`

Merges a versioned item into a `Collection` or `Value` based on `VERSION`, and optionally deletes when `DELETED` is set. Useful for applying server events.

```ts
interface Comparable {
  id: string
  VERSION: number
  DELETED?: number | null
}
```

```ts
import { sync } from 'svas'

sync(todos, incoming)                    // insert/update if newer
sync(todos, incoming, { delete: false }) // ignore tombstones
```

### `Async`

Svelte component for rendering a `Maybe` store with `loading`, `error`, and default slots.

```svelte
<script lang="ts">
  import { Async } from 'svas'
</script>

<Async store={user}>
  {#snippet waiting()}<Spinner />{/snippet}
  {#snippet error(e)}<ErrorView {e} />{/snippet}
  {#snippet awaited(value)}<Profile {value} />{/snippet}
</Async>
```

## Types

```ts
import type { Maybe } from 'svas'

type Maybe<T, E extends Error = Error> = null | T | E
```
