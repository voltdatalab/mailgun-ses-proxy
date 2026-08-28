import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    NEWSLETTER_RETENTION_ESCROW_MAX_BATCHES,
    NEWSLETTER_RETENTION_ESCROW_MAX_LINE_BYTES,
    NEWSLETTER_RETENTION_ESCROW_MAX_MESSAGES,
    NEWSLETTER_RETENTION_ESCROW_MAX_RECORDS,
    NEWSLETTER_RETENTION_ESCROW_MAX_TOTAL_BYTES,
    NEWSLETTER_RETENTION_ESCROW_VERSION,
    createNewsletterRetentionEscrowAccumulator,
    serializeNewsletterRetentionEscrowFooter,
    serializeNewsletterRetentionEscrowHeader,
    serializeNewsletterRetentionEscrowRecord,
} from '@/service/newsletter-retention-escrow'

const HEADER = {
    kind: 'header' as const,
    version: NEWSLETTER_RETENTION_ESCROW_VERSION,
    siteId: 'tenant-a',
    cutoff: '2026-08-27T12:00:00.000Z',
    policyVersion: 1,
    publicManifestHash: 'a'.repeat(64),
    schemaFingerprint: 'b'.repeat(64),
}

const BATCH_0 = {
    kind: 'newsletterBatch' as const,
    manifestIndex: 0,
    row: {
        id: 'batch-0',
        siteId: 'tenant-a',
        fromEmail: 'news@example.test',
        contents: 'batch zero body',
        batchId: 'public-batch-0',
        created: '2026-08-27T10:00:00.000Z',
    },
}

const MESSAGE_0 = {
    kind: 'newsletterMessages' as const,
    manifestIndex: 0,
    row: {
        id: 'message-0',
        messageId: 'message-id-0',
        toEmail: 'alpha@example.test',
        newsletterBatchId: 'batch-0',
        created: '2026-08-27T10:01:00.000Z',
        formatedContents: 'message zero body',
        recipientData: null,
    },
}

const MESSAGE_1 = {
    kind: 'newsletterMessages' as const,
    manifestIndex: 0,
    row: {
        id: 'message-1',
        messageId: 'message-id-1',
        toEmail: 'beta@example.test',
        newsletterBatchId: 'batch-0',
        created: '2026-08-27T10:02:00.000Z',
        formatedContents: 'message one body',
        recipientData: 'recipient-data',
    },
}

const ERROR_0 = {
    kind: 'newsletterErrors' as const,
    manifestIndex: 0,
    row: {
        id: 'error-0',
        toEmail: 'fail@example.test',
        error: 'send failed',
        created: '2026-08-27T10:03:00.000Z',
        newsletterBatchId: 'batch-0',
        messageId: 'error-message-id-0',
        formatedContents: 'error body',
        recipientData: null,
    },
}

const NOTIFICATION_0 = {
    kind: 'newsletterNotifications' as const,
    manifestIndex: 0,
    row: {
        id: 'notification-0',
        type: 'Delivery',
        notificationId: 'notification-id-0',
        messageId: 'message-id-0',
        rawEvent: '{"eventType":"Delivery"}',
        timestamp: '2026-08-27T10:04:00.000Z',
        created: '2026-08-27T10:04:01.000Z',
    },
}

const BATCH_1 = {
    kind: 'newsletterBatch' as const,
    manifestIndex: 1,
    row: {
        id: 'batch-1',
        siteId: 'tenant-a',
        fromEmail: 'news@example.test',
        contents: 'batch one body',
        batchId: 'public-batch-1',
        created: '2026-08-27T11:00:00.000Z',
    },
}

function canonicalContentHash(lines: string[]): string {
    return createHash('sha256').update(lines.map((line) => `${line}\n`).join('')).digest('hex')
}

