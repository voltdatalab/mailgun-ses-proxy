import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('dashboard newsletter navigation policy', () => {
    it('uses the Next router for View All rather than mutating browser location', () => {
        const source = readFileSync('app/dashboard/page.tsx', 'utf8')
        expect(source).toContain('import { useRouter } from "next/navigation"')
        expect(source).toContain('const router = useRouter()')
        expect(source).toContain('onClick={() => router.push("/dashboard/newsletters")}')
        expect(source).not.toMatch(/window\.location(?:\.href)?\s*=/)
    })
})
