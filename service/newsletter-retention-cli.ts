import { constants } from 'node:fs'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

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
    executeNewsletterRetentionApply,
    type NewsletterRetentionApplyDatabase,
    type NewsletterRetentionApplyLockProvider,
    type NewsletterRetentionApplyReceipt,
} from './newsletter-retention-applier.js'

const MAX_JSON_FILE_BYTES = 1_048_576
const MAX_DLQ_EVIDENCE_AGE_MS = 15 * 60_000
const UTC_ISO_8601_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SHA_256_HEX = /^[a-f0-9]{64}$/

export type NewsletterRetentionCliDatabase = NewsletterRetentionCandidateLoaderDelegate & NewsletterRetentionApplyDatabase

export interface NewsletterRetentionCliDependencies {
    database: NewsletterRetentionCliDatabase
    createLockProvider(): NewsletterRetentionApplyLockProvider
    now(): Date
    readJsonFile(path: string, privacy: 'public' | 'private'): Promise<unknown>
    writeJsonFileExclusive(path: string, value: unknown, mode: 0o600 | 0o644): Promise<void>
    removeOutputFile(path: string): Promise<void>
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
        return executeDryRun(options, policy, evidence, dependencies)
    }

    return executeApply(options, policy, evidence, dependencies)
}

export async function readNewsletterRetentionJsonFile(
    path: string,
    privacy: 'public' | 'private',
): Promise<unknown> {
    const normalizedPath = normalizeAbsolutePath(path, 'input file')
    let handle: Awaited<ReturnType<typeof open>> | null = null

    try {
        await validateSecureParentPath(normalizedPath)
        handle = await open(normalizedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
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
    }
}

export async function writeNewsletterRetentionJsonFileExclusive(
    path: string,
    value: unknown,
    mode: 0o600 | 0o644,
): Promise<void> {
    const normalizedPath = normalizeAbsolutePath(path, 'output file')
    let handle: Awaited<ReturnType<typeof open>> | null = null
    let created = false

    try {
        await validateSecureParentPath(normalizedPath)
        const serialized = `${JSON.stringify(value)}\n`
        if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_FILE_BYTES) {
            throw new Error('output too large')
        }

        handle = await open(
            normalizedPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            mode,
        )
        created = true
        await handle.writeFile(serialized, { encoding: 'utf8' })
        await handle.sync()
        await handle.chmod(mode)
    } catch {
        if (created) {
            await handle?.close().catch(() => undefined)
            handle = null
            try {
                await unlink(normalizedPath)
            } catch {
                throw new NewsletterRetentionCliError('newsletter retention output rollback failed')
            }
        }
        throw new NewsletterRetentionCliError('newsletter retention output file could not be created')
    } finally {
        await handle?.close().catch(() => undefined)
    }
}

export async function removeNewsletterRetentionOutputFile(path: string): Promise<void> {
    const normalizedPath = normalizeAbsolutePath(path, 'output file')
    try {
        await validateSecureParentPath(normalizedPath)
        await unlink(normalizedPath)
    } catch {
        throw new NewsletterRetentionCliError('newsletter retention output rollback failed')
    }
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

    const writtenPaths: string[] = []
    try {
        if (options.manifestOut) {
            await dependencies.writeJsonFileExclusive(options.manifestOut, manifest, 0o644)
            writtenPaths.push(options.manifestOut)
        }
        if (options.privateArtifactOut && artifact) {
            await dependencies.writeJsonFileExclusive(options.privateArtifactOut, artifact, 0o600)
            writtenPaths.push(options.privateArtifactOut)
        }
    } catch (error) {
        for (const path of writtenPaths.reverse()) {
            try {
                await dependencies.removeOutputFile(path)
            } catch {
                throw new NewsletterRetentionCliError('newsletter retention output rollback failed')
            }
        }
        throw error
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

async function validateSecureParentPath(path: string): Promise<void> {
    let current = dirname(path)
    if (await realpath(current) !== current) {
        throw new Error('parent path must not contain symbolic links')
    }

    const getuid = process.getuid
    const currentUid = typeof getuid === 'function' ? getuid.call(process) : null
    while (true) {
        const stat = await lstat(current)
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('parent path must contain only directories')
        }

        const groupOrOtherWritable = (stat.mode & 0o022) !== 0
        const rootOwnedStickyDirectory = stat.uid === 0 && (stat.mode & 0o1000) !== 0
        if (groupOrOtherWritable && !rootOwnedStickyDirectory) {
            throw new Error('parent path permissions are unsafe')
        }
        if (currentUid !== null && stat.uid !== 0 && stat.uid !== currentUid) {
            throw new Error('parent path owner is unsafe')
        }

        const parent = dirname(current)
        if (parent === current) return
        current = parent
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}
