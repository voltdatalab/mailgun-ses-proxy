import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { NEWSLETTER_RETENTION_ESCROW_MAX_TOTAL_BYTES, NEWSLETTER_RETENTION_ESCROW_MAX_RECORDS } from './newsletter-retention-escrow.js'
const MAX_JSON_FILE_BYTES = 1_048_576
const SHA_256_HEX = /^[a-f0-9]{64}$/
export class NewsletterRetentionCliError extends Error {
    constructor(message = 'newsletter retention command failed') {
        super(message)
        this.name = 'NewsletterRetentionCliError'
    }
}

interface EscrowFileIdentity {
    dev: string
    ino: string
    size: number
    mtimeMs: number
    ctimeMs: number
}

export async function readEscrowFileIdentity(
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

export async function assertEscrowFileIdentity(
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

export function normalizeAbsolutePath(value: unknown, field: string): string {
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

export interface BoundParentDirectory {
    handle: Awaited<ReturnType<typeof open>>
    boundFilePath: string
    fileName: string
}

export async function openBoundParentDirectory(path: string): Promise<BoundParentDirectory> {
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

/** Acquire pinned metadata bytes from one bound private descriptor.
 * Pinning proves byte identity ONLY, not who collected the Windows readback. */
export async function readPinnedNewsletterRetentionMetadataBytes(path: string, expectedSha256: string) {
    if (typeof expectedSha256 !== 'string' || !SHA_256_HEX.test(expectedSha256)) throw new NewsletterRetentionCliError('operational readback report pin invalid')
    const normalizedPath = normalizeAbsolutePath(path, 'operational report')
    let parent: BoundParentDirectory | null = null
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
        parent = await openBoundParentDirectory(normalizedPath)
        handle = await open(parent.boundFilePath, constants.O_RDONLY | constants.O_NOFOLLOW)
        const identity = await readEscrowFileIdentity(handle)
        if (identity.size > MAX_JSON_FILE_BYTES) throw new Error('report capacity')
        const before = await handle.stat({ bigint: true })
        const bytes = Buffer.alloc(identity.size + 1)
        // A retained writable fd can mutate mode0400 files, sometimes within the
        // filesystem timestamp tick. Re-read exact bytes as well as descriptor
        // metadata; do not change the legacy escrow reader's guards/behavior.
        for (let pass = 0; pass < 2; pass++) {
            let position = 0
            while (position < bytes.length) {
                const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position)
                if (!bytesRead) break
                position += bytesRead
            }
            await assertEscrowFileIdentity(handle, identity)
            const after = await handle.stat({ bigint: true })
            if (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
                || position !== identity.size || createHash('sha256').update(bytes.subarray(0, position)).digest('hex') !== expectedSha256) throw new Error('report pin mismatch')
        }
        return Buffer.from(bytes.subarray(0, identity.size))
    } catch {
        throw new NewsletterRetentionCliError('operational readback descriptor or byte pin invalid')
    } finally {
        try { await handle?.close() } finally { await parent?.handle.close() }
    }
}

export async function readPinnedNewsletterRetentionOperationalReport(path: string, expectedSha256: string) {
    const bytes = await readPinnedNewsletterRetentionMetadataBytes(path, expectedSha256)
    try {
        const report: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        return Object.freeze({ report, reportSha256: expectedSha256, collectionAuthenticated: false as const })
    } catch { throw new NewsletterRetentionCliError('operational readback descriptor or byte pin invalid') }
}
