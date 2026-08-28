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
    type NewsletterRetentionApplyArtifact,
} from './newsletter-retention-apply.js'
import {
    NEWSLETTER_RETENTION_APPLY_LOCK_KEY,
    executeNewsletterRetentionApply,
    type NewsletterRetentionApplyDatabase,
    type NewsletterRetentionApplyLockProvider,
    type NewsletterRetentionApplyReceipt,
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

export type NewsletterRetentionCliDatabase = NewsletterRetentionCandidateLoaderDelegate & NewsletterRetentionApplyDatabase

export interface NewsletterRetentionCliDependencies {
    database: NewsletterRetentionCliDatabase
    createLockProvider(): NewsletterRetentionApplyLockProvider
    now(): Date
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
    manifestFile?: string
    privateArtifactFile?: string
    expectedManifestHash?: string
    expectedArtifactHash?: string
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
    const plan = buildNewsletterRetentionSelectionPlan({
        policy,
        evidence,
        queueHealthy: evidence.health.queueHealthy,
        dlqHealthy: true,
        candidates,
    })
    const manifest = buildNewsletterRetentionManifest({
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

    let artifact: NewsletterRetentionApplyArtifact | null = null
    if (options.privateArtifactOut) {
        artifact = buildNewsletterRetentionApplyArtifact({ manifest, records })
    }

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
    const artifact = await dependencies.readJsonFile(options.privateArtifactFile!, 'private')
    const manifestHash = readExpectedObjectHash(manifest, 'manifest')
    const artifactHash = readExpectedObjectHash(artifact, 'artifact')

    if (manifestHash !== options.expectedManifestHash || artifactHash !== options.expectedArtifactHash) {
        throw new NewsletterRetentionCliError('newsletter retention expected hash confirmation failed')
    }

    const receipt = await executeNewsletterRetentionApply({
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
        lock: dependencies.createLockProvider(),
        database: dependencies.database,
    })

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
        '--manifest-file',
        '--private-artifact-file',
        '--expected-manifest-hash',
        '--expected-artifact-hash',
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
        manifestFile: optionalAbsolutePathFlag(flags, '--manifest-file'),
        privateArtifactFile: optionalAbsolutePathFlag(flags, '--private-artifact-file'),
        expectedManifestHash: optionalHashFlag(flags, '--expected-manifest-hash'),
        expectedArtifactHash: optionalHashFlag(flags, '--expected-artifact-hash'),
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
            || options.expectedManifestHash
            || options.expectedArtifactHash
            || options.confirmSiteId
        ) {
            throw new NewsletterRetentionCliError('apply-only arguments require --apply')
        }
        ensureDistinctPaths([options.evidenceFile, options.manifestOut, options.privateArtifactOut])
        return
    }

    if (options.manifestOut || options.privateArtifactOut) {
        throw new NewsletterRetentionCliError('dry-run output arguments cannot be used with --apply')
    }
    if (
        !options.manifestFile
        || !options.privateArtifactFile
        || !options.expectedManifestHash
        || !options.expectedArtifactHash
        || !options.confirmSiteId
    ) {
        throw new NewsletterRetentionCliError('apply requires manifest, private artifact, expected hashes, and tenant confirmation')
    }
    if (options.confirmSiteId !== options.siteId) {
        throw new NewsletterRetentionCliError('apply tenant confirmation does not match siteId')
    }
    ensureDistinctPaths([options.evidenceFile, options.manifestFile, options.privateArtifactFile])
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
