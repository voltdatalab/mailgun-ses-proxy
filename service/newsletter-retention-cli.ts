import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    buildNewsletterRetentionManifest,
    parseNewsletterRetentionEvidence,
    parseNewsletterRetentionPolicy,
    type NewsletterRetentionEvidence,
    type NewsletterRetentionEvidenceInput,
    type NewsletterRetentionManifest,
} from './newsletter-retention.js'
import {
    loadNewsletterRetentionCandidateRecords,
    type NewsletterRetentionCandidateLoaderDelegate,
} from './newsletter-retention-candidate-loader.js'
import { buildNewsletterRetentionSelectionPlan } from './newsletter-retention-plan.js'
import {
    buildNewsletterRetentionApplyArtifact,
    parseNewsletterRetentionApplyArtifact,
} from './newsletter-retention-apply.js'
import {
    buildNewsletterRetentionEscrowDryRunResult,
    type NewsletterRetentionEscrowDryRunResult,
} from './newsletter-retention-coordinator.js'
import type { NewsletterRetentionEscrowLoaderDelegate } from './newsletter-retention-escrow-loader.js'
import {
    NEWSLETTER_RETENTION_ESCROW_MAX_LINE_BYTES,
    NEWSLETTER_RETENTION_ESCROW_MAX_RECORDS,
    NEWSLETTER_RETENTION_ESCROW_MAX_TOTAL_BYTES,
    createNewsletterRetentionEscrowAccumulator,
    parseNewsletterRetentionEscrowRecord,
    parseNewsletterRetentionEscrowVerificationResult,
    type NewsletterRetentionEscrowRecord,
} from './newsletter-retention-escrow.js'
import {
    NEWSLETTER_RETENTION_APPLY_LOCK_KEY,
    executeNewsletterRetentionApply,
    type NewsletterRetentionApplyDatabase,
    type NewsletterRetentionApplyLockProvider,
    type NewsletterRetentionApplyReceipt,
    type NewsletterRetentionVerifiedEscrowSource,
} from './newsletter-retention-applier.js'

const MAX_JSON_FILE_BYTES = 1_048_576
const MAX_DLQ_EVIDENCE_AGE_MS = 15 * 60_000
const UTC_ISO_8601_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SHA_256_HEX = /^[a-f0-9]{64}$/
// Node and Bun do not currently export Linux's __O_TMPFILE flag by name.
const LINUX_O_TMPFILE = 0o20000000 | constants.O_DIRECTORY
const LINK_HELPER_DESTINATION_EXISTS = 73
const LINK_HELPER_PATHS = [
    '/usr/local/libexec/newsletter-retention-linkat',
    resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/newsletter-retention-linkat'),
]

export type NewsletterRetentionCliDatabase = NewsletterRetentionCandidateLoaderDelegate
    & NewsletterRetentionEscrowLoaderDelegate
    & NewsletterRetentionApplyDatabase

export interface NewsletterRetentionClosableEscrowSource extends NewsletterRetentionVerifiedEscrowSource {
    close(): void | Promise<void>
}

export interface NewsletterRetentionCliDependencies {
    database: NewsletterRetentionCliDatabase
    createLockProvider(): NewsletterRetentionApplyLockProvider
    now(): Date
    schemaFingerprint(): string | Promise<string>
    writeEscrowFileExclusive(
        path: string,
        producer: (writeChunk: (chunk: Uint8Array) => Promise<void>) => Promise<NewsletterRetentionEscrowDryRunResult>,
    ): Promise<NewsletterRetentionEscrowDryRunResult>
    openVerifiedEscrowSource(path: string): Promise<NewsletterRetentionClosableEscrowSource>
    readJsonFile(path: string, privacy: 'public' | 'private'): Promise<unknown>
    writeJsonFileExclusive(path: string, value: unknown, mode: 0o600 | 0o644): Promise<void>
}

export interface NewsletterRetentionCliDryRunOutput {
    mode: 'dry-run'
    dryRun: true
    siteId: string
    cutoff: string
    policyVersion: number
    batchCount: number
    totals: {
        messageCount: number
        notificationCount: number
        errorCount: number
    }
    manifest: NewsletterRetentionManifest
    escrow: {
        written: boolean
        contentHash: string | null
        schemaFingerprint: string | null
    }
    privateArtifact: {
        written: boolean
        hash: string | null
    }
}

export interface NewsletterRetentionCliApplyOutput {
    mode: 'apply'
    dryRun: false
    receipt: NewsletterRetentionApplyReceipt
}

export type NewsletterRetentionCliOutput = NewsletterRetentionCliDryRunOutput | NewsletterRetentionCliApplyOutput

