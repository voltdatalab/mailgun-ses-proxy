import { randomUUID } from 'node:crypto'
import { adaptNewsletterRetentionHistoricalArchive, HISTORICAL_LIMITS } from './newsletter-retention-historical-archive.js'
import { openNewsletterRetentionHistoricalArchiveStream } from './newsletter-retention-archive-stream-source.js'
import { boundedHistoricalSource } from './newsletter-retention-historical-deadline.js'
import { createHistoricalAcquisitionVerifier } from './newsletter-retention-historical-acquisition.js'
import { assertHistoricalReadOnlyRoot, assertHistoricalSelectedWave } from './newsletter-retention-historical-readonly-preparation.js'
import { parseNewsletterRetentionPolicy } from './newsletter-retention.js'
import { checkHistoricalGates, type HistoricalExecutorRoot, type HistoricalExecutorRequest, type HistoricalExecutorReceipt } from './newsletter-retention-historical-executor-contract.js'
import {
    parseNewsletterRetentionEscrowRecord,
    parseNewsletterRetentionEscrowVerificationResult,
    serializeNewsletterRetentionEscrowRecord,
    type NewsletterRetentionEscrowRecord,
} from './newsletter-retention-escrow.js'
import {
    streamNewsletterRetentionEscrowRecords,
    type NewsletterRetentionEscrowLoaderDelegate,
} from './newsletter-retention-escrow-loader.js'
import {
    type NewsletterRetentionApplyContext,
    type NewsletterRetentionApplyContextInput,
    parseNewsletterRetentionApplyContext,
} from './newsletter-retention-apply.js'

export const NEWSLETTER_RETENTION_APPLY_LOCK_KEY = 'newsletter-retention-apply'

export class NewsletterRetentionApplyError extends Error {
    readonly completedBatchCount: number
    readonly failedManifestIndex: number | null

    constructor(message: string, completedBatchCount: number, failedManifestIndex: number | null) {
        super(message)
        this.name = 'NewsletterRetentionApplyError'
        this.completedBatchCount = completedBatchCount
        this.failedManifestIndex = failedManifestIndex
        Object.setPrototypeOf(this, new.target.prototype)
    }
}

export interface NewsletterRetentionApplyInput extends NewsletterRetentionApplyContextInput {
    lock: NewsletterRetentionApplyLockProvider
    database: NewsletterRetentionApplyDatabase
    escrowSource: NewsletterRetentionVerifiedEscrowSource
}

export interface NewsletterRetentionVerifiedEscrowSource {
    readonly verification: unknown
    readBatchRecords(args: { manifestIndex: number }): Promise<readonly unknown[]>
}

export interface NewsletterRetentionApplyReceiptBatch {
    manifestIndex: number
    batchId: string
    deletedNotificationCount: number
    deletedErrorCount: number
    deletedMessageCount: number
    deletedBatchCount: number
}

export interface NewsletterRetentionApplyReceipt {
    manifestHash: string
    artifactHash: string
    escrowContentHash: string
    schemaFingerprint: string
    siteId: string
    batches: NewsletterRetentionApplyReceiptBatch[]
}

export interface NewsletterRetentionApplyLockLease {
    release(): void | Promise<void>
}

export interface NewsletterRetentionApplyLockProvider {
    tryAcquire(key: string): NewsletterRetentionApplyLockLease | null | Promise<NewsletterRetentionApplyLockLease | null>
}

export interface NewsletterRetentionApplyDatabase {
    $transaction<T>(callback: (tx: NewsletterRetentionApplyTransactionClient) => Promise<T>, options: {
        isolationLevel: 'Serializable'
    }): Promise<T>
}

