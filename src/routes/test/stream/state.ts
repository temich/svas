// A collection a test drives: what a toa stream route answers of it, from a token or without one.

interface Pot {
	id: string
	VERSION: number
	type: string
	title: string
}

type Part = { entry: Pot } | { removed: string } | { token: string | null }

const state = {
	entries: new Map<string, Pot>(),
	log: [] as Array<{ id: string; removed?: true }>,
	/** reads answered, by the token they were asked with */
	reads: [] as Array<string | null>,
	/** the next read ends without its token */
	cut: false,
	/** the positions before this one are no longer held */
	horizon: 0
}

export function reset(): void {
	state.entries.clear()
	state.log = []
	state.reads = []
	state.cut = false
	state.horizon = 0
}

export function put(pot: Pot): void {
	state.entries.set(pot.id, pot)
	state.log.push({ id: pot.id })
}

export function remove(id: string): void {
	state.entries.delete(id)
	state.log.push({ id, removed: true })
}

export function cut(): void {
	state.cut = true
}

/** Forgets the history, as an oplog that rolled over. */
export function forget(): void {
	state.horizon = state.log.length
}

export function reads(): Array<string | null> {
	return state.reads
}

/** `null` where the token names a point no longer held. */
export function read(token: string | null, limit: number): Part[] | null {
	state.reads.push(token)

	const parts = answer(token, limit)

	if (parts === null) return null

	if (state.cut) {
		state.cut = false

		return parts.filter((part) => !('token' in part))
	}

	return parts
}

function answer(token: string | null, limit: number): Part[] | null {
	if (token === null || token.startsWith('p:')) {
		const [, position, after] = token === null ? [null, String(state.log.length), ''] : token.split(':')
		const ids = [...state.entries.keys()].sort().filter((id) => id > after)
		const page = ids.slice(0, limit)
		const parts: Part[] = page.map((id) => ({ entry: state.entries.get(id)! }))

		if (page.length === limit) parts.push({ token: `p:${position}:${page.at(-1)}` })
		else parts.push({ token: `c:${position}` })

		return parts
	}

	const position = Number(token.slice(2))

	if (position < state.horizon) return null

	const changes = state.log.slice(position, position + limit)
	const parts: Part[] = changes.map((change) =>
		change.removed === true || !state.entries.has(change.id)
			? { removed: change.id }
			: { entry: state.entries.get(change.id)! }
	)

	parts.push({ token: `c:${position + changes.length}` })

	return parts
}