interface ParsedCliOptions {
    apply: boolean
    siteId: string
    cutoff: string
    maxBatches?: number
    maxMessages?: number
    evidenceFile: string
    manifestOut?: string
    privateArtifactOut?: string
    escrowOut?: string
    manifestFile?: string
    privateArtifactFile?: string
    escrowFile?: string
    expectedManifestHash?: string
    expectedArtifactHash?: string
    expectedEscrowContentHash?: string
    confirmSiteId?: string
}

export class NewsletterRetentionCliError extends Error {
    constructor(message = 'newsletter retention command failed') {
        super(message)
        this.name = 'NewsletterRetentionCliError'
    }
}

export async function executeNewsletterRetentionCli(
    argv: readonly string[],
    dependencies: NewsletterRetentionCliDependencies,
): Promise<NewsletterRetentionCliOutput> {
    const options = parseCliOptions(argv)
    const now = normalizeNow(dependencies.now())
    const rawEvidence = await dependencies.readJsonFile(options.evidenceFile, 'public')
    const evidence = parseCliEvidence(rawEvidence, now)
    const policy = parseNewsletterRetentionPolicy({
        siteId: options.siteId,
        cutoff: options.cutoff,
        apply: options.apply,
        maxBatches: options.maxBatches,
        maxMessages: options.maxMessages,
    })

    if (!options.apply) {
        return executeDryRunWithLock(options, policy, evidence, dependencies)
    }

    return executeApply(options, policy, evidence, dependencies)
}

export async function readNewsletterRetentionJsonFile(
    path: string,
    privacy: 'public' | 'private',
): Promise<unknown> {
    const normalizedPath = normalizeAbsolutePath(path, 'input file')
    let handle: Awaited<ReturnType<typeof open>> | null = null
    let parent: BoundParentDirectory | null = null

    try {
        parent = await openBoundParentDirectory(normalizedPath)
        handle = await open(parent.boundFilePath, constants.O_RDONLY | constants.O_NOFOLLOW)
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_JSON_FILE_BYTES) {
            throw new Error('invalid file')
        }
        if (privacy === 'private') {
            if ((stat.mode & 0o077) !== 0) {
                throw new Error('invalid private mode')
            }
            if (stat.nlink !== 1) {
                throw new Error('invalid private link count')
            }
            const getuid = process.getuid
            if (typeof getuid === 'function' && stat.uid !== getuid.call(process)) {
                throw new Error('invalid private owner')
            }
        }

        const contents = await handle.readFile({ encoding: 'utf8' })
        return JSON.parse(contents) as unknown
    } catch {
        throw new NewsletterRetentionCliError(`newsletter retention ${privacy} input file is invalid`)
    } finally {
        await handle?.close().catch(() => undefined)
        await parent?.handle.close().catch(() => undefined)
    }
}

export async function writeNewsletterRetentionJsonFileExclusive(
    path: string,
    value: unknown,
    mode: 0o600 | 0o644,
): Promise<void> {
    const normalizedPath = normalizeAbsolutePath(path, 'output file')
    let handle: Awaited<ReturnType<typeof open>> | null = null
    let parent: BoundParentDirectory | null = null

    try {
        const serialized = `${JSON.stringify(value)}\n`
        const serializedBuffer = Buffer.from(serialized, 'utf8')
        if (serializedBuffer.byteLength > MAX_JSON_FILE_BYTES) {
            throw new Error('output too large')
        }

        const boundParent = await openBoundParentDirectory(normalizedPath)
        parent = boundParent
        handle = await open(
            `/proc/self/fd/${boundParent.handle.fd}`,
            constants.O_WRONLY | LINUX_O_TMPFILE,
            0o000,
        )
        await handle.writeFile(serializedBuffer)
        await handle.sync()
        await handle.chmod(mode)
        await handle.sync()

        const publication = await publishNewsletterRetentionOutput(handle, boundParent)
        if (publication === 'exists') {
            const exact = await existingNewsletterRetentionOutputIsExact(boundParent, serializedBuffer, mode)
            if (!exact) throw new Error('output path already exists with different content or metadata')
        }
        await boundParent.handle.sync()
    } catch (error) {
        if (error instanceof NewsletterRetentionCliError) throw error
        throw new NewsletterRetentionCliError('newsletter retention output file could not be created')
    } finally {
        await handle?.close().catch(() => undefined)
        await parent?.handle.close().catch(() => undefined)
    }
}

