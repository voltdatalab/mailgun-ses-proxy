import { createHash } from 'node:crypto'

export const NEWSLETTER_RETENTION_ESCROW_VERSION = 1 as const
export const NEWSLETTER_RETENTION_ESCROW_MAX_LINE_BYTES = 16_777_216 as const
export const NEWSLETTER_RETENTION_ESCROW_MAX_TOTAL_BYTES = 536_870_912 as const
export const NEWSLETTER_RETENTION_ESCROW_MAX_RECORDS = 250_000 as const
export const NEWSLETTER_RETENTION_ESCROW_MAX_BATCHES = 100 as const
export const NEWSLETTER_RETENTION_ESCROW_MAX_MESSAGES = 100_000 as const

const UTF_8_DECODER = new TextDecoder('utf-8', { fatal: true })
const JSON_WHITESPACE = /[\u0009\u000a\u000d\u0020]/
const STRICT_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const LOWERCASE_HEX_64 = /^[a-f0-9]{64}$/

const HEADER_KEYS = ['kind', 'version', 'siteId', 'cutoff', 'policyVersion', 'publicManifestHash', 'schemaFingerprint'] as const
const FOOTER_KEYS = ['kind', 'counts', 'contentHash'] as const
const VERIFICATION_RESULT_KEYS = [
    'version',
    'siteId',
    'cutoff',
    'policyVersion',
    'publicManifestHash',
    'schemaFingerprint',
    'contentHash',
    'counts',
] as const
const COUNT_KEYS = ['batches', 'messages', 'errors', 'notifications'] as const
const BATCH_ROW_KEYS = ['id', 'siteId', 'fromEmail', 'contents', 'batchId', 'created'] as const
const MESSAGE_ROW_KEYS = ['id', 'messageId', 'toEmail', 'newsletterBatchId', 'created', 'formatedContents', 'recipientData'] as const
const ERROR_ROW_KEYS = ['id', 'toEmail', 'error', 'created', 'newsletterBatchId', 'messageId', 'formatedContents', 'recipientData'] as const
const NOTIFICATION_ROW_KEYS = ['id', 'type', 'notificationId', 'messageId', 'rawEvent', 'timestamp', 'created'] as const

export interface NewsletterRetentionEscrowHeader {
    kind: 'header'
    version: typeof NEWSLETTER_RETENTION_ESCROW_VERSION
    siteId: string
    cutoff: string
    policyVersion: number
    publicManifestHash: string
    schemaFingerprint: string
}

export interface NewsletterRetentionEscrowBatchRow {
    id: string
    siteId: string
    fromEmail: string
    contents: string
    batchId: string
    created: string
}

export interface NewsletterRetentionEscrowMessageRow {
    id: string
    messageId: string
    toEmail: string
    newsletterBatchId: string
    created: string
    formatedContents: string
    recipientData: string | null
}

export interface NewsletterRetentionEscrowErrorRow {
    id: string
    toEmail: string
    error: string
    created: string
    newsletterBatchId: string
    messageId: string
    formatedContents: string
    recipientData: string | null
}

export interface NewsletterRetentionEscrowNotificationRow {
    id: string
    type: string
    notificationId: string
    messageId: string
    rawEvent: string
    timestamp: string
    created: string
}

export interface NewsletterRetentionEscrowRecordBase {
    kind: 'newsletterBatch' | 'newsletterMessages' | 'newsletterErrors' | 'newsletterNotifications'
    manifestIndex: number
}

export interface NewsletterRetentionEscrowBatchRecord extends NewsletterRetentionEscrowRecordBase {
    kind: 'newsletterBatch'
    row: NewsletterRetentionEscrowBatchRow
}

export interface NewsletterRetentionEscrowMessageRecord extends NewsletterRetentionEscrowRecordBase {
    kind: 'newsletterMessages'
    row: NewsletterRetentionEscrowMessageRow
}

export interface NewsletterRetentionEscrowErrorRecord extends NewsletterRetentionEscrowRecordBase {
    kind: 'newsletterErrors'
    row: NewsletterRetentionEscrowErrorRow
}

export interface NewsletterRetentionEscrowNotificationRecord extends NewsletterRetentionEscrowRecordBase {
    kind: 'newsletterNotifications'
    row: NewsletterRetentionEscrowNotificationRow
}

export type NewsletterRetentionEscrowRecord =
    | NewsletterRetentionEscrowBatchRecord
    | NewsletterRetentionEscrowMessageRecord
    | NewsletterRetentionEscrowErrorRecord
    | NewsletterRetentionEscrowNotificationRecord

export interface NewsletterRetentionEscrowCounts {
    batches: number
    messages: number
    errors: number
    notifications: number
}

export interface NewsletterRetentionEscrowFooter {
    kind: 'footer'
    counts: NewsletterRetentionEscrowCounts
    contentHash: string
}

export interface NewsletterRetentionEscrowVerificationResult {
    version: typeof NEWSLETTER_RETENTION_ESCROW_VERSION
    siteId: string
    cutoff: string
    policyVersion: number
    publicManifestHash: string
    schemaFingerprint: string
    contentHash: string
    counts: NewsletterRetentionEscrowCounts
}

