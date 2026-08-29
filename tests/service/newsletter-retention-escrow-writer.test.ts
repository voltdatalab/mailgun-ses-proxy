import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
    createNewsletterRetentionEscrowAccumulator,
    serializeNewsletterRetentionEscrowFooter,
    serializeNewsletterRetentionEscrowHeader,
    serializeNewsletterRetentionEscrowRecord,
    type NewsletterRetentionEscrowHeader,
    type NewsletterRetentionEscrowRecord,
} from '@/service/newsletter-retention-escrow'
import { writeNewsletterRetentionEscrow } from '@/service/newsletter-retention-escrow-writer'

const HEADER: NewsletterRetentionEscrowHeader = {
    kind: 'header',
    version: 1,
    siteId: 'tenant-a',
    cutoff: '2026-08-27T12:00:00.000Z',
    policyVersion: 1,
    publicManifestHash: 'a'.repeat(64),
    schemaFingerprint: 'b'.repeat(64),
}

const RECORDS: NewsletterRetentionEscrowRecord[] = [
    {
        kind: 'newsletterBatch',
        manifestIndex: 0,
        row: {
            id: 'batch-row',
            siteId: 'tenant-a',
            fromEmail: 'news@example.test',
            contents: '',
            batchId: 'public-batch',
            created: '2026-08-27T10:00:00.000Z',
        },
    },
    {
        kind: 'newsletterMessages',
        manifestIndex: 0,
        row: {
            id: 'message-row',
            messageId: 'message-id',
            toEmail: 'recipient@example.test',
            newsletterBatchId: 'batch-row',
            created: '2026-08-27T10:01:00.000Z',
            formatedContents: '',
            recipientData: null,
        },
    },
    {
        kind: 'newsletterErrors',
        manifestIndex: 0,
        row: {
            id: 'error-row',
            toEmail: 'recipient@example.test',
            error: '',
            created: '2026-08-27T10:02:00.000Z',
            newsletterBatchId: 'batch-row',
            messageId: 'message-id',
            formatedContents: '',
            recipientData: '',
        },
    },
    {
        kind: 'newsletterNotifications',
        manifestIndex: 0,
        row: {
            id: 'notification-row',
            type: 'Delivery',
            notificationId: 'notification-id',
            messageId: 'message-id',
            rawEvent: '',
            timestamp: '2026-08-27T10:03:00.000Z',
            created: '2026-08-27T10:04:00.000Z',
        },
    },
]

async function* records(values: NewsletterRetentionEscrowRecord[]): AsyncGenerator<NewsletterRetentionEscrowRecord> {
    for (const value of values) {
        yield value
    }
}

function decodeChunks(chunks: Uint8Array[]): string[] {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    return chunks.map((chunk) => decoder.decode(chunk))
}

