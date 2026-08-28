import { createHash } from 'node:crypto'

import {
    createNewsletterRetentionEscrowAccumulator,
    serializeNewsletterRetentionEscrowFooter,
    serializeNewsletterRetentionEscrowHeader,
    serializeNewsletterRetentionEscrowRecord,
    type NewsletterRetentionEscrowCounts,
    type NewsletterRetentionEscrowFooter,
    type NewsletterRetentionEscrowHeader,
    type NewsletterRetentionEscrowRecord,
    type NewsletterRetentionEscrowVerificationResult,
} from './newsletter-retention-escrow.js'

const INPUT_KEYS = ['header', 'records', 'writeChunk'] as const
const UTF_8_ENCODER = new TextEncoder()

export interface NewsletterRetentionEscrowWriterInput {
    header: NewsletterRetentionEscrowHeader
    records: AsyncIterable<NewsletterRetentionEscrowRecord>
    writeChunk(chunk: Uint8Array): void | Promise<void>
}

export async function writeNewsletterRetentionEscrow(
    input: NewsletterRetentionEscrowWriterInput,
): Promise<NewsletterRetentionEscrowVerificationResult> {
    assertWriterInput(input)

    const accumulator = createNewsletterRetentionEscrowAccumulator()
    const contentHash = createHash('sha256')
    const counts: NewsletterRetentionEscrowCounts = {
        batches: 0,
        messages: 0,
        errors: 0,
        notifications: 0,
    }

    const headerLine = serializeNewsletterRetentionEscrowHeader(input.header)
    accumulator.consume(headerLine)
    contentHash.update(`${headerLine}\n`, 'utf8')
    await writeCanonicalLine(input.writeChunk, headerLine)

    for await (const record of input.records) {
        const recordLine = serializeNewsletterRetentionEscrowRecord(record)
        accumulator.consume(recordLine)
        incrementCount(counts, record.kind)
        contentHash.update(`${recordLine}\n`, 'utf8')
        await writeCanonicalLine(input.writeChunk, recordLine)
    }

    const footer: NewsletterRetentionEscrowFooter = {
        kind: 'footer',
        counts: { ...counts },
        contentHash: contentHash.digest('hex'),
    }
    const footerLine = serializeNewsletterRetentionEscrowFooter(footer)
    const result = accumulator.consume(footerLine)
    if (!result) {
        throw new Error('escrow footer verification failed')
    }

    await writeCanonicalLine(input.writeChunk, footerLine)
    return accumulator.finalize()
}

function assertWriterInput(value: unknown): asserts value is NewsletterRetentionEscrowWriterInput {
    if (!isPlainObject(value)) {
        throw new Error('escrow writer input must be a plain object with exact keys')
    }

    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== INPUT_KEYS.length || ownKeys.some((key) => typeof key !== 'string')) {
        throw new Error('escrow writer input must have exact keys')
    }
    for (const key of INPUT_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            throw new Error('escrow writer input must have exact keys')
        }
    }

    if (typeof value.writeChunk !== 'function') {
        throw new Error('escrow writeChunk must be a function')
    }
    if (!value.records || typeof value.records !== 'object') {
        throw new Error('escrow records must be an async iterable')
    }

    const asyncIterator = (value.records as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]
    if (typeof asyncIterator !== 'function') {
        throw new Error('escrow records must be an async iterable')
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false
    }

    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

async function writeCanonicalLine(
    writeChunk: NewsletterRetentionEscrowWriterInput['writeChunk'],
    line: string,
): Promise<void> {
    const chunk = UTF_8_ENCODER.encode(`${line}\n`)
    try {
        await writeChunk(chunk)
    } catch {
        throw new Error('escrow sink write failed')
    }
}

function incrementCount(counts: NewsletterRetentionEscrowCounts, kind: NewsletterRetentionEscrowRecord['kind']): void {
    if (kind === 'newsletterBatch') {
        counts.batches = addSafeInteger(counts.batches, 'batch count overflow')
        return
    }
    if (kind === 'newsletterMessages') {
        counts.messages = addSafeInteger(counts.messages, 'message count overflow')
        return
    }
    if (kind === 'newsletterErrors') {
        counts.errors = addSafeInteger(counts.errors, 'error count overflow')
        return
    }
    counts.notifications = addSafeInteger(counts.notifications, 'notification count overflow')
}

function addSafeInteger(value: number, message: string): number {
    if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
        throw new Error(message)
    }
    return value + 1
}