export interface NewsletterRetentionEscrowAccumulatorOptions {
    lineBytesLimit?: number
    totalBytesLimit?: number
    recordLimit?: number
    batchLimit?: number
    messageLimit?: number
}

export interface NewsletterRetentionEscrowAccumulator {
    consume(line: string | Uint8Array): NewsletterRetentionEscrowVerificationResult | undefined
    finalize(): NewsletterRetentionEscrowVerificationResult
}

export interface NewsletterRetentionEscrowSerializer {
    header(header: NewsletterRetentionEscrowHeader): string
    record(record: NewsletterRetentionEscrowRecord): string
    footer(footer: NewsletterRetentionEscrowFooter): string
}

export function createNewsletterRetentionEscrowSerializer(): NewsletterRetentionEscrowSerializer {
    return {
        header: serializeNewsletterRetentionEscrowHeader,
        record: serializeNewsletterRetentionEscrowRecord,
        footer: serializeNewsletterRetentionEscrowFooter,
    }
}

export function serializeNewsletterRetentionEscrowHeader(header: NewsletterRetentionEscrowHeader): string {
    const normalized = normalizeEscrowHeader(header)
    return joinCanonicalObject([
        ['kind', stringifyString('header')],
        ['version', stringifyNumber(normalized.version)],
        ['siteId', stringifyString(normalized.siteId)],
        ['cutoff', stringifyString(normalized.cutoff)],
        ['policyVersion', stringifyNumber(normalized.policyVersion)],
        ['publicManifestHash', stringifyString(normalized.publicManifestHash)],
        ['schemaFingerprint', stringifyString(normalized.schemaFingerprint)],
    ])
}

export function serializeNewsletterRetentionEscrowRecord(record: NewsletterRetentionEscrowRecord): string {
    const normalized = normalizeEscrowRecord(record)
    return joinCanonicalObject([
        ['kind', stringifyString(normalized.kind)],
        ['manifestIndex', stringifyNumber(normalized.manifestIndex)],
        ['row', serializeRecordRow(normalized)],
    ])
}

export function serializeNewsletterRetentionEscrowFooter(footer: NewsletterRetentionEscrowFooter): string {
    const normalized = normalizeEscrowFooter(footer)
    return joinCanonicalObject([
        ['kind', stringifyString('footer')],
        ['counts', joinCanonicalObject([
            ['batches', stringifyNumber(normalized.counts.batches)],
            ['messages', stringifyNumber(normalized.counts.messages)],
            ['errors', stringifyNumber(normalized.counts.errors)],
            ['notifications', stringifyNumber(normalized.counts.notifications)],
        ])],
        ['contentHash', stringifyString(normalized.contentHash)],
    ])
}

export function parseNewsletterRetentionEscrowRecord(value: unknown): NewsletterRetentionEscrowRecord {
    return normalizeEscrowRecord(value)
}

export function parseNewsletterRetentionEscrowVerificationResult(
    value: unknown,
): NewsletterRetentionEscrowVerificationResult {
    expectPlainObjectWithExactKeys(value, VERIFICATION_RESULT_KEYS, 'escrow verification result')
    const candidate = value as Record<string, unknown>
    const header = normalizeEscrowHeader({
        kind: 'header',
        version: candidate.version,
        siteId: candidate.siteId,
        cutoff: candidate.cutoff,
        policyVersion: candidate.policyVersion,
        publicManifestHash: candidate.publicManifestHash,
        schemaFingerprint: candidate.schemaFingerprint,
    })
    const footer = normalizeEscrowFooter({
        kind: 'footer',
        counts: candidate.counts,
        contentHash: candidate.contentHash,
    })

    return {
        version: header.version,
        siteId: header.siteId,
        cutoff: header.cutoff,
        policyVersion: header.policyVersion,
        publicManifestHash: header.publicManifestHash,
        schemaFingerprint: header.schemaFingerprint,
        contentHash: footer.contentHash,
        counts: { ...footer.counts },
    }
}

export function createNewsletterRetentionEscrowAccumulator(options: NewsletterRetentionEscrowAccumulatorOptions = {}): NewsletterRetentionEscrowAccumulator {
    return new NewsletterRetentionEscrowAccumulatorState(options)
}

class NewsletterRetentionEscrowAccumulatorState implements NewsletterRetentionEscrowAccumulator {
    private readonly lineBytesLimit: number
    private readonly totalBytesLimit: number
    private readonly recordLimit: number
    private readonly batchLimit: number
    private readonly messageLimit: number
    private readonly hash = createHash('sha256')
    private totalBytes = 0
    private totalRecords = 0
    private seenFooter = false
    private failed = false
    private resolved: NewsletterRetentionEscrowVerificationResult | undefined
    private header: NewsletterRetentionEscrowHeader | undefined
    private counts: NewsletterRetentionEscrowCounts = { batches: 0, messages: 0, errors: 0, notifications: 0 }
    private manifestIndex = -1
    private phase: EscrowPhase = 'await-header'
    private lastIdsByKind = new Map<NewsletterRetentionEscrowRecord['kind'], string>()
    private seenRowIdsByKind = new Map<NewsletterRetentionEscrowRecord['kind'], Set<string>>()
    private seenMessageIds = new Set<string>()
    private seenErrorMessageIds = new Set<string>()
    private seenNotificationIds = new Set<string>()
    private currentBatchId: string | undefined
    private currentMessageIds = new Set<string>()