describe('service/newsletter-retention-escrow-writer', () => {
    it('writes canonical backpressured JSONL and returns only the verified public commitment', async () => {
        const chunks: Uint8Array[] = []
        const writeChunk = vi.fn().mockImplementation(async (chunk: Uint8Array) => {
            chunks.push(chunk.slice())
        })

        const result = await writeNewsletterRetentionEscrow({
            header: HEADER,
            records: records(RECORDS),
            writeChunk,
        })

        const headerLine = serializeNewsletterRetentionEscrowHeader(HEADER)
        const recordLines = RECORDS.map(serializeNewsletterRetentionEscrowRecord)
        const contentHash = createHash('sha256')
            .update(`${[headerLine, ...recordLines].join('\n')}\n`, 'utf8')
            .digest('hex')
        const footerLine = serializeNewsletterRetentionEscrowFooter({
            kind: 'footer',
            counts: { batches: 1, messages: 1, errors: 1, notifications: 1 },
            contentHash,
        })

        expect(writeChunk).toHaveBeenCalledTimes(6)
        expect(decodeChunks(chunks)).toEqual([
            `${headerLine}\n`,
            ...recordLines.map((line) => `${line}\n`),
            `${footerLine}\n`,
        ])
        expect(result).toEqual({
            version: 1,
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            policyVersion: 1,
            publicManifestHash: 'a'.repeat(64),
            schemaFingerprint: 'b'.repeat(64),
            contentHash,
            counts: { batches: 1, messages: 1, errors: 1, notifications: 1 },
        })
        expect(result).not.toHaveProperty('rows')
        expect(result).not.toHaveProperty('records')

        const independentVerifier = createNewsletterRetentionEscrowAccumulator()
        let independentlyVerified
        for (const chunk of decodeChunks(chunks)) {
            independentlyVerified = independentVerifier.consume(chunk.slice(0, -1)) ?? independentlyVerified
        }
        expect(independentVerifier.finalize()).toEqual(result)
        expect(independentlyVerified).toEqual(result)
    })

    it('writes a verifiable header/footer-only stream for an empty candidate set', async () => {
        const chunks: Uint8Array[] = []

        const result = await writeNewsletterRetentionEscrow({
            header: HEADER,
            records: records([]),
            writeChunk: (chunk) => {
                chunks.push(chunk.slice())
            },
        })

        const lines = decodeChunks(chunks)
        expect(lines).toHaveLength(2)
        expect(lines.every((line) => line.endsWith('\n'))).toBe(true)
        expect(result.counts).toEqual({ batches: 0, messages: 0, errors: 0, notifications: 0 })

        const verifier = createNewsletterRetentionEscrowAccumulator()
        for (const line of lines) {
            verifier.consume(line.slice(0, -1))
        }
        expect(verifier.finalize()).toEqual(result)
    })

    it('rejects an invalid record before its chunk reaches the sink and never emits a footer', async () => {
        const chunks: Uint8Array[] = []
        const invalid: NewsletterRetentionEscrowRecord = {
            kind: 'newsletterErrors',
            manifestIndex: 0,
            row: {
                id: 'error-row',
                toEmail: 'secret@example.test',
                error: 'secret payload',
                created: '2026-08-27T10:00:00.000Z',
                newsletterBatchId: 'batch-row',
                messageId: 'message-id',
                formatedContents: 'secret contents',
                recipientData: null,
            },
        }

        await expect(writeNewsletterRetentionEscrow({
            header: HEADER,
            records: records([invalid]),
            writeChunk: (chunk) => {
                chunks.push(chunk.slice())
            },
        })).rejects.toThrow('manifestIndex must contain a parent row first')

        expect(decodeChunks(chunks)).toEqual([`${serializeNewsletterRetentionEscrowHeader(HEADER)}\n`])
    })

    it('sanitizes sink failures and stops without attempting later chunks', async () => {
        const chunks: Uint8Array[] = []
        const secret = 'private-output-path-secret'
        let calls = 0

        let thrown: unknown
        try {
            await writeNewsletterRetentionEscrow({
                header: HEADER,
                records: records(RECORDS),
                writeChunk: (chunk) => {
                    calls += 1
                    if (calls === 2) {
                        throw new Error(secret)
                    }
                    chunks.push(chunk.slice())
                },
            })
        } catch (error) {
            thrown = error
        }

        expect(thrown).toBeInstanceOf(Error)
        expect((thrown as Error).message).toBe('escrow sink write failed')
        expect((thrown as Error).message).not.toContain(secret)
        expect(calls).toBe(2)
        expect(chunks).toHaveLength(1)
    })

    it('rejects malformed or extensible writer inputs before invoking the sink', async () => {
        const writeChunk = vi.fn()
        const valid = {
            header: HEADER,
            records: records([]),
            writeChunk,
        }

        await expect(writeNewsletterRetentionEscrow({ ...valid, recordLimit: 999_999 } as never)).rejects.toThrow(
            'escrow writer input must have exact keys',
        )
        await expect(writeNewsletterRetentionEscrow({ ...valid, records: [] } as never)).rejects.toThrow(
            'escrow records must be an async iterable',
        )
        await expect(writeNewsletterRetentionEscrow({ ...valid, writeChunk: 'not-a-function' } as never)).rejects.toThrow(
            'escrow writeChunk must be a function',
        )
        expect(writeChunk).not.toHaveBeenCalled()
    })
})
