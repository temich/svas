import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

const pot = (id: string, VERSION: number, title = id, type = 'green') => ({ id, VERSION, type, title })

async function server(request: APIRequestContext, body: object): Promise<{ reads: Array<string | null> }> {
	return await (await request.post('/test/stream', { data: body })).json()
}

const green = (page: Page) => page.getByTestId('green')

async function sync(page: Page): Promise<string | null> {
	return await page.evaluate(() => (window as unknown as { sync: () => Promise<string | null> }).sync())
}

let name = ''

test.beforeEach(async ({ request }, info) => {
	name = `pots-${info.testId}`

	await server(request, { op: 'reset' })

	for (const id of ['a', 'b', 'c']) await server(request, { op: 'put', pot: pot(id, 1) })
	await server(request, { op: 'put', pot: pot('x', 1, 'x', 'brown') })
})

test('reads the collection in pages and answers from IndexedDB after a reload', async ({ page, request }) => {
	await page.goto(`/test/reflection?name=${name}`)
	await expect(green(page)).toHaveText('["a","b","c"]')

	const before = (await server(request, { op: 'noop' })).reads.length

	// the copy answers before the stream does
	await page.route('**/test/stream*', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 2000))
		await route.continue()
	})

	await page.reload()
	await expect(green(page)).toHaveText('["a","b","c"]', { timeout: 1000 })
	expect((await server(request, { op: 'noop' })).reads.length).toBe(before)
})

test('reads what changed: an update, a removal, an entry leaving the query', async ({ page, request }) => {
	await page.goto(`/test/reflection?name=${name}`)
	await expect(green(page)).toHaveText('["a","b","c"]')

	await server(request, { op: 'put', pot: pot('a', 2, 'A') })
	await server(request, { op: 'remove', id: 'b' })
	await server(request, { op: 'put', pot: pot('c', 2, 'c', 'brown') })

	expect(await sync(page)).toBeNull()
	await expect(green(page)).toHaveText('["A"]')
})

test('keeps nothing of a cut read, and completes it on the next sync', async ({ page, request }) => {
	await page.goto(`/test/reflection?name=${name}`)
	await expect(green(page)).toHaveText('["a","b","c"]')

	await server(request, { op: 'put', pot: pot('d', 1) })
	await server(request, { op: 'cut' })

	expect(await sync(page)).toMatch(/cut/)
	await expect(green(page)).toHaveText('["a","b","c"]')

	expect(await sync(page)).toBeNull()
	await expect(green(page)).toHaveText('["a","b","c","d"]')
})

test('reads the collection again when the token has expired', async ({ page, request }) => {
	await page.goto(`/test/reflection?name=${name}`)
	await expect(green(page)).toHaveText('["a","b","c"]')

	await server(request, { op: 'remove', id: 'a' })
	await server(request, { op: 'forget' })

	expect(await sync(page)).toBeNull()
	await expect(green(page)).toHaveText('["b","c"]')
})

test('another tab takes what one tab read, without reading it again', async ({ context, request }) => {
	const one = await context.newPage()
	const two = await context.newPage()

	await one.goto(`/test/reflection?name=${name}`)
	await expect(green(one)).toHaveText('["a","b","c"]')
	await two.goto(`/test/reflection?name=${name}`)
	await expect(green(two)).toHaveText('["a","b","c"]')

	await server(request, { op: 'put', pot: pot('b', 2, 'B') })

	const before = (await server(request, { op: 'noop' })).reads.length

	expect(await sync(one)).toBeNull()
	await expect(green(two)).toHaveText('["a","B","c"]')
	await expect(green(one)).toHaveText('["a","B","c"]')

	// one sync reads the change and then finds nothing more; the other tab read nothing
	expect((await server(request, { op: 'noop' })).reads.length - before).toBe(2)
})

test('two tabs syncing at once read one after the other', async ({ context, request }) => {
	const one = await context.newPage()
	const two = await context.newPage()

	await one.goto(`/test/reflection?name=${name}`)
	await expect(green(one)).toHaveText('["a","b","c"]')
	await two.goto(`/test/reflection?name=${name}`)
	await expect(green(two)).toHaveText('["a","b","c"]')

	await server(request, { op: 'put', pot: pot('d', 1) })

	const [a, b] = await Promise.all([sync(one), sync(two)])

	expect([a, b]).toEqual([null, null])
	await expect(green(one)).toHaveText('["a","b","c","d"]')
	await expect(green(two)).toHaveText('["a","b","c","d"]')
})
