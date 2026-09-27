import { json } from '@sveltejs/kit'
import * as state from './state'

export function GET({ url }) {
	const token = url.searchParams.get('token')
	const limit = Number(url.searchParams.get('limit') ?? 2)
	const parts = state.read(token, limit)

	if (parts === null) return new Response(null, { status: 410 })

	return json(parts)
}

/** What a test does to the collection. */
export async function POST({ request }) {
	const { op, pot, id } = await request.json()

	if (op === 'reset') state.reset()
	if (op === 'put') state.put(pot)
	if (op === 'remove') state.remove(id)
	if (op === 'cut') state.cut()
	if (op === 'forget') state.forget()

	return json({ reads: state.reads() })
}
