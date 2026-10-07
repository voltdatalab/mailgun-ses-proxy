import { createHash } from 'node:crypto'
import { boundedHistoricalSource, type HistoricalDeadlineOptions } from './newsletter-retention-historical-deadline.js'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { writeNewsletterRetentionEscrow } from './newsletter-retention-escrow-writer.js'
import { parseNewsletterRetentionEscrowRecord, type NewsletterRetentionEscrowRecord } from './newsletter-retention-escrow.js'
import { buildNewsletterRetentionManifest, parseNewsletterRetentionPolicy, type NewsletterRetentionPolicyInput } from './newsletter-retention.js'
import { buildNewsletterRetentionApplyArtifact } from './newsletter-retention-apply.js'
import type { NewsletterRetentionCandidateLoaderRecord } from './newsletter-retention-candidate-loader.js'

// Fixed historical schema, not a general dump/SQL importer.
export const HISTORICAL_COLUMNS = {
    B: ['id', 'siteId', 'fromEmail', 'contents', 'batchId', 'created'],
    M: ['id', 'messageId', 'toEmail', 'newsletterBatchId', 'created', 'formatedContents', 'recipientData'],
    E: ['id', 'toEmail', 'error', 'created', 'newsletterBatchId', 'messageId', 'formatedContents', 'recipientData'],
    N: ['id', 'type', 'notificationId', 'messageId', 'rawEvent', 'timestamp', 'created'],
} as const
const KINDS = { B: 'newsletterBatch', M: 'newsletterMessages', E: 'newsletterErrors', N: 'newsletterNotifications' } as const
// Hard ceilings are independent of per-object commitments, not RAM allowances.
export const HISTORICAL_LIMITS = Object.freeze({ compressedBytes: 8 * 1024 ** 3, decompressedBytes: 64 * 1024 ** 3, rows: 8_000_000, chunkBytes: 1024 ** 2, lineBytes: 1024 ** 2, selectionBytes: 8 * 1024 ** 2, selectionRows: 20_000 })
export interface HistoricalArchiveLimits { compressedBytes: number; decompressedBytes: number; rows: number; chunkBytes: number; lineBytes: number; selectionBytes: number; selectionRows: number }
function limitsFor(overrides: Partial<HistoricalArchiveLimits>) {
    const limits = { ...HISTORICAL_LIMITS, ...overrides }
    for (const key of Object.keys(HISTORICAL_LIMITS) as Array<keyof HistoricalArchiveLimits>) {
        if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > HISTORICAL_LIMITS[key]) throw new Error('historical archive capacity invalid')
    }
    return limits
}
/** Validate pinned metadata before requesting even one payload chunk. */
export function validateHistoricalArchiveCapacity(base: { counts?: unknown }, delta: { deltaCounts?: unknown }, baseBytes: number, deltaBytes: number, overrides: Partial<HistoricalArchiveLimits> = {}) {
    const limits = limitsFor(overrides)
    const counts = base.counts as Record<Tag, number>
    if (!counts || Object.keys(counts).sort().join(',') !== 'B,E,M,N' || Object.values(counts).some((n) => !Number.isSafeInteger(n) || n < 0)) throw new Error('historical archive base counts invalid')
    const dc = delta.deltaCounts as { new: number; changed: number }
    if (!dc || !Number.isSafeInteger(dc.new) || dc.new < 0 || !Number.isSafeInteger(dc.changed) || dc.changed < 0) throw new Error('historical archive delta counts invalid')
    const baseRows = Object.values(counts).reduce((a, b) => a + b, 0)
    const deltaRows = dc.new + dc.changed
    if (![baseBytes, deltaBytes].every((n) => Number.isSafeInteger(n) && n > 0) || baseBytes + deltaBytes > limits.compressedBytes || baseRows + deltaRows > limits.rows) throw new Error('historical archive pinned capacity exceeded')
    return { limits, counts, baseRows, deltaRows }
}
const utf8 = new TextDecoder('utf-8', { fatal: true })
type Tag = keyof typeof HISTORICAL_COLUMNS
type Row = Record<string, string | null>