export async function writeNewsletterRetentionEscrowFileExclusive(
    path: string,
    producer: (writeChunk: (chunk: Uint8Array) => Promise<void>) => Promise<NewsletterRetentionEscrowDryRunResult>,
): Promise<NewsletterRetentionEscrowDryRunResult> {
    const normalizedPath = normalizeAbsolutePath(path, 'output file')
    let handle: Awaited<ReturnType<typeof open>> | null = null
    let parent: BoundParentDirectory | null = null

    try {
        parent = await openBoundParentDirectory(normalizedPath)
        handle = await open(
            `/proc/self/fd/${parent.handle.fd}`,
            constants.O_WRONLY | LINUX_O_TMPFILE,
            0o000,
        )
        const result = await producer(async (chunk) => {
            await handle!.writeFile(chunk)
        })
        await handle.sync()
        await handle.chmod(0o400)
        await handle.sync()
        const publication = await publishNewsletterRetentionOutput(handle, parent)
        if (publication !== 'published') {
            throw new Error('escrow output path already exists')
        }
        await parent.handle.sync()
        return result
    } catch {
        throw new NewsletterRetentionCliError('newsletter retention escrow output file could not be created')
    } finally {
        await handle?.close().catch(() => undefined)
        await parent?.handle.close().catch(() => undefined)
    }
}

export async function openVerifiedNewsletterRetentionEscrowSource(
    path: string,
): Promise<NewsletterRetentionClosableEscrowSource> {
    const normalizedPath = normalizeAbsolutePath(path, 'escrow file')
    let parent: BoundParentDirectory | null = null
    let handle: Awaited<ReturnType<typeof open>> | null = null

    try {
        parent = await openBoundParentDirectory(normalizedPath)
        handle = await open(
            parent.boundFilePath,
            constants.O_RDONLY | constants.O_NOFOLLOW,
        )
        const identity = await readEscrowFileIdentity(handle)
        const accumulator = createNewsletterRetentionEscrowAccumulator()
        for await (const line of iterateEscrowFileLines(handle)) {
            accumulator.consume(line)
        }
        const verification = accumulator.finalize()
        await assertEscrowFileIdentity(handle, identity)

        const recordIterator = iterateVerifiedEscrowRecords(handle)[Symbol.asyncIterator]()
        let nextManifestIndex = 0
        let pending: NewsletterRetentionEscrowRecord | null = null
        let closed = false
        const boundHandle = handle
        const boundParent = parent
        handle = null
        parent = null

        return {
            verification,
            async readBatchRecords({ manifestIndex }) {
                if (closed || manifestIndex !== nextManifestIndex) {
                    throw new Error('verified escrow source access is out of sequence')
                }
                await assertEscrowFileIdentity(boundHandle, identity)
                const records: NewsletterRetentionEscrowRecord[] = []
                let current = pending
                pending = null

                while (true) {
                    if (!current) {
                        const item = await recordIterator.next()
                        if (item.done) break
                        current = item.value
                    }
                    if (current.manifestIndex < manifestIndex) {
                        throw new Error('verified escrow source record order is invalid')
                    }
                    if (current.manifestIndex > manifestIndex) {
                        pending = current
                        break
                    }
                    records.push(current)
                    current = null
                }

                nextManifestIndex += 1
                await assertEscrowFileIdentity(boundHandle, identity)
                return records
            },
            async close() {
                if (closed) return
                closed = true
                await recordIterator.return?.(undefined)
                await boundHandle.close()
                await boundParent.handle.close()
            },
        }
    } catch {
        await handle?.close().catch(() => undefined)
        await parent?.handle.close().catch(() => undefined)
        throw new NewsletterRetentionCliError('newsletter retention escrow source is invalid')
    }
}

interface EscrowFileIdentity {
    dev: string
    ino: string
    size: number
    mtimeMs: number
    ctimeMs: number
}

async function readEscrowFileIdentity(
    handle: Awaited<ReturnType<typeof open>>,
): Promise<EscrowFileIdentity> {
    const stat = await handle.stat()
    const hardFileBytes = NEWSLETTER_RETENTION_ESCROW_MAX_TOTAL_BYTES + NEWSLETTER_RETENTION_ESCROW_MAX_RECORDS + 2
    if (
        !stat.isFile()
        || stat.nlink !== 1
        || stat.uid !== process.getuid?.()
        || (stat.mode & 0o777) !== 0o400
        || !Number.isSafeInteger(stat.size)
        || stat.size <= 0
        || stat.size > hardFileBytes
    ) {
        throw new Error('escrow file metadata is invalid')
    }
    return {
        dev: String(stat.dev),
        ino: String(stat.ino),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
    }
}

