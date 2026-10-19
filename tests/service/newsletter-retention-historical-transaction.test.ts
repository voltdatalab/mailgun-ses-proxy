import { describe, expect, it, vi } from 'vitest'
import { recheckAndApplyNewsletterRetentionArchiveBatchForFixture } from '@/service/newsletter-retention-applier'

describe('historical protected transaction boundary', () => {
    it('cannot enter fixture seam from production, regardless of caller context flags', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        try {
            await expect(recheckAndApplyNewsletterRetentionArchiveBatchForFixture({} as never, {} as never, [])).rejects.toThrow('admission is not enabled')
        } finally { vi.unstubAllEnvs() }
    })
    it('rejects batchId reuse before any content read or delete', async () => {
        const findFirst = vi.fn()
        const tx = { newsletterBatch: { findMany: async () => [{ id: 'one' }, { id: 'reused' }], findFirst } }
        await expect(recheckAndApplyNewsletterRetentionArchiveBatchForFixture(tx as never, { manifest: { batches: [{ batchId: 'group' }] }, artifact: { bindings: [{ batchRecordId: 'one', manifestIndex: 0 }] } } as never, [])).rejects.toThrow('parent set mismatch')
        expect(findFirst).not.toHaveBeenCalled()
    })
})