export interface HistoricalArchiveChain {
    baseManifest: Uint8Array
    deltaManifest: Uint8Array
    baseRows: AsyncIterable<Uint8Array>
    deltaRows: AsyncIterable<Uint8Array>
}

/** Expectations must be independently pinned, never inferred from a restore receipt. */
export interface HistoricalArchiveBinding {
    baseGenerationId: string
    deltaGenerationId: string
    baseManifestSha256: string
    deltaManifestSha256: string
    baseIndexSha256: string
    schemaFingerprint: string
    columns: typeof HISTORICAL_COLUMNS
    batchGroupSha256: string
}

export async function adaptNewsletterRetentionHistoricalArchive(
    chain: HistoricalArchiveChain,
    binding: HistoricalArchiveBinding,
    policyInput: NewsletterRetentionPolicyInput,
    overrides: Partial<HistoricalArchiveLimits> = {},
    deadlines: HistoricalDeadlineOptions = {},
) {
    const policy = parseNewsletterRetentionPolicy(policyInput)
    if (!policy.dryRun) throw new Error('historical archive preparation cannot apply')
    for (const value of [binding.baseManifestSha256, binding.deltaManifestSha256, binding.baseIndexSha256, binding.schemaFingerprint, binding.batchGroupSha256]) {
        if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('historical archive binding fingerprint invalid')
    }
    if (JSON.stringify(binding.columns) !== JSON.stringify(HISTORICAL_COLUMNS)) throw new Error('historical archive schema columns mismatch')
    const base = manifest(chain.baseManifest, binding.baseManifestSha256)
    const delta = manifest(chain.deltaManifest, binding.deltaManifestSha256)
    if (base.generationId !== binding.baseGenerationId || delta.generationId !== binding.deltaGenerationId
        || delta.baseGenerationId !== binding.baseGenerationId || binding.baseGenerationId === binding.deltaGenerationId) {
        throw new Error('historical archive generation chain mismatch')
    }
    if (!Array.isArray(base.files)) throw new Error('historical archive base manifest files invalid')
    const files = base.files.filter((f: FileCommitment) => f.name === 'rows.base64.tsv.gz')
    if (files.length !== 1) throw new Error('historical archive rows commitment ambiguous')
    const baseFile = commitment(files[0])
    if (delta.baseRowsSha256 !== baseFile.sha256 || delta.baseIndexSha256 !== binding.baseIndexSha256) throw new Error('historical archive base/index chain mismatch')
    const deltaFile = commitment(delta.rows)
    const capacity = validateHistoricalArchiveCapacity(base, delta, baseFile.bytes, deltaFile.bytes, overrides)
    const { limits } = capacity
    const budget = { decompressed: 0 }
    let selectedBytes = 0
    let selectedRows = 0
    const digestRows: Record<Tag, Map<string, string>> = { B: new Map(), M: new Map(), E: new Map(), N: new Map() }
    function retain(map: Map<string, Row>, row: Row, tag: Tag, rowSha256: string) {
        digestRows[tag].set(Buffer.from(required(row.id)).toString('hex').toUpperCase(), rowSha256)
        const id = required(row.id)
        const old = map.get(id)
        const cost = Buffer.byteLength(JSON.stringify(row))
        selectedBytes += cost - (old ? Buffer.byteLength(JSON.stringify(old)) : 0)
        if (!old) selectedRows += 1
        if (selectedBytes > limits.selectionBytes || selectedRows > limits.selectionRows) throw new Error('historical archive selection memory capacity exceeded')
        map.set(id, row)
    }
    // Stream both gzip objects fully, hashing compressed bytes including excluded rows.
    // Only one selected parent and its dependent payloads remain in RAM.
    const parents = new Map<string, Row>()
    const messages = new Map<string, Row>()
    const errors = new Map<string, Row>()
    const notifications = new Map<string, Row>()
    const messageIds = new Set<string>()
    let lastPhase = -1
    const baseSource = boundedHistoricalSource(chain.baseRows, deadlines)
    const deltaSource = boundedHistoricalSource(chain.deltaRows, deadlines)
    try {
    await consumeRows(baseSource, baseFile, capacity.baseRows, limits, budget, capacity.counts, async (tag, row, rowSha256) => {
        baseSource.check()
        const phase = ['B', 'M', 'E', 'N'].indexOf(tag)
        if (phase < lastPhase) throw new Error('historical archive table order invalid')
        lastPhase = phase
        if (tag === 'B' && sha(Buffer.from(required(row.batchId))) === binding.batchGroupSha256) {
            if (row.siteId !== policy.siteId) throw new Error('historical archive selected tenant mismatch')
            retain(parents, row, tag, rowSha256)
            if (parents.size > 1) throw new Error('historical archive preparation requires exactly one parent')
        } else if (tag === 'M' && parents.has(required(row.newsletterBatchId))) {
            retain(messages, row, tag, rowSha256)
            if (messages.size > policy.maxMessages) throw new Error('historical archive selection exceeds policy caps')
            if (messageIds.has(required(row.messageId))) throw new Error('historical archive message identity ambiguous')
            messageIds.add(required(row.messageId))
        } else if (tag === 'E' && parents.has(required(row.newsletterBatchId))) retain(errors, row, tag, rowSha256)
        else if (tag === 'N' && messageIds.has(required(row.messageId))) retain(notifications, row, tag, rowSha256)
    }, baseSource.check)
    if (parents.size !== 1) throw new Error('historical archive exact parent selection absent')
    let deltaCount = 0
    await consumeRows(deltaSource, deltaFile, capacity.deltaRows, limits, budget, { B: 0, M: 0, E: 0, N: capacity.deltaRows }, async (tag, row, rowSha256) => {
        deltaSource.check()
        if (tag !== 'N') throw new Error('historical archive delta must contain notification afterimages only')
        deltaCount += 1
        const id = required(row.id)
        if (notifications.has(id) && !messageIds.has(required(row.messageId))) throw new Error('historical archive delta changes selected correlation')
        if (messageIds.has(required(row.messageId))) retain(notifications, row, tag, rowSha256)
    }, deltaSource.check)
    if (!delta.deltaCounts || !Number.isSafeInteger(delta.deltaCounts.new) || delta.deltaCounts.new < 0
        || !Number.isSafeInteger(delta.deltaCounts.changed) || delta.deltaCounts.changed < 0
        || deltaCount !== delta.deltaCounts.new + delta.deltaCounts.changed) throw new Error('historical archive delta count mismatch')
    const parent = [...parents.values()][0]
    const candidate: NewsletterRetentionCandidateLoaderRecord = {
        siteId: required(parent.siteId), batchRecordId: required(parent.id), batchId: required(parent.batchId), createdAt: required(parent.created),
        messageCount: messages.size, errorCount: errors.size, notificationCount: notifications.size, orphanCount: 0, correlationComplete: true,
    }
    if (candidate.createdAt >= policy.cutoff) throw new Error('historical archive parent is not before cutoff')
    if (candidate.messageCount > policy.maxMessages) throw new Error('historical archive selection exceeds policy caps')
    const publicManifest = buildNewsletterRetentionManifest({ siteId: policy.siteId, cutoff: policy.cutoff, policyVersion: policy.policyVersion, batches: [{ batchId: candidate.batchId, createdAt: candidate.createdAt, messageCount: candidate.messageCount, errorCount: candidate.errorCount, notificationCount: candidate.notificationCount }] })
    const records: NewsletterRetentionEscrowRecord[] = []
    for (const [tag, rows] of [['B', parents], ['M', messages], ['E', errors], ['N', notifications]] as const) {
        for (const row of [...rows.values()].sort((a, b) => required(a.id) < required(b.id) ? -1 : required(a.id) > required(b.id) ? 1 : 0)) {
            records.push(parseNewsletterRetentionEscrowRecord({ kind: KINDS[tag], manifestIndex: 0, row }))
        }
    }
    const lines: string[] = []
    let canonicalBytes = 0
    const escrow = await writeNewsletterRetentionEscrow({
        header: { kind: 'header', version: 1, siteId: policy.siteId, cutoff: policy.cutoff, policyVersion: policy.policyVersion, publicManifestHash: publicManifest.hash, schemaFingerprint: binding.schemaFingerprint },
        records: (async function* () { yield* records })(),
        writeChunk(chunk) {
            canonicalBytes += chunk.byteLength
            if (canonicalBytes > limits.selectionBytes * 2 || lines.length > limits.selectionRows + 2) throw new Error('historical archive canonical selection memory capacity exceeded')
            lines.push(utf8.decode(chunk).replace(/\n$/, ''))
        },
    })
    const artifact = buildNewsletterRetentionApplyArtifact({ manifest: publicManifest, escrow, records: [candidate] })
    const readbackDigests = {} as Record<Tag, string>
    for (const tag of ['B', 'M', 'E', 'N'] as const) {
        const digest = createHash('sha256')
        for (const [id, rowHash] of [...digestRows[tag]].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) digest.update(`${tag}\t${id}\t${rowHash}\n`)
        readbackDigests[tag] = digest.digest('hex')
    }
    baseSource.check()
    deltaSource.check()
    return { manifest: publicManifest, artifact, candidate, records, lines, readbackDigests }
    } finally { await Promise.all([baseSource.close(), deltaSource.close()]) }
}

