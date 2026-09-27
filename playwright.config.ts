import { defineConfig } from '@playwright/test'

export default defineConfig({
	testDir: 'tests',
	workers: 1,
	webServer: {
		command: 'npm run dev -- --port 4173 --strictPort',
		url: 'http://localhost:4173/test/reflection',
		reuseExistingServer: false
	},
	use: { baseURL: 'http://localhost:4173' }
})