    public constructor(options: NewsletterRetentionEscrowAccumulatorOptions) {
        this.lineBytesLimit = normalizeLimit(options.lineBytesLimit, NEWSLETTER_RETENTION_ESCROW_MAX_LINE_BYTES, 'lineBytesLimit')
        this.totalBytesLimit = normalizeLimit(options.totalBytesLimit, NEWSLETTER_RETENTION_ESCROW_MAX_TOTAL_BYTES, 'totalBytesLimit')
        this.recordLimit = normalizeLimit(options.recordLimit, NEWSLETTER_RETENTION_ESCROW_MAX_RECORDS, 'recordLimit')
        this.batchLimit = normalizeLimit(options.batchLimit, NEWSLETTER_RETENTION_ESCROW_MAX_BATCHES, 'batchLimit')
        this.messageLimit = normalizeLimit(options.messageLimit, NEWSLETTER_RETENTION_ESCROW_MAX_MESSAGES, 'messageLimit')
    }

    public consume(line: string | Uint8Array): NewsletterRetentionEscrowVerificationResult | undefined {
        if (this.failed) {
            throw new Error('escrow accumulator is failed')
        }

        try {
            return this.consumeLine(line)
        } catch (error) {
            this.failed = true
            throw error
        }
    }

    private consumeLine(line: string | Uint8Array): NewsletterRetentionEscrowVerificationResult | undefined {
        if (this.seenFooter) {
            throw new Error('records after footer are not allowed')
        }

        const { text, byteLength } = normalizeRawLine(line)
        if (byteLength > this.lineBytesLimit) {
            throw new Error('escrow line exceeds byte limit')
        }

        this.totalBytes = addSafeInteger(this.totalBytes, byteLength + 1, this.totalBytesLimit, 'escrow byte budget exceeded')

        const parsed = parseEscrowLine(text)
        if (isHeaderLine(parsed)) {
            const canonical = serializeNewsletterRetentionEscrowHeader(parsed)
            if (text !== canonical) {
                throw new Error('escrow line must use canonical encoding')
            }
            this.consumeHeader(parsed)
            this.updateHash(canonical)
            return undefined
        }

        if (isFooterLine(parsed)) {
            const canonical = serializeNewsletterRetentionEscrowFooter(parsed)
            if (text !== canonical) {
                throw new Error('escrow line must use canonical encoding')
            }
            const result = this.consumeFooter(parsed)
            this.seenFooter = true
            this.resolved = result
            return result
        }

        this.totalRecords = addSafeInteger(this.totalRecords, 1, this.recordLimit, 'escrow record limit exceeded')
        const canonical = serializeNewsletterRetentionEscrowRecord(parsed)
        if (text !== canonical) {
            throw new Error('escrow line must use canonical encoding')
        }
        this.consumeRecord(parsed)
        this.updateHash(canonical)
        return undefined
    }

    public finalize(): NewsletterRetentionEscrowVerificationResult {
        if (this.resolved) {
            return this.resolved
        }

        if (!this.seenFooter) {
            throw new Error('escrow footer is required')
        }

        throw new Error('escrow footer is required')
    }

    private consumeHeader(header: NewsletterRetentionEscrowHeader): void {
        if (this.header) {
            throw new Error('header must appear exactly once')
        }

        this.header = header
        this.phase = 'parent'
    }

    private consumeRecord(record: NewsletterRetentionEscrowRecord): void {
        if (!this.header) {
            throw new Error('header must appear before records')
        }

        if (this.manifestIndex === -1) {
            if (record.manifestIndex !== 0) {
                throw new Error('manifestIndex must be sequential starting at 0')
            }
            if (record.kind !== 'newsletterBatch') {
                throw new Error('manifestIndex must contain a parent row first')
            }
            this.startManifest(record.manifestIndex)
        } else if (record.manifestIndex === this.manifestIndex + 1) {
            if (record.kind !== 'newsletterBatch') {
                throw new Error('manifestIndex must be sequential starting at 0')
            }
            this.startManifest(record.manifestIndex)
        } else if (record.manifestIndex !== this.manifestIndex) {
            throw new Error('manifestIndex must be sequential starting at 0')
        }

        if (record.kind === 'newsletterBatch') {
            this.consumeBatchRecord(record)
            return
        }

        if (record.kind === 'newsletterMessages') {
            this.consumeMessageRecord(record)
            return
        }

        if (record.kind === 'newsletterErrors') {
            this.consumeErrorRecord(record)
            return
        }

        this.consumeNotificationRecord(record)
    }

