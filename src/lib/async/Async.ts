import type { Snippet } from 'svelte'
import type { Readable } from 'svelte/store'

export interface Props<T> {
  store: Readable<T | null | Error>
  /** What is shown while the store has no value yet: nothing, where it is not given */
  waiting?: Snippet
  awaited: Snippet<[T]>
  error?: Snippet<[Error]>
  /** Shows nothing on an error the `error` snippet does not render */
  silent?: boolean
}

export { default as Async } from './Async.svelte'