interface FileCommitment { name?: string; bytes: number; sha256: string }
function commitment(value: FileCommitment): FileCommitment {
    if (!value || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > HISTORICAL_LIMITS.compressedBytes || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('historical archive file commitment invalid')
    return value
}
function manifest(bytes: Uint8Array, expected: string) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1_048_576 || sha(bytes) !== expected) throw new Error('historical archive manifest integrity mismatch')
    try { return JSON.parse(utf8.decode(bytes)) } catch { throw new Error('historical archive manifest invalid') }
}
function sha(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex') }
function required(value: string | null) {
    if (typeof value !== 'string' || !value.length) throw new Error('historical archive required field invalid')
    return value
}
function decode(value: string): string {
    // Flat character check avoids regexp stack growth on near-limit payloads.
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('historical archive base64 invalid')
    const bytes = Buffer.from(value, 'base64')
    if (bytes.toString('base64') !== value) throw new Error('historical archive base64 noncanonical')
    try { return utf8.decode(bytes) } catch { throw new Error('historical archive UTF-8 invalid') }
}
function date(value: string): string {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value)
    if (!match || (match[3]?.slice(3).replace(/0/g, '') ?? '') !== '') throw new Error('historical archive datetime unsupported precision')
    const iso = `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(3, '0').slice(0, 3)}Z`
    if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString() !== iso) throw new Error('historical archive datetime invalid')
    return iso
}
async function consumeRows(source: AsyncIterable<Uint8Array>, file: FileCommitment, expectedRows: number, limits: HistoricalArchiveLimits, budget: { decompressed: number }, expectedCounts: Record<Tag, number>, consume: (tag: Tag, row: Row, rowSha256: string) => Promise<void>, check: () => void) {
    let compressedBytes = 0
    const hash = createHash('sha256')
    const input = Readable.from((async function* () {
        for await (const chunk of source) {
            if (!(chunk instanceof Uint8Array) || chunk.byteLength > limits.chunkBytes) throw new Error('historical archive chunk invalid')
            compressedBytes += chunk.byteLength
            if (compressedBytes > file.bytes) throw new Error('historical archive compressed byte limit')
            hash.update(chunk)
            yield chunk
        }
        if (compressedBytes !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error('historical archive rows integrity mismatch')
    })(), { objectMode: true, highWaterMark: 1 })
    const unzip = createGunzip({ chunkSize: 16 * 1024 })
    input.on('error', (error) => unzip.destroy(error))
    input.pipe(unzip)
    let pending = Buffer.alloc(0)
    let count = 0
    // One fixed allocation, 32 bytes per row; no strings retained, no disk.
    const identities = new Uint32Array(expectedRows * 8)
    const counts = { B: 0, M: 0, E: 0, N: 0 }
    try {
        for await (const chunk of unzip) {
            check()
            budget.decompressed += chunk.length
            if (budget.decompressed > limits.decompressedBytes) throw new Error('historical archive decompressed byte limit')
            const buffer = Buffer.concat([pending, chunk])
            let start = 0
            for (let end = 0; end < buffer.length; end += 1) {
                if (buffer[end] !== 10) continue
                if (end - start > limits.lineBytes || ++count > expectedRows) throw new Error('historical archive row limit')
                const line = buffer.subarray(start, end).toString('latin1')
                start = end + 1
                const frame = /^([BMEN])!([A-Za-z0-9+/=]*)!$/.exec(line)
                if (!frame) throw new Error('historical archive frame invalid')
                const tag = frame[1] as Tag
                const fields = decode(frame[2]).split('\x1f')
                if (fields.length !== HISTORICAL_COLUMNS[tag].length) throw new Error('historical archive schema field count mismatch')
                const row: Row = {}
                HISTORICAL_COLUMNS[tag].forEach((column, index) => {
                    const value = fields[index] === '-' ? null : decode(fields[index])
                    row[column] = value !== null && (column === 'created' || column === 'timestamp') ? date(value) : value
                })
                if (++counts[tag] > expectedCounts[tag]) throw new Error('historical archive table count exceeded')
                const digest = createHash('sha256').update(`${tag}:${required(row.id)}`).digest()
                for (let word = 0; word < 8; word += 1) identities[(count - 1) * 8 + word] = digest.readUInt32BE(word * 4)
                await consume(tag, row, sha(Buffer.from(frame[2], 'ascii')))
            }
            pending = Buffer.from(buffer.subarray(start))
            if (pending.length > limits.lineBytes) throw new Error('historical archive line limit')
        }
        if (pending.length) throw new Error('historical archive missing final newline')
        if (count !== expectedRows || Object.keys(counts).some((tag) => counts[tag as Tag] !== expectedCounts[tag as Tag])) throw new Error('historical archive row count mismatch')
        rejectDuplicateDigests(identities, count, check)
    } finally {
        input.destroy()
        unzip.destroy()
    }
}

/** In-place heapsort of 256-bit records: O(n log n), O(1) auxiliary RAM.
 * A SHA256 collision is conservatively rejected, never admitted as unique. */
function rejectDuplicateDigests(words: Uint32Array, count: number, check: () => void) {
    function compare(a: number, b: number) {
        for (let i = 0; i < 8; i += 1) {
            const x = words[a * 8 + i], y = words[b * 8 + i]
            if (x !== y) return x < y ? -1 : 1
        }
        return 0
    }
    function swap(a: number, b: number) {
        for (let i = 0; i < 8; i += 1) {
            const tmp = words[a * 8 + i]
            words[a * 8 + i] = words[b * 8 + i]
            words[b * 8 + i] = tmp
        }
    }
    function sift(root: number, end: number) {
        while (root * 2 + 1 < end) {
            let child = root * 2 + 1
            if (child + 1 < end && compare(child, child + 1) < 0) child += 1
            if (compare(root, child) >= 0) return
            swap(root, child)
            root = child
        }
    }
    for (let root = Math.floor(count / 2) - 1; root >= 0; root -= 1) { if (root % 1024 === 0) check(); sift(root, count) }
    for (let end = count - 1; end > 0; end -= 1) { if (end % 1024 === 0) check(); swap(0, end); sift(0, end) }
    for (let i = 1; i < count; i += 1) { if (i % 1024 === 0) check(); if (compare(i - 1, i) === 0) throw new Error('historical archive duplicate identity') }
}
