import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildNewsletterRetentionManifest } from '@/service/newsletter-retention'
import { buildNewsletterRetentionApplyArtifact } from '@/service/newsletter-retention-apply'
import {
    executeNewsletterRetentionCli,
    readNewsletterRetentionJsonFile,
    writeNewsletterRetentionJsonFileExclusive,
    type NewsletterRetentionCliDatabase,
    type NewsletterRetentionCliDependencies,
} from '@/service/newsletter-retention-cli'
import type { NewsletterRetentionApplyLockProvider } from '@/service/newsletter-retention-applier'

const NOW = new Date('2026-08-28T12:00:00.000Z')
const SITE_ID = 'tenant-a'
const CUTOFF = '2026-08-27T12:00:00.000Z'
const EVIDENCE_PATH = '/safe/evidence.json'
const MANIFEST_PATH = '/safe/manifest.json'
const ARTIFACT_PATH = '/safe/private-artifact.json'
const MANIFEST_OUT_PATH = '/safe/output-manifest.json'
const ARTIFACT_OUT_PATH = '/safe/output-artifact.json'

const evidence = {
    now: '1900-01-01T00:00:00.000Z',
    backup: {
        verifiedAt: '2026-08-28T11:00:00.000Z',
        restoredAt: '2026-08-28T11:05:00.000Z',
    },
    restore: {
        verifiedAt: '2026-08-28T11:10:00.000Z',
        restoredAt: '2026-08-28T11:15:00.000Z',
    },
    health: {
        queueCheckedAt: '2026-08-28T11:55:00.000Z',
        proxyCheckedAt: '2026-08-28T11:56:00.000Z',
        queueHealthy: true,
        proxyHealthy: true,
    },
    dlq: {
        checkedAt: '2026-08-28T11:57:00.000Z',
        healthy: true,
    },
}

const privateRecord = {
    siteId: SITE_ID,
    batchRecordId: 'private-row-id',
    batchId: 'public-batch-id',
    createdAt: '2026-08-27T10:00:00.000Z',
    messageCount: 1,
    notificationCount: 2,
    errorCount: 1,
    orphanCount: 0,
    correlationComplete: true,
}

function makeDatabase() {
    const tx = {
        newsletterBatch: {
            findFirst: vi.fn(async () => ({
                id: privateRecord.batchRecordId,
                siteId: SITE_ID,
                batchId: privateRecord.batchId,
                created: new Date(privateRecord.createdAt),
                _count: { NewslettersMessages: 1, NewslettersErrors: 1 },
            })),
            deleteMany: vi.fn(async () => ({ count: 1 })),
            count: vi.fn(async () => 0),
        },
        newsletterMessages: {
            findMany: vi.fn(async () => [{ messageId: 'private-message-id', _count: { notificationEvents: 2 } }]),
            deleteMany: vi.fn(async () => ({ count: 1 })),
            count: vi.fn(async () => 0),
        },
        newsletterErrors: {
            deleteMany: vi.fn(async () => ({ count: 1 })),
            count: vi.fn(async () => 0),
        },
        newsletterNotifications: {
            deleteMany: vi.fn(async () => ({ count: 2 })),
            count: vi.fn(async () => 0),
        },
        newsletterNotificationOrphan: {
            count: vi.fn(async () => 0),
        },
    }
    const transaction = vi.fn(async (work: (delegate: typeof tx) => Promise<unknown>) => work(tx))
    const database = {
        newsletterBatch: {
            findMany: vi.fn(async () => [{
                id: privateRecord.batchRecordId,
                batchId: privateRecord.batchId,
                created: new Date(privateRecord.createdAt),
                _count: { NewslettersErrors: 1, NewslettersMessages: 1 },
            }]),
        },
        newsletterMessages: {
            findMany: vi.fn(async () => [{ messageId: 'private-message-id', _count: { notificationEvents: 2 } }]),
        },
        newsletterNotificationOrphan: {
            count: vi.fn(async () => 0),
        },
        $transaction: transaction,
    } as unknown as NewsletterRetentionCliDatabase

    return { database, transaction, tx }
}