    private startManifest(manifestIndex: number): void {
        this.manifestIndex = manifestIndex
        this.phase = 'parent'
        this.lastIdsByKind = new Map()
        this.currentMessageIds = new Set()
        this.currentBatchId = undefined
    }

    private consumeBatchRecord(record: NewsletterRetentionEscrowBatchRecord): void {
        if (this.phase !== 'parent') {
            throw new Error('manifestIndex must contain a parent row first')
        }

        this.ensureCurrentManifestIndex(record.manifestIndex)
        this.assertKindOrder('newsletterBatch')
        this.assertAscendingId('newsletterBatch', record.row.id)
        this.assertUniqueRowId(record.kind, record.row.id)
        if (record.row.siteId !== this.header?.siteId) {
            throw new Error('batch siteId must match escrow siteId')
        }
        this.currentBatchId = record.row.id
        this.phase = 'messages'
        this.counts.batches = addSafeInteger(this.counts.batches, 1, this.batchLimit, 'batch limit exceeded')
    }

    private consumeMessageRecord(record: NewsletterRetentionEscrowMessageRecord): void {
        this.ensureBatchExists('newsletterMessages')
        this.ensureCurrentManifestIndex(record.manifestIndex)
        this.assertKindOrder('newsletterMessages')
        this.assertAscendingId('newsletterMessages', record.row.id)
        if (record.row.newsletterBatchId !== this.currentBatchId) {
            throw new Error('newsletterBatchId must match the current parent row')
        }
        this.assertUniqueRowId(record.kind, record.row.id)
        this.assertUniqueMessageId(record.row.messageId)
        this.currentMessageIds.add(record.row.messageId)
        this.phase = 'messages'
        this.counts.messages = addSafeInteger(this.counts.messages, 1, this.messageLimit, 'message limit exceeded')
    }

    private consumeErrorRecord(record: NewsletterRetentionEscrowErrorRecord): void {
        this.ensureBatchExists('newsletterErrors')
        this.ensureCurrentManifestIndex(record.manifestIndex)
        this.assertKindOrder('newsletterErrors')
        this.assertAscendingId('newsletterErrors', record.row.id)
        if (record.row.newsletterBatchId !== this.currentBatchId) {
            throw new Error('newsletterBatchId must match the current parent row')
        }
        this.assertUniqueRowId(record.kind, record.row.id)
        this.assertUniqueErrorMessageId(record.row.messageId)
        this.phase = 'errors'
        this.counts.errors = addSafeInteger(this.counts.errors, 1, Number.MAX_SAFE_INTEGER, 'escrow count overflow')
    }

    private consumeNotificationRecord(record: NewsletterRetentionEscrowNotificationRecord): void {
        this.ensureBatchExists('newsletterNotifications')
        this.ensureCurrentManifestIndex(record.manifestIndex)
        this.assertKindOrder('newsletterNotifications')
        this.assertAscendingId('newsletterNotifications', record.row.id)
        if (!this.currentMessageIds.has(record.row.messageId)) {
            throw new Error('notification.messageId must reference a message row')
        }
        this.assertUniqueRowId(record.kind, record.row.id)
        this.assertUniqueNotificationId(record.row.notificationId)
        this.phase = 'notifications'
        this.counts.notifications = addSafeInteger(this.counts.notifications, 1, Number.MAX_SAFE_INTEGER, 'escrow count overflow')
    }

    private consumeFooter(footer: NewsletterRetentionEscrowFooter): NewsletterRetentionEscrowVerificationResult {
        if (!this.header) {
            throw new Error('header must appear before footer')
        }

        // A header/footer-only stream is a valid dry-run result when selection found no candidates.
        // Apply admission may reject a no-op independently; this logical contract must still be able
        // to represent and verify the exact empty candidate set.
        const expectedCounts = this.counts
        if (
            footer.counts.batches !== expectedCounts.batches
            || footer.counts.messages !== expectedCounts.messages
            || footer.counts.errors !== expectedCounts.errors
            || footer.counts.notifications !== expectedCounts.notifications
        ) {
            throw new Error('footer counts must match observed counts')
        }

        const computedContentHash = this.hash.digest('hex')
        if (footer.contentHash !== computedContentHash) {
            throw new Error('footer contentHash must match observed content')
        }

        return {
            version: this.header.version,
            siteId: this.header.siteId,
            cutoff: this.header.cutoff,
            policyVersion: this.header.policyVersion,
            publicManifestHash: this.header.publicManifestHash,
            schemaFingerprint: this.header.schemaFingerprint,
            contentHash: computedContentHash,
            counts: { ...expectedCounts },
        }
    }

    private ensureCurrentManifestIndex(manifestIndex: number): void {
        if (manifestIndex !== this.manifestIndex) {
            throw new Error('manifestIndex must be sequential starting at 0')
        }
    }

    private ensureBatchExists(kind: NewsletterRetentionEscrowRecord['kind']): void {
        if (!this.currentBatchId) {
            throw new Error(`${kind} must follow a parent row`)
        }
    }