async function assertEscrowFileIdentity(
    handle: Awaited<ReturnType<typeof open>>,
    expected: EscrowFileIdentity,
): Promise<void> {
    const actual = await readEscrowFileIdentity(handle)
    if (
        actual.dev !== expected.dev
        || actual.ino !== expected.ino
        || actual.size !== expected.size
        || actual.mtimeMs !== expected.mtimeMs
        || actual.ctimeMs !== expected.ctimeMs
    ) {
        throw new Error('escrow file identity changed')
    }
}

async function* iterateVerifiedEscrowRecords(
    handle: Awaited<ReturnType<typeof open>>,
): AsyncGenerator<NewsletterRetentionEscrowRecord> {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let sawHeader = false
    let sawFooter = false
    for await (const line of iterateEscrowFileLines(handle)) {
        const value = JSON.parse(decoder.decode(line)) as unknown
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('escrow line is invalid')
        }
        const kind = (value as Record<string, unknown>).kind
        if (kind === 'header') {
            if (sawHeader || sawFooter) throw new Error('escrow header order is invalid')
            sawHeader = true
            continue
        }
        if (kind === 'footer') {
            if (!sawHeader || sawFooter) throw new Error('escrow footer order is invalid')
            sawFooter = true
            continue
        }
        if (!sawHeader || sawFooter) throw new Error('escrow record order is invalid')
        yield parseNewsletterRetentionEscrowRecord(value)
    }
    if (!sawHeader || !sawFooter) throw new Error('escrow framing is incomplete')
}

async function* iterateEscrowFileLines(
    handle: Awaited<ReturnType<typeof open>>,
): AsyncGenerator<Uint8Array> {
    const chunk = Buffer.allocUnsafe(65_536)
    let pending = Buffer.alloc(0)
    let position = 0
    let totalBytes = 0

    while (true) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
        if (bytesRead === 0) break
        position += bytesRead
        totalBytes += bytesRead
        if (totalBytes > NEWSLETTER_RETENTION_ESCROW_MAX_TOTAL_BYTES + NEWSLETTER_RETENTION_ESCROW_MAX_RECORDS + 2) {
            throw new Error('escrow file exceeds byte limit')
        }
        const combined = pending.length === 0
            ? Buffer.from(chunk.subarray(0, bytesRead))
            : Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        let start = 0
        for (let index = 0; index < combined.length; index += 1) {
            if (combined[index] !== 0x0a) continue
            const line = combined.subarray(start, index)
            if (line.length > NEWSLETTER_RETENTION_ESCROW_MAX_LINE_BYTES) {
                throw new Error('escrow line exceeds byte limit')
            }
            yield line
            start = index + 1
        }
        pending = Buffer.from(combined.subarray(start))
        if (pending.length > NEWSLETTER_RETENTION_ESCROW_MAX_LINE_BYTES) {
            throw new Error('escrow line exceeds byte limit')
        }
    }
    if (pending.length !== 0) {
        throw new Error('escrow file must end with newline')
    }
}

async function publishNewsletterRetentionOutput(
    source: Awaited<ReturnType<typeof open>>,
    parent: BoundParentDirectory,
): Promise<'published' | 'exists'> {
    let helperResult: number | null = null
    for (const helperPath of LINK_HELPER_PATHS) {
        try {
            helperResult = await runNewsletterRetentionLinkCommand(
                helperPath,
                [parent.fileName],
                source.fd,
                parent.handle.fd,
            )
            break
        } catch (error) {
            if (!isMissingExecutableError(error)) throw error
        }
    }

    if (helperResult === null) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('newsletter retention output publication helper is missing')
        }
        helperResult = await runNewsletterRetentionLinkCommand(
            '/bin/ln',
            [
                '-L',
                '--',
                '/proc/self/fd/3',
                `/proc/self/fd/4/${parent.fileName}`,
            ],
            source.fd,
            parent.handle.fd,
        )
        if (helperResult !== 0) {
            return 'exists'
        }
    }

    if (helperResult === 0) return 'published'
    if (helperResult === LINK_HELPER_DESTINATION_EXISTS) return 'exists'
    throw new Error('newsletter retention output publication failed')
}

async function runNewsletterRetentionLinkCommand(
    command: string,
    args: string[],
    sourceFd: number,
    parentFd: number,
): Promise<number> {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'ignore', 'ignore', sourceFd, parentFd],
        })
        child.once('error', rejectPromise)
        child.once('close', (code, signal) => {
            if (signal !== null || code === null) {
                rejectPromise(new Error('newsletter retention output publication helper failed'))
                return
            }
            resolvePromise(code)
        })
    })
}

