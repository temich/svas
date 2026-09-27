<script lang="ts">
	import { onMount } from 'svelte'
	import { reflection, expired, type StreamPart } from '$lib'

	interface Pot {
		id: string
		VERSION: number
		type: string
		title: string
	}

	let green = $state<unknown>(null)

	onMount(() => {
		const name = new URLSearchParams(location.search).get('name') ?? 'pots'

		const pots = reflection<Pot>({
			name,
			indexes: { type: 'type' },
			stream: async (token) => {
				const query = token === undefined ? '' : `?token=${encodeURIComponent(token)}`
				const response = await fetch(`/test/stream${query}`)

				if (response.status === 410) return expired

				const parts = (await response.json()) as Array<StreamPart<Pot>>

				return (async function* () {
					for (const part of parts) yield part
				})()
			}
		})

		const query = pots.query('type', 'green')
		const unsubscribe = query.subscribe((value) => (green = value))

		Object.assign(window, {
			pots,
			sync: () => pots.sync().then((error) => error?.message ?? null),
			apply: (pot: Pot) => pots.apply(pot)
		})

		return unsubscribe
	})
</script>

<pre data-testid="green">{JSON.stringify(Array.isArray(green) ? green.map((pot) => pot.title) : green)}</pre>
