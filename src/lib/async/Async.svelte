<script lang="ts" generics="T">
  import type { Props } from "./Async";

  const { store, waiting, awaited, error }: Props<T> = $props();
</script>

{#if $store === null}
  {#if waiting}
    {@render waiting()}
  {/if}
{:else if $store instanceof Error}
  {#if error}
    {@render error($store)}
  {/if}
{:else}
  {@render awaited($store)}
{/if}