async function existingNewsletterRetentionOutputIsExact(
    parent: BoundParentDirectory,
    expected: Buffer,
    mode: 0o600 | 0o644,
): Promise<boolean> {
    let existing: Awaited<ReturnType<typeof open>> | null = null
    try {
        existing = await open(parent.boundFilePath, constants.O_RDONLY | constants.O_NOFOLLOW)
        const stat = await existing.stat()
        const getuid = process.getuid
        const currentUid = typeof getuid === 'function' ? getuid.call(process) : null
        if (
            !stat.isFile()
            || stat.nlink !== 1
            || stat.size !== expected.byteLength
            || (stat.mode & 0o777) !== mode
            || (currentUid !== null && stat.uid !== currentUid)
        ) {
            return false
        }
        const contents = await existing.readFile()
        return contents.equals(expected)
    } catch {
        return false
    } finally {
        await existing?.close().catch(() => undefined)
    }
}

function isMissingExecutableError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function executeDryRunWithLock(
    options: ParsedCliOptions,
    policy: ReturnType<typeof parseNewsletterRetentionPolicy>,
    evidence: NewsletterRetentionEvidence,
    dependencies: NewsletterRetentionCliDependencies,
): Promise<NewsletterRetentionCliDryRunOutput> {
    let lease: Awaited<ReturnType<NewsletterRetentionApplyLockProvider['tryAcquire']>>
    try {
        lease = await dependencies.createLockProvider().tryAcquire(NEWSLETTER_RETENTION_APPLY_LOCK_KEY)
    } catch {
        throw new NewsletterRetentionCliError('newsletter retention lock acquisition failed')
    }
    if (!lease) {
        throw new NewsletterRetentionCliError('newsletter retention command is already running')
    }

    let output: NewsletterRetentionCliDryRunOutput | null = null
    let operationError: unknown
    try {
        output = await executeDryRun(options, policy, evidence, dependencies)
    } catch (error) {
        operationError = error
    }

    try {
        await lease.release()
    } catch {
        throw new NewsletterRetentionCliError('newsletter retention lock release failed')
    }
    if (operationError) {
        if (operationError instanceof NewsletterRetentionCliError) throw operationError
        throw new NewsletterRetentionCliError('newsletter retention dry-run failed')
    }
    if (!output) throw new NewsletterRetentionCliError()
    return output
}

async function executeDryRun(
    options: ParsedCliOptions,
    policy: ReturnType<typeof parseNewsletterRetentionPolicy>,
    evidence: NewsletterRetentionEvidence,
    dependencies: NewsletterRetentionCliDependencies,
): Promise<NewsletterRetentionCliDryRunOutput> {
    const records = await loadNewsletterRetentionCandidateRecords(dependencies.database, policy)
    const candidates = records.map((record) => ({
        siteId: record.siteId,
        batchId: record.batchId,
        createdAt: record.createdAt,
        messageCount: record.messageCount,
        notificationCount: record.notificationCount,
        errorCount: record.errorCount,
        orphanCount: record.orphanCount,
        correlationComplete: record.correlationComplete,
    }))
    let coordinated: NewsletterRetentionEscrowDryRunResult | null = null
    if (options.escrowOut) {
        const schemaFingerprint = await Promise.resolve(dependencies.schemaFingerprint())
        coordinated = await dependencies.writeEscrowFileExclusive(
            options.escrowOut,
            async (writeChunk) => buildNewsletterRetentionEscrowDryRunResult({
                policy,
                evidence,
                queueHealthy: evidence.health.queueHealthy,
                dlqHealthy: true,
                candidates: records,
                delegate: dependencies.database,
                schemaFingerprint,
                writeChunk,
            }),
        )
    }

    const plan = coordinated?.plan ?? buildNewsletterRetentionSelectionPlan({
        policy,
        evidence,
        queueHealthy: evidence.health.queueHealthy,
        dlqHealthy: true,
        candidates,
    })
    const manifest = coordinated?.manifest ?? buildNewsletterRetentionManifest({
        siteId: policy.siteId,
        cutoff: policy.cutoff,
        policyVersion: policy.policyVersion,
        batches: plan.batches.map((batch) => ({
            batchId: batch.batchId,
            createdAt: batch.createdAt,
            messageCount: batch.messageCount,
            notificationCount: batch.notificationCount,
            errorCount: batch.errorCount,
        })),
    })
    const escrow = coordinated?.escrow ?? null
    const artifact = options.privateArtifactOut && escrow
        ? buildNewsletterRetentionApplyArtifact({ manifest, escrow, records })
        : null

    if (options.privateArtifactOut && artifact) {
        await dependencies.writeJsonFileExclusive(options.privateArtifactOut, artifact, 0o600)
    }
    if (options.manifestOut) {
        await dependencies.writeJsonFileExclusive(options.manifestOut, manifest, 0o644)
    }

    return {
        mode: 'dry-run',
        dryRun: true,
        siteId: policy.siteId,
        cutoff: policy.cutoff,
        policyVersion: policy.policyVersion,
        batchCount: plan.batchCount,
        totals: plan.totals,
        manifest,
        escrow: {
            written: escrow !== null,
            contentHash: escrow?.contentHash ?? null,
            schemaFingerprint: escrow?.schemaFingerprint ?? null,
        },
        privateArtifact: {
            written: artifact !== null,
            hash: artifact?.hash ?? null,
        },
    }
}