function makeDependencies(files: Record<string, unknown> = { [EVIDENCE_PATH]: evidence }) {
    const { database, transaction, tx } = makeDatabase()
    const release = vi.fn(async () => undefined)
    const tryAcquire = vi.fn(async (): Promise<{ release: typeof release } | null> => ({ release }))
    const lock: NewsletterRetentionApplyLockProvider = { tryAcquire }
    const createLockProvider = vi.fn(() => lock)
    const readJsonFile = vi.fn(async (path: string) => {
        if (!(path in files)) throw new Error('missing fake file')
        return files[path]
    })
    const writeJsonFileExclusive = vi.fn(async (
        path: string,
        value: unknown,
        mode: 0o600 | 0o644,
    ) => {
        void path
        void value
        void mode
    })
    const removeOutputFile = vi.fn(async (path: string) => {
        void path
    })
    const dependencies: NewsletterRetentionCliDependencies = {
        database,
        createLockProvider,
        now: () => new Date(NOW),
        readJsonFile,
        writeJsonFileExclusive,
        removeOutputFile,
    }
    return {
        dependencies,
        database,
        transaction,
        tx,
        release,
        tryAcquire,
        createLockProvider,
        readJsonFile,
        writeJsonFileExclusive,
        removeOutputFile,
    }
}

function baseArgs(): string[] {
    return [
        '--site-id', SITE_ID,
        '--cutoff', CUTOFF,
        '--max-batches', '3',
        '--max-messages', '20',
        '--evidence-file', EVIDENCE_PATH,
    ]
}

function makeApplyFiles() {
    const manifest = buildNewsletterRetentionManifest({
        siteId: SITE_ID,
        cutoff: CUTOFF,
        batches: [privateRecord],
    })
    const artifact = buildNewsletterRetentionApplyArtifact({ manifest, records: [privateRecord] })
    return { manifest, artifact }
}