export interface NewsletterRetentionApplyTransactionClient {
    newsletterBatch: NewsletterRetentionEscrowLoaderDelegate['newsletterBatch'] & {
        deleteMany(args: NewsletterRetentionApplyParentDeleteManyArgs): Promise<{ count: number }>
        count(args: NewsletterRetentionApplyParentCountArgs): Promise<number>
    }
    newsletterMessages: NewsletterRetentionEscrowLoaderDelegate['newsletterMessages'] & {
        deleteMany(args: NewsletterRetentionApplyMessageDeleteManyArgs): Promise<{ count: number }>
        count(args: NewsletterRetentionApplyMessageCountArgs): Promise<number>
    }
    newsletterErrors: NewsletterRetentionEscrowLoaderDelegate['newsletterErrors'] & {
        deleteMany(args: NewsletterRetentionApplyErrorsDeleteManyArgs): Promise<{ count: number }>
        count(args: NewsletterRetentionApplyErrorsCountArgs): Promise<number>
    }
    newsletterNotifications: NewsletterRetentionEscrowLoaderDelegate['newsletterNotifications'] & {
        deleteMany(args: NewsletterRetentionApplyNotificationDeleteManyArgs): Promise<{ count: number }>
        count(args: NewsletterRetentionApplyNotificationCountArgs): Promise<number>
    }
    newsletterNotificationOrphan: NewsletterRetentionEscrowLoaderDelegate['newsletterNotificationOrphan']
}

export interface NewsletterRetentionApplyParentFindFirstArgs {
    where: {
        id: string
        siteId: string
    }
    select: {
        id: true
        siteId: true
        batchId: true
        created: true
        _count: {
            select: {
                NewslettersMessages: true
                NewslettersErrors: true
            }
        }
    }
}

export interface NewsletterRetentionApplyParentRow {
    id: string
    siteId: string
    batchId: string
    created: Date
    _count: {
        NewslettersMessages: number
        NewslettersErrors: number
    }
}

export interface NewsletterRetentionApplyMessageFindManyArgs {
    where: {
        newsletterBatchId: string
    }
    orderBy: Array<{ id: 'asc' | 'desc' }>
    take: number
    select: {
        messageId: true
        _count: {
            select: {
                notificationEvents: true
            }
        }
    }
}

export interface NewsletterRetentionApplyMessageRow {
    messageId: string
    _count: {
        notificationEvents: number
    }
}

export interface NewsletterRetentionApplyNotificationDeleteManyArgs {
    where: {
        messageId: {
            in: string[]
        }
    }
}

export interface NewsletterRetentionApplyErrorsDeleteManyArgs {
    where: {
        newsletterBatchId: string
    }
}

export interface NewsletterRetentionApplyMessageDeleteManyArgs {
    where: {
        newsletterBatchId: string
    }
}

export interface NewsletterRetentionApplyParentDeleteManyArgs {
    where: {
        id: string
        siteId: string
        batchId: string
        created: Date
    }
}

export interface NewsletterRetentionApplyParentCountArgs {
    where: {
        id: string
        siteId: string
    }
}

export interface NewsletterRetentionApplyMessageCountArgs {
    where: {
        newsletterBatchId: string
    }
}

export interface NewsletterRetentionApplyErrorsCountArgs {
    where: {
        newsletterBatchId: string
    }
}

export interface NewsletterRetentionApplyNotificationCountArgs {
    where: {
        messageId: {
            in: string[]
        }
    }
}

export interface NewsletterRetentionApplyOrphanCountArgs {
    where: {
        messageId: {
            in: string[]
        }
        reconciledAt: null
    }
}