async function executeApply(
    options: ParsedCliOptions,
    policy: ReturnType<typeof parseNewsletterRetentionPolicy>,
    evidence: NewsletterRetentionEvidence,
    dependencies: NewsletterRetentionCliDependencies,
): Promise<NewsletterRetentionCliApplyOutput> {
    const manifest = await dependencies.readJsonFile(options.manifestFile!, 'public')
    const rawArtifact = await dependencies.readJsonFile(options.privateArtifactFile!, 'private')
    const manifestHash = readExpectedObjectHash(manifest, 'manifest')
    const artifactHash = readExpectedObjectHash(rawArtifact, 'artifact')

    if (manifestHash !== options.expectedManifestHash || artifactHash !== options.expectedArtifactHash) {
        throw new NewsletterRetentionCliError('newsletter retention expected hash confirmation failed')
    }

    let artifact: ReturnType<typeof parseNewsletterRetentionApplyArtifact>
    try {
        artifact = parseNewsletterRetentionApplyArtifact(rawArtifact)
    } catch {
        throw new NewsletterRetentionCliError('newsletter retention private artifact is invalid')
    }
    if (artifact.escrow.contentHash !== options.expectedEscrowContentHash) {
        throw new NewsletterRetentionCliError('newsletter retention escrow content hash confirmation failed')
    }

    let source: NewsletterRetentionClosableEscrowSource | null = null
    let receipt: NewsletterRetentionApplyReceipt | null = null
    let operationError: unknown
    try {
        source = await dependencies.openVerifiedEscrowSource(options.escrowFile!)
        const verification = parseNewsletterRetentionEscrowVerificationResult(source.verification)
        if (verification.contentHash !== options.expectedEscrowContentHash) {
            throw new NewsletterRetentionCliError('newsletter retention verified escrow hash mismatch')
        }
        receipt = await executeNewsletterRetentionApply({
            policy: {
                siteId: policy.siteId,
                cutoff: policy.cutoff,
                apply: true,
                maxBatches: policy.maxBatches,
                maxMessages: policy.maxMessages,
            },
            evidence,
            manifest,
            artifact,
            escrowSource: source,
            lock: dependencies.createLockProvider(),
            database: dependencies.database,
        })
    } catch (error) {
        operationError = error
    } finally {
        try {
            await source?.close()
        } catch {
            if (!operationError) {
                operationError = new NewsletterRetentionCliError('newsletter retention escrow source close failed')
            }
        }
    }
    if (operationError) throw operationError
    if (!receipt) throw new NewsletterRetentionCliError('newsletter retention apply failed')

    return {
        mode: 'apply',
        dryRun: false,
        receipt,
    }
}