describe('service/newsletter-retention-escrow', () => {
    it('serializes a canonical escrow and verifies it one line at a time without keeping rows', () => {
        const headerLine = serializeNewsletterRetentionEscrowHeader(HEADER)
        const recordLines = [
            serializeNewsletterRetentionEscrowRecord(BATCH_0),
            serializeNewsletterRetentionEscrowRecord(MESSAGE_0),
            serializeNewsletterRetentionEscrowRecord(MESSAGE_1),
            serializeNewsletterRetentionEscrowRecord(ERROR_0),
            serializeNewsletterRetentionEscrowRecord(NOTIFICATION_0),
            serializeNewsletterRetentionEscrowRecord(BATCH_1),
        ]
        const contentHash = canonicalContentHash([headerLine, ...recordLines])
        const footerLine = serializeNewsletterRetentionEscrowFooter({
            kind: 'footer',
            counts: {
                batches: 2,
                messages: 2,
                errors: 1,
                notifications: 1,
            },
            contentHash,
        })

        const accumulator = createNewsletterRetentionEscrowAccumulator()
        expect(accumulator.consume(headerLine)).toBeUndefined()
        expect(accumulator.consume(recordLines[0])).toBeUndefined()
        expect(accumulator.consume(recordLines[1])).toBeUndefined()
        expect(accumulator.consume(recordLines[2])).toBeUndefined()
        expect(accumulator.consume(recordLines[3])).toBeUndefined()
        expect(accumulator.consume(recordLines[4])).toBeUndefined()
        expect(accumulator.consume(recordLines[5])).toBeUndefined()

        const result = accumulator.consume(footerLine)
        expect(result).toEqual({
            version: NEWSLETTER_RETENTION_ESCROW_VERSION,
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            policyVersion: 1,
            publicManifestHash: 'a'.repeat(64),
            schemaFingerprint: 'b'.repeat(64),
            contentHash,
            counts: {
                batches: 2,
                messages: 2,
                errors: 1,
                notifications: 1,
            },
        })
        expect(accumulator.finalize()).toEqual(result)
        expect(Object.keys(result ?? {})).toEqual([
            'version',
            'siteId',
            'cutoff',
            'policyVersion',
            'publicManifestHash',
            'schemaFingerprint',
            'contentHash',
            'counts',
        ])
    })

    it('rejects nested duplicate JSON keys before it reaches JSON.parse', () => {
        const accumulator = createNewsletterRetentionEscrowAccumulator()

        expect(() => accumulator.consume('{"kind":"footer","counts":{"batches":1,"batches":2,"messages":0,"errors":0,"notifications":0},"contentHash":"'.padEnd(80, 'a') + '"}'))
            .toThrow('escrow line must contain unique JSON keys')
    })

    it('rejects exact-key drift, arrays where objects are expected, and bad scalar shapes', () => {
        expect(() => serializeNewsletterRetentionEscrowHeader({
            ...HEADER,
            extra: 'nope',
        } as never)).toThrow('header must have exact keys')

        expect(() => serializeNewsletterRetentionEscrowRecord({
            ...BATCH_0,
            row: [] as never,
        })).toThrow('record row must be a plain object')

        expect(() => serializeNewsletterRetentionEscrowFooter({
            kind: 'footer',
            counts: {
                batches: 1,
                messages: 0,
                errors: 0,
                notifications: 0,
                extra: 1,
            } as never,
            contentHash: 'c'.repeat(64),
        } as never)).toThrow('footer counts must have exact keys')

        expect(() => serializeNewsletterRetentionEscrowHeader({
            ...HEADER,
            siteId: ' tenant-a',
        })).toThrow('siteId must be a non-empty string')

        expect(() => serializeNewsletterRetentionEscrowHeader({
            ...HEADER,
            publicManifestHash: 'A'.repeat(64),
        })).toThrow('publicManifestHash must be a lowercase 64-hex string')
    })

    it('rejects ordering drift, duplicate unique keys, and records after the footer', () => {
        const accumulator = createNewsletterRetentionEscrowAccumulator()

        expect(() => {
            accumulator.consume(serializeNewsletterRetentionEscrowHeader(HEADER))
            accumulator.consume(serializeNewsletterRetentionEscrowRecord(BATCH_1))
            accumulator.consume(serializeNewsletterRetentionEscrowRecord(BATCH_0))
        }).toThrow('manifestIndex must be sequential starting at 0')

        const duplicateKeys = createNewsletterRetentionEscrowAccumulator()
        duplicateKeys.consume(serializeNewsletterRetentionEscrowHeader(HEADER))
        duplicateKeys.consume(serializeNewsletterRetentionEscrowRecord(BATCH_0))
        duplicateKeys.consume(serializeNewsletterRetentionEscrowRecord(MESSAGE_0))
        expect(() => duplicateKeys.consume(serializeNewsletterRetentionEscrowRecord({
            ...MESSAGE_1,
            row: {
                ...MESSAGE_1.row,
                messageId: MESSAGE_0.row.messageId,
            },
        }))).toThrow('messageId must be unique')

        const afterFooter = createNewsletterRetentionEscrowAccumulator()
        afterFooter.consume(serializeNewsletterRetentionEscrowHeader(HEADER))
        afterFooter.consume(serializeNewsletterRetentionEscrowRecord(BATCH_0))
        afterFooter.consume(serializeNewsletterRetentionEscrowFooter({
            kind: 'footer',
            counts: { batches: 1, messages: 0, errors: 0, notifications: 0 },
            contentHash: canonicalContentHash([
                serializeNewsletterRetentionEscrowHeader(HEADER),
                serializeNewsletterRetentionEscrowRecord(BATCH_0),
            ]),
        }))
        expect(() => afterFooter.consume(serializeNewsletterRetentionEscrowRecord(BATCH_1)))
            .toThrow('records after footer are not allowed')
    })

    it('accepts schema-valid cross-model collisions, repeated batchId values, and empty payload fields', () => {
        const batch0 = { ...BATCH_0, row: { ...BATCH_0.row, contents: '' } }
        const message0 = { ...MESSAGE_0, row: { ...MESSAGE_0.row, formatedContents: '' } }
        const error0 = {
            ...ERROR_0,
            row: {
                ...ERROR_0.row,
                id: MESSAGE_0.row.id,
                messageId: MESSAGE_0.row.messageId,
                error: '',
                formatedContents: '',
            },
        }
        const notification0 = {
            ...NOTIFICATION_0,
            row: { ...NOTIFICATION_0.row, id: MESSAGE_0.row.id, rawEvent: '' },
        }
        const batch1 = { ...BATCH_1, row: { ...BATCH_1.row, batchId: BATCH_0.row.batchId } }
        const lines = [
            serializeNewsletterRetentionEscrowHeader(HEADER),
            serializeNewsletterRetentionEscrowRecord(batch0),
            serializeNewsletterRetentionEscrowRecord(message0),
            serializeNewsletterRetentionEscrowRecord(error0),
            serializeNewsletterRetentionEscrowRecord(notification0),
            serializeNewsletterRetentionEscrowRecord(batch1),
        ]
        const accumulator = createNewsletterRetentionEscrowAccumulator()
        for (const line of lines) accumulator.consume(line)
        const result = accumulator.consume(serializeNewsletterRetentionEscrowFooter({
            kind: 'footer',
            counts: { batches: 2, messages: 1, errors: 1, notifications: 1 },
            contentHash: canonicalContentHash(lines),
        }))

        expect(result?.counts).toEqual({ batches: 2, messages: 1, errors: 1, notifications: 1 })
    })

    it('binds parent rows to the header tenant and permanently fails after malformed input', () => {
        const tenantMismatch = createNewsletterRetentionEscrowAccumulator()
        tenantMismatch.consume(serializeNewsletterRetentionEscrowHeader(HEADER))
        expect(() => tenantMismatch.consume(serializeNewsletterRetentionEscrowRecord({
            ...BATCH_0,
            row: { ...BATCH_0.row, siteId: 'tenant-b' },
        }))).toThrow('batch siteId must match escrow siteId')
        expect(() => tenantMismatch.consume(serializeNewsletterRetentionEscrowRecord(BATCH_0)))
            .toThrow('escrow accumulator is failed')

        const nonCanonical = createNewsletterRetentionEscrowAccumulator()
        expect(() => nonCanonical.consume(` ${serializeNewsletterRetentionEscrowHeader(HEADER)}`))
            .toThrow('escrow line must use canonical encoding')
        expect(() => nonCanonical.consume(serializeNewsletterRetentionEscrowHeader(HEADER)))
            .toThrow('escrow accumulator is failed')
    })

    it('sanitizes invalid byte input and does not allow hard limits to be raised', () => {
        expect(() => createNewsletterRetentionEscrowAccumulator({
            lineBytesLimit: NEWSLETTER_RETENTION_ESCROW_MAX_LINE_BYTES + 1,
        })).toThrow('lineBytesLimit must be a positive safe integer within the hard limit')
        expect(() => createNewsletterRetentionEscrowAccumulator({
            totalBytesLimit: NEWSLETTER_RETENTION_ESCROW_MAX_TOTAL_BYTES + 1,
        })).toThrow('totalBytesLimit must be a positive safe integer within the hard limit')

        const invalidUtf8 = createNewsletterRetentionEscrowAccumulator()
        expect(() => invalidUtf8.consume(new Uint8Array([0xff])))
            .toThrow('escrow line must be valid UTF-8')
    })

    it('represents an exact empty candidate set without authorizing any rows', () => {
        const headerLine = serializeNewsletterRetentionEscrowHeader(HEADER)
        const accumulator = createNewsletterRetentionEscrowAccumulator()
        accumulator.consume(headerLine)
        const result = accumulator.consume(serializeNewsletterRetentionEscrowFooter({
            kind: 'footer',
            counts: { batches: 0, messages: 0, errors: 0, notifications: 0 },
            contentHash: canonicalContentHash([headerLine]),
        }))

        expect(result?.counts).toEqual({ batches: 0, messages: 0, errors: 0, notifications: 0 })
    })

    it('rejects footer count and content-hash drift', () => {
        const headerLine = serializeNewsletterRetentionEscrowHeader(HEADER)
        const batchLine = serializeNewsletterRetentionEscrowRecord(BATCH_0)
        const contentHash = canonicalContentHash([headerLine, batchLine])

        const countDrift = createNewsletterRetentionEscrowAccumulator()
        countDrift.consume(headerLine)
        countDrift.consume(batchLine)
        expect(() => countDrift.consume(serializeNewsletterRetentionEscrowFooter({
            kind: 'footer',
            counts: { batches: 2, messages: 0, errors: 0, notifications: 0 },
            contentHash,
        }))).toThrow('footer counts must match observed counts')

        const hashDrift = createNewsletterRetentionEscrowAccumulator()
        hashDrift.consume(headerLine)
        hashDrift.consume(batchLine)
        expect(() => hashDrift.consume(serializeNewsletterRetentionEscrowFooter({
            kind: 'footer',
            counts: { batches: 1, messages: 0, errors: 0, notifications: 0 },
            contentHash: 'f'.repeat(64),
        }))).toThrow('footer contentHash must match observed content')
    })

    it('rejects non-canonical child encodings and the orphan-ledger record kind', () => {
        const headerLine = serializeNewsletterRetentionEscrowHeader(HEADER)
        const batchLine = serializeNewsletterRetentionEscrowRecord(BATCH_0)
        const nonCanonical = (line: string) => line.replace(',"manifestIndex"', ', "manifestIndex"')

        const messageAccumulator = createNewsletterRetentionEscrowAccumulator()
        messageAccumulator.consume(headerLine)
        messageAccumulator.consume(batchLine)
        expect(() => messageAccumulator.consume(nonCanonical(serializeNewsletterRetentionEscrowRecord(MESSAGE_0))))
            .toThrow('escrow line must use canonical encoding')

        const errorAccumulator = createNewsletterRetentionEscrowAccumulator()
        errorAccumulator.consume(headerLine)
        errorAccumulator.consume(batchLine)
        expect(() => errorAccumulator.consume(nonCanonical(serializeNewsletterRetentionEscrowRecord(ERROR_0))))
            .toThrow('escrow line must use canonical encoding')

        const notificationAccumulator = createNewsletterRetentionEscrowAccumulator()
        notificationAccumulator.consume(headerLine)
        notificationAccumulator.consume(batchLine)
        notificationAccumulator.consume(serializeNewsletterRetentionEscrowRecord(MESSAGE_0))
        expect(() => notificationAccumulator.consume(nonCanonical(serializeNewsletterRetentionEscrowRecord(NOTIFICATION_0))))
            .toThrow('escrow line must use canonical encoding')

        const orphanAccumulator = createNewsletterRetentionEscrowAccumulator()
        orphanAccumulator.consume(headerLine)
        expect(() => orphanAccumulator.consume(JSON.stringify({
            kind: 'newsletterNotificationOrphan',
            manifestIndex: 0,
            row: {},
        }))).toThrow('record kind must be a known model')
    })

    it('enforces byte, total byte, record, batch, and message limits', () => {
        expect(NEWSLETTER_RETENTION_ESCROW_MAX_LINE_BYTES).toBeGreaterThan(0)
        expect(NEWSLETTER_RETENTION_ESCROW_MAX_TOTAL_BYTES).toBeGreaterThan(NEWSLETTER_RETENTION_ESCROW_MAX_LINE_BYTES)
        expect(NEWSLETTER_RETENTION_ESCROW_MAX_RECORDS).toBeGreaterThan(0)
        expect(NEWSLETTER_RETENTION_ESCROW_MAX_BATCHES).toBeGreaterThan(0)
        expect(NEWSLETTER_RETENTION_ESCROW_MAX_MESSAGES).toBeGreaterThan(0)

        const oversizedLine = createNewsletterRetentionEscrowAccumulator({ lineBytesLimit: 8 })
        expect(() => oversizedLine.consume('xxxxxxxxx')).toThrow('escrow line exceeds byte limit')

        const headerLine = serializeNewsletterRetentionEscrowHeader(HEADER)
        const batchLine = serializeNewsletterRetentionEscrowRecord(BATCH_0)
        const oversizedTotal = createNewsletterRetentionEscrowAccumulator({ totalBytesLimit: Buffer.byteLength(headerLine) + 1 })
        oversizedTotal.consume(headerLine)
        expect(() => oversizedTotal.consume(batchLine)).toThrow('escrow byte budget exceeded')

        const oversizedRecords = createNewsletterRetentionEscrowAccumulator({ recordLimit: 2 })
        oversizedRecords.consume(headerLine)
        oversizedRecords.consume(batchLine)
        expect(() => oversizedRecords.consume(serializeNewsletterRetentionEscrowRecord(BATCH_1))).toThrow('escrow record limit exceeded')

        const oversizedBatches = createNewsletterRetentionEscrowAccumulator({ batchLimit: 1 })
        oversizedBatches.consume(headerLine)
        oversizedBatches.consume(batchLine)
        expect(() => oversizedBatches.consume(serializeNewsletterRetentionEscrowRecord(BATCH_1))).toThrow('batch limit exceeded')

        const oversizedMessages = createNewsletterRetentionEscrowAccumulator({ messageLimit: 1 })
        oversizedMessages.consume(headerLine)
        oversizedMessages.consume(batchLine)
        oversizedMessages.consume(serializeNewsletterRetentionEscrowRecord(MESSAGE_0))
        expect(() => oversizedMessages.consume(serializeNewsletterRetentionEscrowRecord(MESSAGE_1))).toThrow('message limit exceeded')
    })
})