    private assertKindOrder(kind: NewsletterRetentionEscrowRecord['kind']): void {
        const ranks: Record<NewsletterRetentionEscrowRecord['kind'], number> = {
            newsletterBatch: 0,
            newsletterMessages: 1,
            newsletterErrors: 2,
            newsletterNotifications: 3,
        }
        const currentRank = ranks[kind]
        const phaseRank = this.phaseRank()
        if (currentRank < phaseRank) {
            throw new Error('record order must be parent, messages, errors, notifications')
        }
    }

    private phaseRank(): number {
        if (this.phase === 'parent') return 0
        if (this.phase === 'messages') return 1
        if (this.phase === 'errors') return 2
        if (this.phase === 'notifications') return 3
        return 4
    }

    private assertAscendingId(kind: NewsletterRetentionEscrowRecord['kind'], id: string): void {
        const previous = this.lastIdsByKind.get(kind)
        if (previous !== undefined && previous >= id) {
            throw new Error('record ids must be sorted by kind')
        }
        this.lastIdsByKind.set(kind, id)
    }

    private assertUniqueRowId(kind: NewsletterRetentionEscrowRecord['kind'], id: string): void {
        const seen = this.seenRowIdsByKind.get(kind) ?? new Set<string>()
        if (seen.has(id)) {
            throw new Error('row id must be unique within its model')
        }
        seen.add(id)
        this.seenRowIdsByKind.set(kind, seen)
    }

    private assertUniqueMessageId(messageId: string): void {
        if (this.seenMessageIds.has(messageId)) {
            throw new Error('messageId must be unique within newsletterMessages')
        }
        this.seenMessageIds.add(messageId)
    }

    private assertUniqueErrorMessageId(messageId: string): void {
        if (this.seenErrorMessageIds.has(messageId)) {
            throw new Error('messageId must be unique within newsletterErrors')
        }
        this.seenErrorMessageIds.add(messageId)
    }

    private assertUniqueNotificationId(notificationId: string): void {
        if (this.seenNotificationIds.has(notificationId)) {
            throw new Error('notificationId must be unique')
        }
        this.seenNotificationIds.add(notificationId)
    }

    private updateHash(serialized: string): void {
        this.hash.update(serialized)
        this.hash.update('\n')
    }
}

type EscrowPhase = 'await-header' | 'parent' | 'messages' | 'errors' | 'notifications' | 'footer-ready'