function parseCliOptions(argv: readonly string[]): ParsedCliOptions {
    if (!Array.isArray(argv)) {
        throw new NewsletterRetentionCliError('newsletter retention arguments are invalid')
    }

    const flags = new Map<string, string | true>()
    const booleanFlags = new Set(['--apply'])
    const valueFlags = new Set([
        '--site-id',
        '--cutoff',
        '--max-batches',
        '--max-messages',
        '--evidence-file',
        '--manifest-out',
        '--private-artifact-out',
        '--escrow-out',
        '--manifest-file',
        '--private-artifact-file',
        '--escrow-file',
        '--expected-manifest-hash',
        '--expected-artifact-hash',
        '--expected-escrow-content-hash',
        '--confirm-site-id',
    ])

    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index]
        if (!booleanFlags.has(flag) && !valueFlags.has(flag)) {
            throw new NewsletterRetentionCliError('newsletter retention argument is unknown')
        }
        if (flags.has(flag)) {
            throw new NewsletterRetentionCliError('newsletter retention argument is duplicated')
        }
        if (booleanFlags.has(flag)) {
            flags.set(flag, true)
            continue
        }

        const value = argv[index + 1]
        if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
            throw new NewsletterRetentionCliError('newsletter retention argument value is missing')
        }
        flags.set(flag, value)
        index += 1
    }

    const apply = flags.get('--apply') === true
    const siteId = requireStringFlag(flags, '--site-id')
    const cutoff = requireStringFlag(flags, '--cutoff')
    const evidenceFile = requireAbsolutePathFlag(flags, '--evidence-file')
    const options: ParsedCliOptions = {
        apply,
        siteId,
        cutoff,
        evidenceFile,
        maxBatches: optionalPositiveIntegerFlag(flags, '--max-batches'),
        maxMessages: optionalPositiveIntegerFlag(flags, '--max-messages'),
        manifestOut: optionalAbsolutePathFlag(flags, '--manifest-out'),
        privateArtifactOut: optionalAbsolutePathFlag(flags, '--private-artifact-out'),
        escrowOut: optionalAbsolutePathFlag(flags, '--escrow-out'),
        manifestFile: optionalAbsolutePathFlag(flags, '--manifest-file'),
        privateArtifactFile: optionalAbsolutePathFlag(flags, '--private-artifact-file'),
        escrowFile: optionalAbsolutePathFlag(flags, '--escrow-file'),
        expectedManifestHash: optionalHashFlag(flags, '--expected-manifest-hash'),
        expectedArtifactHash: optionalHashFlag(flags, '--expected-artifact-hash'),
        expectedEscrowContentHash: optionalHashFlag(flags, '--expected-escrow-content-hash'),
        confirmSiteId: optionalStringFlag(flags, '--confirm-site-id'),
    }

    validateModeSpecificOptions(options)
    return options
}

function validateModeSpecificOptions(options: ParsedCliOptions): void {
    if (!options.apply) {
        if (
            options.manifestFile
            || options.privateArtifactFile
            || options.escrowFile
            || options.expectedManifestHash
            || options.expectedArtifactHash
            || options.expectedEscrowContentHash
            || options.confirmSiteId
        ) {
            throw new NewsletterRetentionCliError('apply-only arguments require --apply')
        }
        if (options.privateArtifactOut && !options.escrowOut) {
            throw new NewsletterRetentionCliError('private artifact output requires escrow output')
        }
        ensureDistinctPaths([options.evidenceFile, options.manifestOut, options.privateArtifactOut, options.escrowOut])
        return
    }

    if (options.manifestOut || options.privateArtifactOut || options.escrowOut) {
        throw new NewsletterRetentionCliError('dry-run output arguments cannot be used with --apply')
    }
    if (
        !options.manifestFile
        || !options.privateArtifactFile
        || !options.escrowFile
        || !options.expectedManifestHash
        || !options.expectedArtifactHash
        || !options.expectedEscrowContentHash
        || !options.confirmSiteId
    ) {
        throw new NewsletterRetentionCliError(
            'apply requires manifest, private artifact, escrow, expected hashes, and tenant confirmation',
        )
    }
    if (options.confirmSiteId !== options.siteId) {
        throw new NewsletterRetentionCliError('apply tenant confirmation does not match siteId')
    }
    ensureDistinctPaths([options.evidenceFile, options.manifestFile, options.privateArtifactFile, options.escrowFile])
}

function parseCliEvidence(value: unknown, now: string): NewsletterRetentionEvidence {
    if (!isPlainObject(value)) {
        throw new NewsletterRetentionCliError('newsletter retention evidence file is invalid')
    }

    const dlq = value.dlq
    if (!isPlainObject(dlq) || dlq.healthy !== true) {
        throw new NewsletterRetentionCliError('newsletter retention DLQ evidence is invalid')
    }
    const nowMs = Date.parse(now)
    const dlqCheckedAtMs = parseStrictUtcTimestamp(dlq.checkedAt, 'DLQ evidence')
    if (dlqCheckedAtMs > nowMs || nowMs - dlqCheckedAtMs > MAX_DLQ_EVIDENCE_AGE_MS) {
        throw new NewsletterRetentionCliError('newsletter retention DLQ evidence is stale')
    }

    try {
        return parseNewsletterRetentionEvidence({
            now,
            backup: value.backup as NewsletterRetentionEvidenceInput['backup'],
            restore: value.restore as NewsletterRetentionEvidenceInput['restore'],
            health: value.health as NewsletterRetentionEvidenceInput['health'],
        })
    } catch {
        throw new NewsletterRetentionCliError('newsletter retention operational evidence is invalid or stale')
    }
}

function normalizeNow(value: unknown): string {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new NewsletterRetentionCliError('newsletter retention current time is invalid')
    }
    return value.toISOString()
}