const temporaryDirectories: string[] = []
afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('newsletter retention CLI engine', () => {
    it('defaults to dry-run, reads candidates only, and emits no private record or message IDs', async () => {
        const harness = makeDependencies()

        const output = await executeNewsletterRetentionCli(baseArgs(), harness.dependencies)

        expect(output.mode).toBe('dry-run')
        expect(output.dryRun).toBe(true)
        expect(harness.transaction).not.toHaveBeenCalled()
        expect(harness.createLockProvider).toHaveBeenCalledOnce()
        expect(harness.tryAcquire).toHaveBeenCalledWith('newsletter-retention-apply')
        expect(harness.release).toHaveBeenCalledOnce()
        expect(harness.writeJsonFileExclusive).not.toHaveBeenCalled()
        expect(JSON.stringify(output)).not.toContain(privateRecord.batchRecordId)
        expect(JSON.stringify(output)).not.toContain('private-message-id')
    })

    it('refuses an overlapping dry-run before candidate loading or output writes', async () => {
        const harness = makeDependencies()
        harness.tryAcquire.mockResolvedValueOnce(null)

        await expect(executeNewsletterRetentionCli(baseArgs(), harness.dependencies)).rejects.toThrow(
            'newsletter retention command is already running',
        )

        expect(harness.database.newsletterBatch.findMany).not.toHaveBeenCalled()
        expect(harness.writeJsonFileExclusive).not.toHaveBeenCalled()
        expect(harness.release).not.toHaveBeenCalled()
    })

    it('releases the dry-run lock when candidate loading fails', async () => {
        const harness = makeDependencies()
        vi.mocked(harness.database.newsletterBatch.findMany).mockRejectedValueOnce(new Error('SECRET_DATABASE_ERROR'))

        await expect(executeNewsletterRetentionCli(baseArgs(), harness.dependencies)).rejects.toThrow(
            'newsletter retention dry-run failed',
        )

        expect(harness.release).toHaveBeenCalledOnce()
    })

    it('writes public and private dry-run artifacts with separate modes and keeps private IDs out of output', async () => {
        const harness = makeDependencies()
        const args = [
            ...baseArgs(),
            '--manifest-out', MANIFEST_OUT_PATH,
            '--private-artifact-out', ARTIFACT_OUT_PATH,
        ]

        const output = await executeNewsletterRetentionCli(args, harness.dependencies)

        expect(harness.writeJsonFileExclusive).toHaveBeenCalledTimes(2)
        expect(harness.writeJsonFileExclusive.mock.calls[0][0]).toBe(MANIFEST_OUT_PATH)
        expect(harness.writeJsonFileExclusive.mock.calls[0][2]).toBe(0o644)
        expect(harness.writeJsonFileExclusive.mock.calls[1][0]).toBe(ARTIFACT_OUT_PATH)
        expect(harness.writeJsonFileExclusive.mock.calls[1][2]).toBe(0o600)
        expect(JSON.stringify(harness.writeJsonFileExclusive.mock.calls[1][1])).toContain(privateRecord.batchRecordId)
        expect(JSON.stringify(output)).not.toContain(privateRecord.batchRecordId)
        if (output.mode !== 'dry-run') throw new Error('expected dry-run output')
        expect(output.privateArtifact.written).toBe(true)
        expect(output.privateArtifact.hash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('preserves the loader exact-ID tie-break when public batch fields are identical', async () => {
        const harness = makeDependencies()
        vi.mocked(harness.database.newsletterBatch.findMany).mockResolvedValueOnce([
            {
                id: 'row-z',
                batchId: 'same-public-batch',
                created: new Date('2026-08-27T10:00:00.000Z'),
                _count: { NewslettersErrors: 0, NewslettersMessages: 0 },
            },
            {
                id: 'row-a',
                batchId: 'same-public-batch',
                created: new Date('2026-08-27T10:00:00.000Z'),
                _count: { NewslettersErrors: 0, NewslettersMessages: 0 },
            },
        ])

        const output = await executeNewsletterRetentionCli(
            [...baseArgs(), '--private-artifact-out', ARTIFACT_OUT_PATH],
            harness.dependencies,
        )

        const privateArtifact = harness.writeJsonFileExclusive.mock.calls[0][1] as {
            bindings: Array<{ manifestIndex: number; batchRecordId: string }>
        }
        expect(privateArtifact.bindings).toEqual([
            { manifestIndex: 0, batchRecordId: 'row-a' },
            { manifestIndex: 1, batchRecordId: 'row-z' },
        ])
        expect(JSON.stringify(output)).not.toContain('row-a')
        expect(JSON.stringify(output)).not.toContain('row-z')
    })

    it('rejects colliding file paths before reading evidence or candidates', async () => {
        const harness = makeDependencies()

        await expect(executeNewsletterRetentionCli([
            ...baseArgs(),
            '--manifest-out', MANIFEST_OUT_PATH,
            '--private-artifact-out', MANIFEST_OUT_PATH,
        ], harness.dependencies)).rejects.toThrow('newsletter retention file paths must be distinct')

        expect(harness.readJsonFile).not.toHaveBeenCalled()
        expect(harness.database.newsletterBatch.findMany).not.toHaveBeenCalled()
    })

    it('rolls back the first dry-run output when the paired private write fails', async () => {
        const harness = makeDependencies()
        harness.writeJsonFileExclusive
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('second write failed'))

        await expect(executeNewsletterRetentionCli([
            ...baseArgs(),
            '--manifest-out', MANIFEST_OUT_PATH,
            '--private-artifact-out', ARTIFACT_OUT_PATH,
        ], harness.dependencies)).rejects.toThrow('newsletter retention dry-run failed')

        expect(harness.removeOutputFile).toHaveBeenCalledOnce()
        expect(harness.removeOutputFile).toHaveBeenCalledWith(MANIFEST_OUT_PATH)
    })

    it('fails closed when paired-output rollback cannot remove the first file', async () => {
        const harness = makeDependencies()
        harness.writeJsonFileExclusive
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('second write failed'))
        harness.removeOutputFile.mockRejectedValueOnce(new Error('remove failed'))

        await expect(executeNewsletterRetentionCli([
            ...baseArgs(),
            '--manifest-out', MANIFEST_OUT_PATH,
            '--private-artifact-out', ARTIFACT_OUT_PATH,
        ], harness.dependencies)).rejects.toThrow('newsletter retention output rollback failed')
    })

    it('requires all apply confirmations before reading files or touching the database', async () => {
        const harness = makeDependencies()
        const incomplete = [...baseArgs(), '--apply']

        await expect(executeNewsletterRetentionCli(incomplete, harness.dependencies)).rejects.toThrow(
            'apply requires manifest, private artifact, expected hashes, and tenant confirmation',
        )
        expect(harness.readJsonFile).not.toHaveBeenCalled()
        expect(harness.transaction).not.toHaveBeenCalled()
        expect(harness.createLockProvider).not.toHaveBeenCalled()
    })

    it('rejects tenant-confirmation mismatch before file reads', async () => {
        const { manifest, artifact } = makeApplyFiles()
        const harness = makeDependencies()
        const args = applyArgs(manifest.hash, artifact.hash)
        args[args.indexOf('--confirm-site-id') + 1] = 'other-tenant'

        await expect(executeNewsletterRetentionCli(args, harness.dependencies)).rejects.toThrow(
            'apply tenant confirmation does not match siteId',
        )
        expect(harness.readJsonFile).not.toHaveBeenCalled()
    })

    it('rejects expected-hash mismatch before lock acquisition or transaction', async () => {
        const { manifest, artifact } = makeApplyFiles()
        const harness = makeDependencies({
            [EVIDENCE_PATH]: evidence,
            [MANIFEST_PATH]: manifest,
            [ARTIFACT_PATH]: artifact,
        })
        const args = applyArgs('0'.repeat(64), artifact.hash)

        await expect(executeNewsletterRetentionCli(args, harness.dependencies)).rejects.toThrow(
            'newsletter retention expected hash confirmation failed',
        )
        expect(harness.createLockProvider).not.toHaveBeenCalled()
        expect(harness.transaction).not.toHaveBeenCalled()
    })

    it('applies only with exact confirmations and returns a privacy-safe receipt', async () => {
        const { manifest, artifact } = makeApplyFiles()
        const harness = makeDependencies({
            [EVIDENCE_PATH]: evidence,
            [MANIFEST_PATH]: manifest,
            [ARTIFACT_PATH]: artifact,
        })

        const output = await executeNewsletterRetentionCli(applyArgs(manifest.hash, artifact.hash), harness.dependencies)

        expect(output.mode).toBe('apply')
        expect(output.dryRun).toBe(false)
        expect(harness.readJsonFile).toHaveBeenNthCalledWith(1, EVIDENCE_PATH, 'public')
        expect(harness.readJsonFile).toHaveBeenNthCalledWith(2, MANIFEST_PATH, 'public')
        expect(harness.readJsonFile).toHaveBeenNthCalledWith(3, ARTIFACT_PATH, 'private')
        expect(harness.createLockProvider).toHaveBeenCalledOnce()
        expect(harness.transaction).toHaveBeenCalledOnce()
        expect(harness.release).toHaveBeenCalledOnce()
        expect(JSON.stringify(output)).not.toContain(privateRecord.batchRecordId)
        expect(JSON.stringify(output)).not.toContain('private-message-id')
    })

    it('uses the injected current time instead of trusting an evidence-file now field', async () => {
        const harness = makeDependencies()

        await expect(executeNewsletterRetentionCli(baseArgs(), harness.dependencies)).resolves.toMatchObject({ mode: 'dry-run' })
    })

    it.each([
        [['--unknown'], 'argument is unknown'],
        [[...baseArgs(), '--site-id', SITE_ID], 'argument is duplicated'],
        [[
            '--site-id', SITE_ID,
            '--cutoff', CUTOFF,
            '--evidence-file', EVIDENCE_PATH,
            '--max-batches', '1.5',
        ], 'numeric argument is invalid'],
        [[...baseArgs(), '--manifest-file', MANIFEST_PATH], 'apply-only arguments require --apply'],
        [[...baseArgs(), '--apply', '--manifest-out', MANIFEST_OUT_PATH], 'dry-run output arguments cannot be used with --apply'],
    ])('rejects malformed or cross-mode argv %#', async (argv, expected) => {
        const harness = makeDependencies()
        await expect(executeNewsletterRetentionCli(argv, harness.dependencies)).rejects.toThrow(expected)
        expect(harness.transaction).not.toHaveBeenCalled()
    })

    it('rejects stale or unhealthy DLQ evidence before candidate/database access', async () => {
        const staleHarness = makeDependencies({
            [EVIDENCE_PATH]: { ...evidence, dlq: { checkedAt: '2026-08-28T11:00:00.000Z', healthy: true } },
        })
        await expect(executeNewsletterRetentionCli(baseArgs(), staleHarness.dependencies)).rejects.toThrow(
            'newsletter retention DLQ evidence is stale',
        )
        expect(staleHarness.database.newsletterBatch.findMany).not.toHaveBeenCalled()

        const unhealthyHarness = makeDependencies({
            [EVIDENCE_PATH]: { ...evidence, dlq: { checkedAt: '2026-08-28T11:59:00.000Z', healthy: false } },
        })
        await expect(executeNewsletterRetentionCli(baseArgs(), unhealthyHarness.dependencies)).rejects.toThrow(
            'newsletter retention DLQ evidence is invalid',
        )
        expect(unhealthyHarness.database.newsletterBatch.findMany).not.toHaveBeenCalled()
    })
})

function applyArgs(manifestHash: string, artifactHash: string): string[] {
    return [
        ...baseArgs(),
        '--apply',
        '--manifest-file', MANIFEST_PATH,
        '--private-artifact-file', ARTIFACT_PATH,
        '--expected-manifest-hash', manifestHash,
        '--expected-artifact-hash', artifactHash,
        '--confirm-site-id', SITE_ID,
    ]
}

describe('newsletter retention CLI file safety', () => {
    it('writes exclusive JSON with requested mode and refuses overwrite', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'newsletter-retention-cli-'))
        temporaryDirectories.push(directory)
        const path = join(directory, 'private.json')

        await writeNewsletterRetentionJsonFileExclusive(path, { secret: 'private' }, 0o600)

        expect((await stat(path)).mode & 0o777).toBe(0o600)
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ secret: 'private' })
        await expect(writeNewsletterRetentionJsonFileExclusive(path, { changed: true }, 0o600)).rejects.toThrow(
            'newsletter retention output file could not be created',
        )
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ secret: 'private' })
    })

    it('requires private files to be regular, owned, non-symlink files with no group/other access', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'newsletter-retention-cli-'))
        temporaryDirectories.push(directory)
        const privatePath = join(directory, 'private.json')
        const linkPath = join(directory, 'private-link.json')
        const hardLinkPath = join(directory, 'private-hard-link.json')
        await writeFile(privatePath, '{"ok":true}\n', { mode: 0o644 })

        await expect(readNewsletterRetentionJsonFile(privatePath, 'private')).rejects.toThrow(
            'newsletter retention private input file is invalid',
        )

        await chmod(privatePath, 0o600)
        await expect(readNewsletterRetentionJsonFile(privatePath, 'private')).resolves.toEqual({ ok: true })

        await link(privatePath, hardLinkPath)
        await expect(readNewsletterRetentionJsonFile(privatePath, 'private')).rejects.toThrow(
            'newsletter retention private input file is invalid',
        )

        await symlink(privatePath, linkPath)
        await expect(readNewsletterRetentionJsonFile(linkPath, 'private')).rejects.toThrow(
            'newsletter retention private input file is invalid',
        )
    })

    it('rejects symbolic links in parent components for reads and writes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'newsletter-retention-cli-'))
        temporaryDirectories.push(directory)
        const realParent = join(directory, 'real-parent')
        const linkedParent = join(directory, 'linked-parent')
        await mkdir(realParent, { mode: 0o700 })
        await writeFile(join(realParent, 'input.json'), '{"ok":true}\n', { mode: 0o600 })
        await symlink(realParent, linkedParent)

        await expect(readNewsletterRetentionJsonFile(join(linkedParent, 'input.json'), 'private')).rejects.toThrow(
            'newsletter retention private input file is invalid',
        )
        await expect(writeNewsletterRetentionJsonFileExclusive(
            join(linkedParent, 'output.json'),
            { ok: true },
            0o600,
        )).rejects.toThrow('newsletter retention output file could not be created')
    })

    it('rejects empty, malformed, oversized, relative, and non-regular JSON inputs', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'newsletter-retention-cli-'))
        temporaryDirectories.push(directory)
        const emptyPath = join(directory, 'empty.json')
        const malformedPath = join(directory, 'malformed.json')
        const oversizedPath = join(directory, 'oversized.json')
        await writeFile(emptyPath, '')
        await writeFile(malformedPath, '{')
        await writeFile(oversizedPath, 'x'.repeat(1_048_577))

        await expect(readNewsletterRetentionJsonFile(emptyPath, 'public')).rejects.toThrow('public input file is invalid')
        await expect(readNewsletterRetentionJsonFile(malformedPath, 'public')).rejects.toThrow('public input file is invalid')
        await expect(readNewsletterRetentionJsonFile(oversizedPath, 'public')).rejects.toThrow('public input file is invalid')
        await expect(readNewsletterRetentionJsonFile('relative.json', 'public')).rejects.toThrow('must be an absolute path')
        await expect(readNewsletterRetentionJsonFile(`${directory}/nested/../empty.json`, 'public')).rejects.toThrow(
            'must be an absolute path',
        )
        await expect(readNewsletterRetentionJsonFile(directory, 'public')).rejects.toThrow('public input file is invalid')
    })
})