export async function executeNewsletterRetentionApply(input: NewsletterRetentionApplyInput): Promise<NewsletterRetentionApplyReceipt> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('newsletter retention apply input must be a plain object')
    }

    const context = parseNewsletterRetentionApplyContext(input)
    const escrowSource = normalizeVerifiedEscrowSource(input.escrowSource, context)
    const lease = await tryAcquireApplyLease(input.lock)

    let completedBatchCount = 0
    let failure: NewsletterRetentionApplyError | null = null
    let receipt: NewsletterRetentionApplyReceipt | null = null
    let releaseFailure: NewsletterRetentionApplyError | null = null
    let currentManifestIndex: number | null = null

    try {
        const batches: NewsletterRetentionApplyReceiptBatch[] = []

        for (const binding of context.artifact.bindings) {
            const manifestBatch = context.manifest.batches[binding.manifestIndex]
            currentManifestIndex = binding.manifestIndex
            const expectedRecords = await readVerifiedBatchRecords(
                escrowSource,
                binding.manifestIndex,
                manifestBatch,
            )
            const batchResult = await input.database.$transaction(
                async (tx) => applyNewsletterRetentionBatch(
                    tx,
                    context,
                    binding.manifestIndex,
                    manifestBatch,
                    binding.batchRecordId,
                    expectedRecords,
                ),
                { isolationLevel: 'Serializable' },
            )

            batches.push({
                manifestIndex: binding.manifestIndex,
                batchId: manifestBatch.batchId,
                deletedNotificationCount: batchResult.deletedNotificationCount,
                deletedErrorCount: batchResult.deletedErrorCount,
                deletedMessageCount: batchResult.deletedMessageCount,
                deletedBatchCount: batchResult.deletedBatchCount,
            })
            completedBatchCount += 1
        }

        receipt = {
            manifestHash: context.manifest.hash,
            artifactHash: context.artifact.hash,
            escrowContentHash: context.artifact.escrow.contentHash,
            schemaFingerprint: context.artifact.escrow.schemaFingerprint,
            siteId: context.manifest.siteId,
            batches,
        }
    } catch {
        failure = new NewsletterRetentionApplyError('newsletter retention apply failed', completedBatchCount, currentManifestIndex)
    } finally {
        if (lease) {
            try {
                await Promise.resolve(lease.release())
            } catch {
                releaseFailure = new NewsletterRetentionApplyError(
                    failure
                        ? 'newsletter retention apply failed and lock release failed'
                        : 'newsletter retention apply release failed',
                    completedBatchCount,
                    failure?.failedManifestIndex ?? null,
                )
            }
        }
    }

    if (releaseFailure) {
        throw releaseFailure
    }

    if (failure) {
        throw failure
    }

    return receipt as NewsletterRetentionApplyReceipt
}

async function tryAcquireApplyLease(lock: NewsletterRetentionApplyLockProvider): Promise<NewsletterRetentionApplyLockLease | null> {
    if (!lock || typeof lock !== 'object') {
        throw new NewsletterRetentionApplyError('newsletter retention apply lock provider is invalid', 0, null)
    }

    try {
        const lease = await lock.tryAcquire(NEWSLETTER_RETENTION_APPLY_LOCK_KEY)
        if (!lease) {
            throw new NewsletterRetentionApplyError('newsletter retention apply lock is already held', 0, null)
        }

        return lease
    } catch (error) {
        if (error instanceof NewsletterRetentionApplyError) {
            throw error
        }

        throw new NewsletterRetentionApplyError('newsletter retention apply lock acquisition failed', 0, null)
    }
}

function normalizeVerifiedEscrowSource(
    value: unknown,
    context: NewsletterRetentionApplyContext,
): NewsletterRetentionVerifiedEscrowSource {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('verified escrow source must be an object')
    }
    const source = value as Partial<NewsletterRetentionVerifiedEscrowSource>
    if (typeof source.readBatchRecords !== 'function') {
        throw new Error('verified escrow source must provide readBatchRecords')
    }
    const verification = parseNewsletterRetentionEscrowVerificationResult(source.verification)
    if (JSON.stringify(verification) !== JSON.stringify(context.artifact.escrow)) {
        throw new Error('verified escrow source commitment must match apply artifact')
    }
    return value as NewsletterRetentionVerifiedEscrowSource
}

