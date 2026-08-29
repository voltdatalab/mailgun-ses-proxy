import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveNewsletterRetentionSchemaPath } from '@/service/newsletter-retention-schema-path'

const packagePath = resolve(process.cwd(), 'package.json')

describe('newsletter retention schema path', () => {
    it('resolves the source schema from both source and compiled runner locations', () => {
        expect(resolveNewsletterRetentionSchemaPath('file:///app/scripts/newsletter-retention.ts'))
            .toBe('/app/prisma/schema.prisma')
        expect(resolveNewsletterRetentionSchemaPath('file:///app/dist/scripts/newsletter-retention.js'))
            .toBe('/app/prisma/schema.prisma')
    })

    it('uses Bun for the compiled runner because its module graph uses the application aliases', async () => {
        const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
            scripts?: Record<string, unknown>
        }
        expect(packageJson.scripts?.['retention:newsletter'])
            .toBe('NODE_ENV=production bun dist/scripts/newsletter-retention.js')
    })
})
