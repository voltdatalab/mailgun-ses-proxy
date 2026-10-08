import { describe, it, expect } from 'vitest'
import { verify } from 'node:crypto'
import { HISTORICAL_ACQUISITION_DOMAIN, createHistoricalAcquisitionVerifier } from '../../service/newsletter-retention-historical-acquisition'
import { openNewsletterRetentionHistoricalArchiveStream } from '../../service/newsletter-retention-archive-stream-source'
import { adaptNewsletterRetentionHistoricalArchive } from '../../service/newsletter-retention-historical-archive'
import { chunks, fixedRows, frame, hash, signedFixture, type Tag } from './newsletter-retention-historical-ci-fixture'

// Only fixture contract tests: these rows/digests are synthetic and do NOT
// certify native SQL acquisition, commit, rollback, isolation or hosted CI.
describe('historical CI fixture contract (offline synthetic, no DB)', () => {
    const rows = fixedRows('offline-contract')
    const digests = {} as Record<Tag, string>
    for (const [tag, row] of [['B', rows.parent], ['M', rows.message], ['E', rows.error], ['N', rows.notification]] as const) {
        digests[tag] = hash(`${tag}\t${Buffer.from(row.id!).toString('hex').toUpperCase()}\t${hash(frame(tag, row).split('!')[1])}\n`)
    }
    const now = '2026-10-08T14:00:00.000Z'
    it('builds connected envelope/afterimage, exact finite selection and authenticated bytes', async () => {
        const f = await signedFixture(rows, hash('synthetic Prisma'), hash('synthetic SQL'), digests, now)
        const source = await openNewsletterRetentionHistoricalArchiveStream(chunks(f.bytes), { ...f.binding, expectedProcedureFingerprint: f.procedureFingerprint })
        try {
            const selected = await adaptNewsletterRetentionHistoricalArchive(source.chain, source.binding, f.policy)
            expect(selected.records).toHaveLength(4)
            expect(selected.readbackDigests).toEqual(digests)
            expect(selected.records.at(-1)).toMatchObject({ row: rows.notification })
            expect(selected.records.map(record => record.row.id)).not.toContain(rows.otherParent.id)
            expect(verify(null, Buffer.concat([Buffer.from(HISTORICAL_ACQUISITION_DOMAIN), f.acquisition.attestationBytes]), f.publicKeyPem, f.acquisition.signature)).toBe(true)
            const authenticate = createHistoricalAcquisitionVerifier({ publicKeyPem: f.publicKeyPem, collectorId: 'historical-ci-test-collector', expectedSqlDatabaseFingerprint: hash('synthetic SQL'), expectedPrismaFileFingerprint: hash('synthetic Prisma'), procedureFingerprint: f.procedureFingerprint, maxAgeMs: 60000 })
            expect(() => authenticate(f.acquisition, f.expected, new Date(now))).not.toThrow()
        } finally { await source.close() }
    })
    it('refuses report construction if independently supplied digest acquisition differs', async () => {
        await expect(signedFixture(rows, hash('synthetic Prisma'), hash('synthetic SQL'), { ...digests, N: hash('wrong native digest') }, now)).rejects.toThrow('native acquisition differs')
    })
})
