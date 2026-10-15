import type { Snippet } from 'svelte'
import type { Readable } from 'svelte/store'

export interface Props<T> {
  store: Readable<T | null | Error>
  /** What is shown while the store has no value yet: nothing, where it is not given */
  waiting?: Snippet
  awaited: Snippet<[T]>
  /** What is shown once the store holds an error: nothing, where it is not given */
  error?: Snippet<[Error]>
  /** @deprecated An error shows nothing unless `error` is given: this has no effect */
  silent?: boolean
}

export { default as Async } from './Async.svelte'