function parseEscrowLine(text: string): NewsletterRetentionEscrowHeader | NewsletterRetentionEscrowRecord | NewsletterRetentionEscrowFooter {
    if (text.length === 0) {
        throw new Error('escrow line must be valid JSON')
    }

    ensureUniqueJsonKeys(text)
    let parsed: unknown
    try {
        parsed = JSON.parse(text) as unknown
    } catch {
        throw new Error('escrow line must be valid JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('escrow line must be a plain object')
    }

    const kind = (parsed as { kind?: unknown }).kind
    if (kind === 'header') {
        return normalizeEscrowHeader(parsed)
    }

    if (kind === 'footer') {
        return normalizeEscrowFooter(parsed)
    }

    return normalizeEscrowRecord(parsed)
}

function ensureUniqueJsonKeys(text: string): void {
    const scanner = new JsonDuplicateKeyScanner(text)
    scanner.scan()
}

class JsonDuplicateKeyScanner {
    private index = 0

    public constructor(private readonly text: string) {}

    public scan(): void {
        this.skipWhitespace()
        this.parseValue()
        this.skipWhitespace()
        if (this.index !== this.text.length) {
            throw new Error('escrow line must be valid JSON')
        }
    }

    private parseValue(): void {
        this.skipWhitespace()
        const char = this.current()
        if (char === '{') {
            this.parseObject()
            return
        }
        if (char === '[') {
            this.parseArray()
            return
        }
        if (char === '"') {
            this.parseString()
            return
        }
        if (char === 't') {
            this.parseLiteral('true')
            return
        }
        if (char === 'f') {
            this.parseLiteral('false')
            return
        }
        if (char === 'n') {
            this.parseLiteral('null')
            return
        }
        if (char === '-' || this.isDigit(char)) {
            this.parseNumber()
            return
        }
        throw new Error('escrow line must be valid JSON')
    }

    private parseObject(): void {
        this.expect('{')
        this.skipWhitespace()
        if (this.current() === '}') {
            this.index += 1
            return
        }

        const keys = new Set<string>()
        while (true) {
            this.skipWhitespace()
            const key = this.parseString()
            if (keys.has(key)) {
                throw new Error('escrow line must contain unique JSON keys')
            }
            keys.add(key)
            this.skipWhitespace()
            this.expect(':')
            this.parseValue()
            this.skipWhitespace()
            const char = this.current()
            if (char === ',') {
                this.index += 1
                continue
            }
            if (char === '}') {
                this.index += 1
                return
            }
            throw new Error('escrow line must be valid JSON')
        }
    }

    private parseArray(): void {
        this.expect('[')
        this.skipWhitespace()
        if (this.current() === ']') {
            this.index += 1
            return
        }

        while (true) {
            this.parseValue()
            this.skipWhitespace()
            const char = this.current()
            if (char === ',') {
                this.index += 1
                continue
            }
            if (char === ']') {
                this.index += 1
                return
            }
            throw new Error('escrow line must be valid JSON')
        }
    }

    private parseString(): string {
        this.expect('"')
        let value = ''
        while (this.index < this.text.length) {
            const char = this.text[this.index]
            if (char === '"') {
                this.index += 1
                return value
            }
            if (char === '\\') {
                this.index += 1
                if (this.index >= this.text.length) {
                    throw new Error('escrow line must be valid JSON')
                }
                const escaped = this.text[this.index]
                if (escaped === '"' || escaped === '\\' || escaped === '/') {
                    value += escaped
                    this.index += 1
                    continue
                }
                if (escaped === 'b') { value += '\b'; this.index += 1; continue }
                if (escaped === 'f') { value += '\f'; this.index += 1; continue }
                if (escaped === 'n') { value += '\n'; this.index += 1; continue }
                if (escaped === 'r') { value += '\r'; this.index += 1; continue }
                if (escaped === 't') { value += '\t'; this.index += 1; continue }
                if (escaped === 'u') {
                    const hex = this.text.slice(this.index + 1, this.index + 5)
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                        throw new Error('escrow line must be valid JSON')
                    }
                    value += String.fromCharCode(Number.parseInt(hex, 16))
                    this.index += 5
                    continue
                }
                throw new Error('escrow line must be valid JSON')
            }
            if (char < ' ')
                throw new Error('escrow line must be valid JSON')
            value += char
            this.index += 1
        }

        throw new Error('escrow line must be valid JSON')
    }

    private parseNumber(): void {
        if (this.current() === '-') {
            this.index += 1
        }
        if (this.current() === '0') {
            this.index += 1
        } else {
            this.parseDigits()
        }
        if (this.current() === '.') {
            this.index += 1
            this.parseDigits()
        }
        if (this.current() === 'e' || this.current() === 'E') {
            this.index += 1
            if (this.current() === '+' || this.current() === '-') {
                this.index += 1
            }
            this.parseDigits()
        }
    }

    private parseDigits(): void {
        if (!this.isDigit(this.current())) {
            throw new Error('escrow line must be valid JSON')
        }
        while (this.isDigit(this.current())) {
            this.index += 1
        }
    }

    private parseLiteral(literal: 'true' | 'false' | 'null'): void {
        if (this.text.slice(this.index, this.index + literal.length) !== literal) {
            throw new Error('escrow line must be valid JSON')
        }
        this.index += literal.length
    }

    private skipWhitespace(): void {
        while (this.index < this.text.length && JSON_WHITESPACE.test(this.text[this.index])) {
            this.index += 1
        }
    }

    private expect(char: string): void {
        if (this.current() !== char) {
            throw new Error('escrow line must be valid JSON')
        }
        this.index += 1
    }

    private current(): string {
        return this.text[this.index] ?? ''
    }

    private isDigit(char: string): boolean {
        return char >= '0' && char <= '9'
    }
}

function normalizeRawLine(line: string | Uint8Array): { text: string, byteLength: number } {
    if (typeof line === 'string') {
        return { text: line, byteLength: Buffer.byteLength(line) }
    }

    if (!(line instanceof Uint8Array)) {
        throw new Error('escrow line must be a string or Uint8Array')
    }

    try {
        return { text: UTF_8_DECODER.decode(line), byteLength: line.byteLength }
    } catch {
        throw new Error('escrow line must be valid UTF-8')
    }
}

function normalizeEscrowHeader(value: unknown): NewsletterRetentionEscrowHeader {
    expectPlainObjectWithExactKeys(value, HEADER_KEYS, 'header')
    const header = value as Record<string, unknown>
    return {
        kind: 'header',
        version: normalizeVersion(header.version),
        siteId: normalizeStrictSiteId(header.siteId, 'siteId'),
        cutoff: normalizeUtcMillis(header.cutoff, 'cutoff'),
        policyVersion: normalizePositiveSafeInteger(header.policyVersion, 'policyVersion'),
        publicManifestHash: normalizeHash(header.publicManifestHash, 'publicManifestHash'),
        schemaFingerprint: normalizeHash(header.schemaFingerprint, 'schemaFingerprint'),
    }
}

function normalizeEscrowFooter(value: unknown): NewsletterRetentionEscrowFooter {
    expectPlainObjectWithExactKeys(value, FOOTER_KEYS, 'footer')
    const footer = value as Record<string, unknown>
    expectPlainObjectWithExactKeys(footer.counts, COUNT_KEYS, 'footer counts')
    const counts = footer.counts as Record<string, unknown>
    return {
        kind: 'footer',
        counts: {
            batches: normalizeNonNegativeSafeInteger(counts.batches, 'batches'),
            messages: normalizeNonNegativeSafeInteger(counts.messages, 'messages'),
            errors: normalizeNonNegativeSafeInteger(counts.errors, 'errors'),
            notifications: normalizeNonNegativeSafeInteger(counts.notifications, 'notifications'),
        },
        contentHash: normalizeHash(footer.contentHash, 'contentHash'),
    }
}