async function readVerifiedBatchRecords(
    source: NewsletterRetentionVerifiedEscrowSource,
    manifestIndex: number,
    manifestBatch: NewsletterRetentionApplyContext['manifest']['batches'][number],
): Promise<readonly NewsletterRetentionEscrowRecord[]> {
    const rows = await source.readBatchRecords({ manifestIndex })
    if (!Array.isArray(rows)) {
        throw new Error('verified escrow source batch records must be an array')
    }
    const expectedRecordCount = safeAddIntegers(
        safeAddIntegers(
            safeAddIntegers(1, manifestBatch.messageCount, 'verified escrow batch record count'),
            manifestBatch.errorCount,
            'verified escrow batch record count',
        ),
        manifestBatch.notificationCount,
        'verified escrow batch record count',
    )
    if (rows.length !== expectedRecordCount) {
        throw new Error('verified escrow source batch record count mismatch')
    }
    return rows.map((row) => {
        const record = parseNewsletterRetentionEscrowRecord(row)
        if (record.manifestIndex !== manifestIndex) {
            throw new Error('verified escrow source manifest index mismatch')
        }
        return record
    })
}

function assertExactEscrowBatchRecords(
    actual: readonly NewsletterRetentionEscrowRecord[],
    expected: readonly NewsletterRetentionEscrowRecord[],
): void {
    if (actual.length !== expected.length) {
        throw new Error('transactional escrow record count mismatch')
    }
    for (let index = 0; index < actual.length; index += 1) {
        if (serializeNewsletterRetentionEscrowRecord(actual[index]) !== serializeNewsletterRetentionEscrowRecord(expected[index])) {
            throw new Error('transactional escrow record mismatch')
        }
    }
}

/** Test-only rehearsal seam into the SAME child-first transactional core.
 * Not admission: not wired to runtime/CLI; rejects non-test runtime entry.
 * A production historical
 * executor remains disabled until independent provenance and review exist. */
export async function recheckAndApplyNewsletterRetentionArchiveBatchForFixture(
    tx: NewsletterRetentionApplyTransactionClient & { newsletterBatch: { findMany(args: { where: { batchId: string }; select: { id: true }; take: number }): Promise<Array<{ id: string }>> } },
    context: NewsletterRetentionApplyContext,
    expectedRecords: readonly NewsletterRetentionEscrowRecord[],
): Promise<NewsletterRetentionApplyReceiptBatch> {
    if (process.env.NODE_ENV !== 'test') throw new Error('historical archive apply admission is not enabled')
    if (context.artifact.bindings.length !== 1 || context.manifest.batches.length !== 1) throw new Error('historical archive fixture requires one complete group')
    const binding = context.artifact.bindings[0]
    const batch = context.manifest.batches[binding.manifestIndex]
    if (!batch || binding.manifestIndex !== 0) throw new Error('historical archive fixture binding invalid')
    const parents = await tx.newsletterBatch.findMany({ where: { batchId: batch.batchId }, select: { id: true }, take: 2 })
    if (parents.length !== 1 || parents[0].id !== binding.batchRecordId) throw new Error('historical archive transactional parent set mismatch')
    return applyNewsletterRetentionBatch(tx, context, 0, batch, binding.batchRecordId, expectedRecords)
}

