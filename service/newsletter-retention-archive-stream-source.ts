import { createHash } from 'node:crypto'
import { boundedHistoricalSource, type HistoricalDeadlineOptions } from './newsletter-retention-historical-deadline.js'
import { HISTORICAL_COLUMNS, validateHistoricalArchiveCapacity, type HistoricalArchiveBinding } from './newsletter-retention-historical-archive.js'
import type { NewsletterRetentionHistoricalPreparationSource } from './newsletter-retention-archive-preparation.js'

/**
 * RAM-only transport: two uint32-BE manifest lengths, raw base/delta manifests,
 * then exact compressed base/delta bytes. No file paths, subprocesses or writes.
 * Config is operator-pinned metadata. It cannot carry a restore capability.
 */
export async function openNewsletterRetentionHistoricalArchiveStream(
    input: AsyncIterable<Uint8Array>, config: unknown, options: HistoricalDeadlineOptions = {},
): Promise<NewsletterRetentionHistoricalPreparationSource> {
    const keys = ['baseGenerationId', 'deltaGenerationId', 'baseManifestSha256', 'deltaManifestSha256', 'baseIndexSha256', 'schemaFingerprint', 'columns', 'batchGroupSha256', 'expectedProcedureFingerprint']
    if (!config || typeof config !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(config))
        || Reflect.ownKeys(config).length !== keys.length || Reflect.ownKeys(config).some((key) => typeof key !== 'string' || !keys.includes(key))) throw new Error('historical archive streaming configuration must have exact keys')
    const raw = config as Record<string, unknown>
    for (const key of ['baseManifestSha256', 'deltaManifestSha256', 'baseIndexSha256', 'schemaFingerprint', 'batchGroupSha256', 'expectedProcedureFingerprint']) {
        if (typeof raw[key] !== 'string' || !/^[a-f0-9]{64}$/.test(raw[key] as string)) throw new Error('historical archive streaming fingerprint invalid')
    }
    for (const key of ['baseGenerationId', 'deltaGenerationId']) {
        if (typeof raw[key] !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(raw[key] as string)) throw new Error('historical archive streaming generation invalid')
    }
    if (JSON.stringify(raw.columns) !== JSON.stringify(HISTORICAL_COLUMNS)) throw new Error('historical archive streaming schema mismatch')
    const bounded = boundedHistoricalSource(input, options)
    const iterator = bounded[Symbol.asyncIterator]()
    let pending: Uint8Array = new Uint8Array()
    let ended = false
    let closed = false
    async function nextChunk() {
        const next = await iterator.next()
        if (next.done) { ended = true; return }
        if (!(next.value instanceof Uint8Array) || next.value.byteLength > 1_048_576) throw new Error('historical archive streaming chunk limit')
        pending = next.value
    }
    async function* take(bytes: number) {
        let remaining = bytes
        while (remaining > 0) {
            bounded.check()
            if (closed) throw new Error('historical source cancelled')
            while (!pending.byteLength && !ended) await nextChunk()
            if (ended) throw new Error('historical archive streaming envelope truncated')
            const count = Math.min(pending.byteLength, remaining)
            yield pending.subarray(0, count)
            pending = pending.subarray(count)
            remaining -= count
        }
    }
    async function read(bytes: number) {
        const parts: Uint8Array[] = []
        for await (const chunk of take(bytes)) parts.push(chunk)
        return Buffer.concat(parts)
    }
    async function close() {
        if (closed) return
        closed = true
        await iterator.return?.()
        pending = new Uint8Array()
    }
    try {
        const prefix = await read(8)
        const baseSize = prefix.readUInt32BE(0)
        const deltaSize = prefix.readUInt32BE(4)
        if (baseSize <= 0 || deltaSize <= 0 || baseSize > 1_048_576 || deltaSize > 1_048_576) throw new Error('historical archive streaming manifest limit')
        const baseManifest = await read(baseSize)
        const deltaManifest = await read(deltaSize)
        const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
        if (hash(baseManifest) !== raw.baseManifestSha256 || hash(deltaManifest) !== raw.deltaManifestSha256) throw new Error('historical archive streaming manifest integrity mismatch')
        const base = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(baseManifest))
        const delta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(deltaManifest))
        const files = Array.isArray(base.files) ? base.files.filter((file: { name: string }) => file.name === 'rows.base64.tsv.gz') : []
        if (files.length !== 1) throw new Error('historical archive streaming rows commitment ambiguous')
        const baseBytes = files[0].bytes
        const deltaBytes = delta.rows?.bytes
        for (const size of [baseBytes, deltaBytes]) if (!Number.isSafeInteger(size) || size <= 0 || size > 8 * 1024 ** 3) throw new Error('historical archive streaming rows limit')
        validateHistoricalArchiveCapacity(base, delta, baseBytes, deltaBytes)
        let stage = 0
        const baseRows = (async function* () {
            if (stage !== 0 || closed) throw new Error('historical archive streaming sequence invalid')
            stage = 1
            yield* take(baseBytes)
            stage = 2
        })()
        const deltaRows = (async function* () {
            if (stage !== 2 || closed) throw new Error('historical archive streaming sequence invalid')
            stage = 3
            yield* take(deltaBytes)
            while (!pending.byteLength && !ended) await nextChunk()
            if (pending.byteLength) throw new Error('historical archive streaming envelope has trailing bytes')
            stage = 4
        })()
        const { expectedProcedureFingerprint, ...binding } = raw
        return {
            chain: { baseManifest, deltaManifest, baseRows, deltaRows },
            binding: binding as unknown as HistoricalArchiveBinding,
            expectedProcedureFingerprint: expectedProcedureFingerprint as string,
            close,
        }
    } catch (error) {
        await close()
        if (error instanceof Error && error.message.startsWith('historical archive streaming')) throw error
        throw new Error('historical archive streaming source invalid')
    }
}