function normalizeEscrowRecord(value: unknown): NewsletterRetentionEscrowRecord {
    expectPlainObjectWithExactKeys(value, ['kind', 'manifestIndex', 'row'] as const, 'record')
    const record = value as Record<string, unknown>
    const kind = record.kind
    if (kind === 'newsletterBatch') {
        return {
            kind: 'newsletterBatch',
            manifestIndex: normalizeManifestIndex(record.manifestIndex),
            row: normalizeBatchRow(record.row),
        }
    }
    if (kind === 'newsletterMessages') {
        return {
            kind: 'newsletterMessages',
            manifestIndex: normalizeManifestIndex(record.manifestIndex),
            row: normalizeMessageRow(record.row),
        }
    }
    if (kind === 'newsletterErrors') {
        return {
            kind: 'newsletterErrors',
            manifestIndex: normalizeManifestIndex(record.manifestIndex),
            row: normalizeErrorRow(record.row),
        }
    }
    if (kind === 'newsletterNotifications') {
        return {
            kind: 'newsletterNotifications',
            manifestIndex: normalizeManifestIndex(record.manifestIndex),
            row: normalizeNotificationRow(record.row),
        }
    }

    throw new Error('record kind must be a known model')
}

function normalizeBatchRow(value: unknown): NewsletterRetentionEscrowBatchRow {
    expectPlainObjectWithExactKeys(value, BATCH_ROW_KEYS, 'record row')
    const row = value as Record<string, unknown>
    return {
        id: normalizeStrictIdentifier(row.id, 'id'),
        siteId: normalizeStrictSiteId(row.siteId, 'siteId'),
        fromEmail: normalizeStrictIdentifier(row.fromEmail, 'fromEmail'),
        contents: normalizeString(row.contents, 'contents'),
        batchId: normalizeStrictIdentifier(row.batchId, 'batchId'),
        created: normalizeUtcMillis(row.created, 'created'),
    }
}

function normalizeMessageRow(value: unknown): NewsletterRetentionEscrowMessageRow {
    expectPlainObjectWithExactKeys(value, MESSAGE_ROW_KEYS, 'record row')
    const row = value as Record<string, unknown>
    return {
        id: normalizeStrictIdentifier(row.id, 'id'),
        messageId: normalizeStrictIdentifier(row.messageId, 'messageId'),
        toEmail: normalizeStrictIdentifier(row.toEmail, 'toEmail'),
        newsletterBatchId: normalizeStrictIdentifier(row.newsletterBatchId, 'newsletterBatchId'),
        created: normalizeUtcMillis(row.created, 'created'),
        formatedContents: normalizeString(row.formatedContents, 'formatedContents'),
        recipientData: normalizeRecipientData(row.recipientData),
    }
}

function normalizeErrorRow(value: unknown): NewsletterRetentionEscrowErrorRow {
    expectPlainObjectWithExactKeys(value, ERROR_ROW_KEYS, 'record row')
    const row = value as Record<string, unknown>
    return {
        id: normalizeStrictIdentifier(row.id, 'id'),
        toEmail: normalizeStrictIdentifier(row.toEmail, 'toEmail'),
        error: normalizeString(row.error, 'error'),
        created: normalizeUtcMillis(row.created, 'created'),
        newsletterBatchId: normalizeStrictIdentifier(row.newsletterBatchId, 'newsletterBatchId'),
        messageId: normalizeStrictIdentifier(row.messageId, 'messageId'),
        formatedContents: normalizeString(row.formatedContents, 'formatedContents'),
        recipientData: normalizeRecipientData(row.recipientData),
    }
}

function normalizeNotificationRow(value: unknown): NewsletterRetentionEscrowNotificationRow {
    expectPlainObjectWithExactKeys(value, NOTIFICATION_ROW_KEYS, 'record row')
    const row = value as Record<string, unknown>
    return {
        id: normalizeStrictIdentifier(row.id, 'id'),
        type: normalizeStrictIdentifier(row.type, 'type'),
        notificationId: normalizeStrictIdentifier(row.notificationId, 'notificationId'),
        messageId: normalizeStrictIdentifier(row.messageId, 'messageId'),
        rawEvent: normalizeString(row.rawEvent, 'rawEvent'),
        timestamp: normalizeUtcMillis(row.timestamp, 'timestamp'),
        created: normalizeUtcMillis(row.created, 'created'),
    }
}