async function applyNewsletterRetentionBatch(
    tx: NewsletterRetentionApplyTransactionClient,
    context: Pick<NewsletterRetentionApplyContext, 'policy' | 'manifest' | 'artifact'>,
    manifestIndex: number,
    manifestBatch: NewsletterRetentionApplyContext['manifest']['batches'][number],
    batchRecordId: string,
    expectedRecords: readonly NewsletterRetentionEscrowRecord[],
    beforeMutation?: () => void | Promise<void>,
    validateActualRecord?: (record: NewsletterRetentionEscrowRecord) => void,
): Promise<NewsletterRetentionApplyReceiptBatch> {
    const candidate = {
        siteId: context.manifest.siteId,
        batchRecordId,
        batchId: manifestBatch.batchId,
        createdAt: manifestBatch.createdAt,
        messageCount: manifestBatch.messageCount,
        notificationCount: manifestBatch.notificationCount,
        errorCount: manifestBatch.errorCount,
        orphanCount: 0,
        correlationComplete: true,
    }
    const actualRecords: NewsletterRetentionEscrowRecord[] = []
    for await (const record of streamNewsletterRetentionEscrowRecords(tx, context.policy, [candidate])) {
        validateActualRecord?.(record)
        actualRecords.push({ ...record, manifestIndex })
    }
    assertExactEscrowBatchRecords(actualRecords, expectedRecords)

    const parentRecord = actualRecords[0]
    if (!parentRecord || parentRecord.kind !== 'newsletterBatch') {
        throw new Error('transactional escrow batch parent is missing')
    }
    const parent = parentRecord.row
    const messageIds = actualRecords.flatMap((record) => (
        record.kind === 'newsletterMessages' ? [record.row.messageId] : []
    ))

    let deletedNotificationCount = 0
    if (messageIds.length > 0) {
        if (beforeMutation) await beforeMutation()
        deletedNotificationCount = await deleteAndValidateCount(
            tx.newsletterNotifications.deleteMany({ where: { messageId: { in: messageIds } } }),
            manifestBatch.notificationCount,
            'newsletterNotifications.deleteMany',
        )
    }

    if (beforeMutation) await beforeMutation()
    const deletedErrorCount = await deleteAndValidateCount(
        tx.newsletterErrors.deleteMany({ where: { newsletterBatchId: parent.id } }),
        manifestBatch.errorCount,
        'newsletterErrors.deleteMany',
    )
    if (beforeMutation) await beforeMutation()
    const deletedMessageCount = await deleteAndValidateCount(
        tx.newsletterMessages.deleteMany({ where: { newsletterBatchId: parent.id } }),
        manifestBatch.messageCount,
        'newsletterMessages.deleteMany',
    )
    if (beforeMutation) await beforeMutation()
    const deletedBatchCount = await deleteAndValidateCount(
        tx.newsletterBatch.deleteMany({
            where: {
                id: parent.id,
                siteId: parent.siteId,
                batchId: parent.batchId,
                created: new Date(parent.created),
            },
        }),
        1,
        'newsletterBatch.deleteMany',
    )

    if (await tx.newsletterBatch.count({ where: { id: parent.id, siteId: parent.siteId } }) !== 0) {
        throw new Error('newsletterBatch postcondition failed')
    }
    if (await tx.newsletterMessages.count({ where: { newsletterBatchId: parent.id } }) !== 0) {
        throw new Error('newsletterMessages postcondition failed')
    }
    if (await tx.newsletterErrors.count({ where: { newsletterBatchId: parent.id } }) !== 0) {
        throw new Error('newsletterErrors postcondition failed')
    }
    if (messageIds.length > 0) {
        if (await tx.newsletterNotifications.count({ where: { messageId: { in: messageIds } } }) !== 0) {
            throw new Error('newsletterNotifications postcondition failed')
        }
        if (await tx.newsletterNotificationOrphan.count({
            where: { messageId: { in: messageIds }, reconciledAt: null },
        }) !== 0) {
            throw new Error('newsletterNotificationOrphan postcondition failed')
        }
    }

    return {
        manifestIndex,
        batchId: manifestBatch.batchId,
        deletedNotificationCount,
        deletedErrorCount,
        deletedMessageCount,
        deletedBatchCount,
    }
}

