import { defineConfig } from 'vitest/config'

// Dedicated mandatory phase; not part of ordinary/safe reports and never skipped.
export default defineConfig({
    test: {
        include: ['tests/integration/retention-historical-db.integration.ts'],
        setupFiles: [], environment: 'node', maxWorkers: 1, fileParallelism: false,
        testTimeout: 120_000, hookTimeout: 15_000,
    },
})