function parseStrictUtcTimestamp(value: unknown, field: string): number {
    if (typeof value !== 'string' || !UTC_ISO_8601_MS.test(value)) {
        throw new NewsletterRetentionCliError(`${field} timestamp is invalid`)
    }
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
        throw new NewsletterRetentionCliError(`${field} timestamp is invalid`)
    }
    return timestamp
}

function readExpectedObjectHash(value: unknown, field: string): string {
    if (!isPlainObject(value) || typeof value.hash !== 'string' || !SHA_256_HEX.test(value.hash)) {
        throw new NewsletterRetentionCliError(`newsletter retention ${field} file hash is invalid`)
    }
    return value.hash
}

function requireStringFlag(flags: Map<string, string | true>, flag: string): string {
    const value = flags.get(flag)
    if (typeof value !== 'string' || value.length === 0) {
        throw new NewsletterRetentionCliError('newsletter retention required argument is missing')
    }
    return value
}

function optionalStringFlag(flags: Map<string, string | true>, flag: string): string | undefined {
    const value = flags.get(flag)
    return typeof value === 'string' ? value : undefined
}

function requireAbsolutePathFlag(flags: Map<string, string | true>, flag: string): string {
    return normalizeAbsolutePath(requireStringFlag(flags, flag), 'argument path')
}

function optionalAbsolutePathFlag(flags: Map<string, string | true>, flag: string): string | undefined {
    const value = optionalStringFlag(flags, flag)
    return value === undefined ? undefined : normalizeAbsolutePath(value, 'argument path')
}

function optionalPositiveIntegerFlag(flags: Map<string, string | true>, flag: string): number | undefined {
    const value = optionalStringFlag(flags, flag)
    if (value === undefined) return undefined
    if (!/^[1-9]\d*$/.test(value)) {
        throw new NewsletterRetentionCliError('newsletter retention numeric argument is invalid')
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
        throw new NewsletterRetentionCliError('newsletter retention numeric argument is invalid')
    }
    return parsed
}

function optionalHashFlag(flags: Map<string, string | true>, flag: string): string | undefined {
    const value = optionalStringFlag(flags, flag)
    if (value !== undefined && !SHA_256_HEX.test(value)) {
        throw new NewsletterRetentionCliError('newsletter retention expected hash argument is invalid')
    }
    return value
}

function normalizeAbsolutePath(value: unknown, field: string): string {
    if (
        typeof value !== 'string'
        || value.length === 0
        || value.trim() !== value
        || !isAbsolute(value)
        || resolve(value) !== value
    ) {
        throw new NewsletterRetentionCliError(`newsletter retention ${field} must be an absolute path`)
    }
    return value
}

function ensureDistinctPaths(paths: Array<string | undefined>): void {
    const present = paths.filter((path): path is string => path !== undefined)
    if (new Set(present).size !== present.length) {
        throw new NewsletterRetentionCliError('newsletter retention file paths must be distinct')
    }
}

interface BoundParentDirectory {
    handle: Awaited<ReturnType<typeof open>>
    boundFilePath: string
    fileName: string
}

async function openBoundParentDirectory(path: string): Promise<BoundParentDirectory> {
    const fileName = basename(path)
    if (!fileName || fileName === '.' || fileName === '..' || fileName.includes(sep)) {
        throw new Error('file name is invalid')
    }

    const components = dirname(path).split(sep).filter((component) => component.length > 0)
    const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    let current = await open(sep, directoryFlags)
    try {
        await validateSecureDirectoryHandle(current)
        for (const component of components) {
            const next = await open(`/proc/self/fd/${current.fd}/${component}`, directoryFlags)
            try {
                await validateSecureDirectoryHandle(next)
            } catch (error) {
                await next.close().catch(() => undefined)
                throw error
            }
            await current.close()
            current = next
        }

        return {
            handle: current,
            boundFilePath: `/proc/self/fd/${current.fd}/${fileName}`,
            fileName,
        }
    } catch (error) {
        await current.close().catch(() => undefined)
        throw error
    }
}

async function validateSecureDirectoryHandle(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
    const stat = await handle.stat()
    if (!stat.isDirectory()) {
        throw new Error('parent path must contain only directories')
    }
    const getuid = process.getuid
    const currentUid = typeof getuid === 'function' ? getuid.call(process) : null
    const groupOrOtherWritable = (stat.mode & 0o022) !== 0
    const rootOwnedStickyDirectory = stat.uid === 0 && (stat.mode & 0o1000) !== 0
    if (groupOrOtherWritable && !rootOwnedStickyDirectory) {
        throw new Error('parent path permissions are unsafe')
    }
    if (currentUid !== null && stat.uid !== 0 && stat.uid !== currentUid) {
        throw new Error('parent path owner is unsafe')
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}