function normalizeCount(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative safe integer`)
    }

    return value
}

function safeAddIntegers(left: number, right: number, field: string): number {
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
        throw new Error(`${field} must be a non-negative integer`)
    }

    if (left > Number.MAX_SAFE_INTEGER - right) {
        throw new Error(`${field} sum exceeds Number.MAX_SAFE_INTEGER`)
    }

    return left + right
}

/** Internal composition API; no runtime/CLI controller is wired. The application
 * root must provision ALL ports/key/approval independently of request metadata.
 * The only positive capability is private identity created after connected stream
 * verification + authenticated acquisition + exact independent wave authorization. */
export function createInternalHistoricalRetentionExecutor(provided: HistoricalExecutorRoot) {
    if (!provided?.acquisitionRoot || !provided.approval || !provided.gates || !provided.database || !provided.postcommit?.read) throw new Error('historical trusted adapters not configured')
    for (const key of ['ghost', 'queues', 'proxy', 'pressure', 'schema', 'correlation'] as const) {
        if (typeof provided.gates[key] !== 'function') throw new Error('historical trusted gate adapter missing')
    }
    const root: HistoricalExecutorRoot = {
        ...provided, binding: structuredClone(provided.binding), policy: structuredClone(provided.policy), approval: structuredClone(provided.approval),
        acquisitionRoot: { ...provided.acquisitionRoot }, queueIds: [...provided.queueIds], gates: {
            ghost: provided.gates.ghost.bind(provided.gates), queues: provided.gates.queues.bind(provided.gates),
            proxy: provided.gates.proxy.bind(provided.gates), pressure: provided.gates.pressure.bind(provided.gates),
            schema: provided.gates.schema.bind(provided.gates), correlation: provided.gates.correlation.bind(provided.gates),
        },
        lock: { tryAcquire: provided.lock.tryAcquire.bind(provided.lock) },
        database: { $transaction: provided.database.$transaction.bind(provided.database) },
        postcommit: { read: provided.postcommit.read.bind(provided.postcommit) },
    }
    assertHistoricalReadOnlyRoot(root)
    const policy = parseNewsletterRetentionPolicy(root.policy)
    const verifyAcquisition = createHistoricalAcquisitionVerifier(root.acquisitionRoot)
    const capabilities = new WeakMap<object, { selected: Awaited<ReturnType<typeof adaptNewsletterRetentionHistoricalArchive>>; authentication: ReturnType<typeof verifyAcquisition>; binding: HistoricalExecutorRoot['binding']; policy: typeof policy; approval: HistoricalExecutorRoot['approval'] }>()
    let waveConsumed = false
    return async (request: HistoricalExecutorRequest): Promise<HistoricalExecutorReceipt> => {
        const receipt: HistoricalExecutorReceipt = { version: 1, state: 'refused_before_transaction', stage: 'lock', cleanupFailures: [] }
        let lease: NewsletterRetentionApplyLockLease | null = null
        let source: Awaited<ReturnType<typeof openNewsletterRetentionHistoricalArchiveStream>> | null = null
        let work: ReturnType<typeof boundedHistoricalSource> | null = null
        const attemptId = randomUUID()
        let transactionEntered = false
        try {
            if (!request || Object.keys(request).some(k => !['stream', 'acquisition', 'deadlines'].includes(k)) || waveConsumed) return receipt
            lease = await root.lock.tryAcquire(NEWSLETTER_RETENTION_APPLY_LOCK_KEY)
            if (!lease || waveConsumed) return receipt
            receipt.stage = 'stream'
            work = boundedHistoricalSource(request.stream, request.deadlines)
            source = await openNewsletterRetentionHistoricalArchiveStream(work, { ...root.binding, expectedProcedureFingerprint: root.acquisitionRoot.procedureFingerprint }, { ...request.deadlines, signal: work.signal })
            const selected = await adaptNewsletterRetentionHistoricalArchive(source.chain, source.binding, root.policy, {}, { ...request.deadlines, signal: work.signal })
            work.check()
            receipt.stage = 'admission'
            const expected = root.approval.expected
            assertHistoricalSelectedWave(root, selected)
            const authentication = verifyAcquisition(request.acquisition, expected, root.now())
            // Synchronous authenticated check-and-set before any gate/capability;
            // never return approval after gate failure or an unknown DB outcome.
            if (waveConsumed) return receipt
            waveConsumed = true
            const recipients = selected.records.flatMap(record => record.kind === 'newsletterMessages' ? [record.row.toEmail] : [])
            const gateRequest = Object.freeze({ artifactHash: selected.artifact.hash, batchGroupSha256: root.binding.batchGroupSha256, attemptId, signal: work.signal })
            receipt.stage = 'gates'
            await checkHistoricalGates(root, gateRequest, recipients)
            work.check()
            const capability = Object.freeze({})
            capabilities.set(capability, { selected, authentication, binding: root.binding, policy, approval: root.approval })
            receipt.manifestHash = selected.manifest.hash
            receipt.artifactHash = selected.artifact.hash
            receipt.stage = 'transaction'
            transactionEntered = true
            let callbackResult: NewsletterRetentionApplyReceiptBatch | null = null
            const result = await root.database.$transaction(async tx => {
                const admitted = capabilities.get(capability)
                capabilities.delete(capability)
                if (!admitted || admitted.selected !== selected || admitted.authentication !== authentication) throw new Error('historical capability invalid or consumed')
                work!.check()
                await checkHistoricalGates(root, gateRequest, recipients)
                const binding = selected.artifact.bindings[0], batch = selected.manifest.batches[0]
                const parents = await tx.newsletterBatch.findMany({ where: { batchId: batch.batchId }, select: { id: true }, take: 2 })
                if (parents.length !== 1 || parents[0].id !== binding.batchRecordId) throw new Error('historical exact parent set changed')
                let actualBytes = 0, actualRows = 0
                callbackResult = await applyNewsletterRetentionBatch(tx, { policy, manifest: selected.manifest, artifact: selected.artifact }, 0, batch, binding.batchRecordId, selected.records, async () => {
                    work!.check()
                    await checkHistoricalGates(root, gateRequest, recipients)
                    work!.check()
                }, record => {
                    work!.check()
                    actualBytes += Buffer.byteLength(JSON.stringify(record.row))
                    if (++actualRows > HISTORICAL_LIMITS.selectionRows || actualBytes > HISTORICAL_LIMITS.selectionBytes) throw new Error('historical live selection capacity exceeded')
                })
                work!.check()
                return callbackResult
            }, { isolationLevel: 'Serializable', attemptId })
            if (!callbackResult || result !== callbackResult) throw new Error('historical transaction adapter result unconfirmed')
            // Resolved transaction => committed. Nothing below can report rollback.
            receipt.state = 'committed_readback_failed'
            receipt.stage = 'postcommit'
            receipt.deleted = { batches: result.deletedBatchCount, messages: result.deletedMessageCount, errors: result.deletedErrorCount, notifications: result.deletedNotificationCount }
            const remaining = await root.postcommit.read({ attemptId, batchId: selected.candidate.batchId, batchRecordId: selected.candidate.batchRecordId,
                messageIds: selected.records.flatMap(record => record.kind === 'newsletterMessages' ? [record.row.messageId] : []), artifactHash: selected.artifact.hash })
            const keys = ['parents', 'messages', 'errors', 'notifications', 'orphans', 'lateEvents']
            if (remaining && Object.keys(remaining).length === keys.length && keys.every(key => remaining[key as keyof typeof remaining] === 0)) receipt.state = 'committed_readback_ok'
        } catch {
            if (transactionEntered && receipt.state === 'refused_before_transaction') {
                receipt.state = 'commit_unknown'
                try {
                    const confirmation = await root.confirmRollback?.(attemptId)
                    if (confirmation?.attemptId === attemptId && confirmation.outcome === 'rollback_confirmed') receipt.state = 'rollback_confirmed'
                } catch { /* Outcome remains unknown. A rejected generic transaction is not rollback proof. */ }
            }
        } finally {
            try { await source?.close() } catch { receipt.cleanupFailures.push('source_cleanup_failed') }
            try { await work?.close() } catch { receipt.cleanupFailures.push('source_cleanup_failed') }
            if (work?.cleanupIncomplete && !receipt.cleanupFailures.includes('source_cleanup_failed')) receipt.cleanupFailures.push('source_cleanup_failed')
            try { await lease?.release() } catch { receipt.cleanupFailures.push('lock_release_failed') }
        }
        return receipt
    }
}

async function deleteAndValidateCount(result: Promise<{ count: number }>, expected: number, field: string): Promise<number> {
    const resolved = await result
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
        throw new Error(`${field} must return a {count} object`)
    }

    if (normalizeCount(resolved.count, `${field}.count`) !== expected) {
        throw new Error(`${field} deleted unexpected number of rows`)
    }

    return resolved.count
}