function serializeRecordRow(record: NewsletterRetentionEscrowRecord): string {
    if (record.kind === 'newsletterBatch') {
        return joinCanonicalObject([
            ['id', stringifyString(record.row.id)],
            ['siteId', stringifyString(record.row.siteId)],
            ['fromEmail', stringifyString(record.row.fromEmail)],
            ['contents', stringifyString(record.row.contents)],
            ['batchId', stringifyString(record.row.batchId)],
            ['created', stringifyString(record.row.created)],
        ])
    }

    if (record.kind === 'newsletterMessages') {
        return joinCanonicalObject([
            ['id', stringifyString(record.row.id)],
            ['messageId', stringifyString(record.row.messageId)],
            ['toEmail', stringifyString(record.row.toEmail)],
            ['newsletterBatchId', stringifyString(record.row.newsletterBatchId)],
            ['created', stringifyString(record.row.created)],
            ['formatedContents', stringifyString(record.row.formatedContents)],
            ['recipientData', record.row.recipientData === null ? 'null' : stringifyString(record.row.recipientData)],
        ])
    }

    if (record.kind === 'newsletterErrors') {
        return joinCanonicalObject([
            ['id', stringifyString(record.row.id)],
            ['toEmail', stringifyString(record.row.toEmail)],
            ['error', stringifyString(record.row.error)],
            ['created', stringifyString(record.row.created)],
            ['newsletterBatchId', stringifyString(record.row.newsletterBatchId)],
            ['messageId', stringifyString(record.row.messageId)],
            ['formatedContents', stringifyString(record.row.formatedContents)],
            ['recipientData', record.row.recipientData === null ? 'null' : stringifyString(record.row.recipientData)],
        ])
    }

    return joinCanonicalObject([
        ['id', stringifyString(record.row.id)],
        ['type', stringifyString(record.row.type)],
        ['notificationId', stringifyString(record.row.notificationId)],
        ['messageId', stringifyString(record.row.messageId)],
        ['rawEvent', stringifyString(record.row.rawEvent)],
        ['timestamp', stringifyString(record.row.timestamp)],
        ['created', stringifyString(record.row.created)],
    ])
}

function expectPlainObjectWithExactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
    if (!isPlainObject(value)) {
        throw new Error(`${label} must be a plain object with exact keys`)
    }

    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string')) {
        throw new Error(`${label} must have exact keys`)
    }

    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            throw new Error(`${label} must have exact keys`)
        }
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false
    }

    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function normalizeVersion(value: unknown): typeof NEWSLETTER_RETENTION_ESCROW_VERSION {
    if (value !== NEWSLETTER_RETENTION_ESCROW_VERSION) {
        throw new Error('version must equal 1')
    }
    return NEWSLETTER_RETENTION_ESCROW_VERSION
}

function normalizePositiveSafeInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${field} must be a positive safe integer`)
    }
    return value
}

function normalizeNonNegativeSafeInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative safe integer`)
    }
    return value
}

function normalizeManifestIndex(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error('manifestIndex must be a non-negative safe integer')
    }
    return value
}

function normalizeStrictSiteId(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new Error(`${field} must be a non-empty string`)
    }
    return value
}

function normalizeStrictIdentifier(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new Error(`${field} must be a non-empty string`)
    }
    return value
}

function normalizeString(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        throw new Error(`${field} must be a string`)
    }
    return value
}

function normalizeUtcMillis(value: unknown, field: string): string {
    if (typeof value !== 'string' || !STRICT_UTC_MILLIS.test(value)) {
        throw new Error(`${field} must be a canonical UTC millisecond string`)
    }

    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) {
        throw new Error(`${field} must be a canonical UTC millisecond string`)
    }

    if (new Date(timestamp).toISOString() !== value) {
        throw new Error(`${field} must be a canonical UTC millisecond string`)
    }

    return value
}

function normalizeHash(value: unknown, field: string): string {
    if (typeof value !== 'string' || !LOWERCASE_HEX_64.test(value)) {
        throw new Error(`${field} must be a lowercase 64-hex string`)
    }
    return value
}

function normalizeRecipientData(value: unknown): string | null {
    if (value === null) {
        return null
    }
    if (typeof value !== 'string') {
        throw new Error('recipientData must be a string or null')
    }
    return value
}

function normalizeEscrowLimit(value: number | undefined, fallback: number, field: string): number {
    if (value === undefined) {
        return fallback
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > fallback) {
        throw new Error(`${field} must be a positive safe integer within the hard limit`)
    }
    return value
}

function normalizeLimit(value: number | undefined, fallback: number, field: string): number {
    return normalizeEscrowLimit(value, fallback, field)
}

function addSafeInteger(current: number, increment: number, limit: number, limitMessage: string): number {
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(increment) || !Number.isSafeInteger(limit)) {
        throw new Error(limitMessage)
    }
    const next = current + increment
    if (!Number.isSafeInteger(next) || next > limit) {
        throw new Error(limitMessage)
    }
    return next
}

function joinCanonicalObject(entries: Array<[string, string]>): string {
    return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',')}}`
}

function stringifyString(value: string): string {
    return JSON.stringify(value)
}

function stringifyNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : JSON.stringify(value)
}

function isHeaderLine(line: NewsletterRetentionEscrowHeader | NewsletterRetentionEscrowRecord | NewsletterRetentionEscrowFooter): line is NewsletterRetentionEscrowHeader {
    return line.kind === 'header'
}

function isFooterLine(line: NewsletterRetentionEscrowHeader | NewsletterRetentionEscrowRecord | NewsletterRetentionEscrowFooter): line is NewsletterRetentionEscrowFooter {
    return line.kind === 'footer'
}
