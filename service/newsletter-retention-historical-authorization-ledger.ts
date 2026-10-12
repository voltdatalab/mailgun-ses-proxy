import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeFileSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'
import type { HistoricalExecutorRoot } from './newsletter-retention-historical-executor-contract.js'

/** Trusted internal port. No request, report, environment or CLI may provision it.
 * true means an irreversible, durable exclusive claim; ambiguity MUST throw. */
export interface HistoricalAuthorizationLedger {
    identity: string
    scopeSha256: string
    claim(): Promise<boolean>
}
export function historicalAuthorizationScope(root: Pick<HistoricalExecutorRoot, 'binding' | 'policy' | 'approval' | 'acquisitionRoot' | 'queueIds' | 'maxGateAgeMs' | 'maxPressure'>): string {
    function canonical(value: unknown): unknown {
        if (Array.isArray(value)) return value.map(canonical)
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]))
        return value
    }
    return createHash('sha256').update(JSON.stringify(canonical({ version: 1, binding: root.binding, policy: root.policy, approval: root.approval,
        acquisitionRoot: root.acquisitionRoot, queueIds: root.queueIds, maxGateAgeMs: root.maxGateAgeMs, maxPressure: root.maxPressure }))).digest('hex')
}
function validate(identity: string, scopeSha256: string) {
    if (typeof identity !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(identity) || typeof scopeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(scopeSha256)) throw new Error('historical ledger binding invalid')
}
// Linux descriptor-relative traversal avoids pathname ancestor replacement during
// traversal. All ancestors must be owned by root/current UID and not writable by
// group/others. No chmod, symlink following, foreign UID mapping or fallback.
function directory(path: string): number {
    if (process.platform !== 'linux' || !process.getuid || !isAbsolute(path) || normalize(path) !== path || path === '/') throw new Error('historical ledger directory invalid')
    let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
        const parts = path.slice(1).split('/')
        for (let index = 0; index < parts.length; index++) {
            const ancestor = fstatSync(fd)
            if (!ancestor.isDirectory() || ![0, process.getuid()].includes(ancestor.uid) || (ancestor.mode & 0o022) !== 0) throw new Error('historical ledger ancestry unsafe')
            const next = openSync(`/proc/self/fd/${fd}/${parts[index]}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
            closeSync(fd); fd = next
        }
        const leaf = fstatSync(fd)
        if (!leaf.isDirectory() || leaf.uid !== process.getuid() || (leaf.mode & 0o7777) !== 0o700) throw new Error('historical ledger directory unsafe')
        return fd
    } catch (error) { closeSync(fd); throw error }
}
function record(identity: string, scopeSha256: string): string { return JSON.stringify({ version: 1, identity, scopeSha256 }) + '\n' }
function readProvision(fd: number, identity: string, scopeSha256: string) {
    const file = openSync(`/proc/self/fd/${fd}/${identity}.approved`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
        const stat = fstatSync(file)
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o400 || stat.size > 1024) throw new Error('historical ledger approval invalid')
        const bytes = Buffer.alloc(1025), length = readSync(file, bytes, 0, bytes.length, 0), after = fstatSync(file)
        if (length !== stat.size || after.size !== stat.size || after.ctimeMs !== stat.ctimeMs || after.mtimeMs !== stat.mtimeMs || after.nlink !== 1 || bytes.subarray(0, length).toString('utf8') !== record(identity, scopeSha256)) throw new Error('historical ledger approval invalid')
        return stat
    } finally { closeSync(file) }
}
function exclusive(fd: number, name: string, bytes: string): boolean {
    let file: number
    try { file = openSync(`/proc/self/fd/${fd}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error }
    // Never unlink after a failure: a partial/ambiguous claim is consumed too.
    try {
        const stat = fstatSync(file)
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o400) throw new Error('historical ledger file unsafe')
        writeFileSync(file, bytes); fsyncSync(file); fsyncSync(fd)
        const linked = openSync(`/proc/self/fd/${fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
            const fresh = fstatSync(linked), written = fstatSync(file)
            if (fresh.dev !== stat.dev || fresh.ino !== stat.ino || fresh.nlink !== 1 || written.nlink !== 1 || fresh.size !== Buffer.byteLength(bytes)
                || fresh.uid !== process.getuid!() || (fresh.mode & 0o7777) !== 0o400) throw new Error('historical ledger claim replaced')
        } finally { closeSync(linked) }
    } finally { closeSync(file) }
    return true
}
/** Offline independent provisioning only. Existing identities cannot be rebound. */
export function provisionHistoricalAuthorization(directoryPath: string, identity: string, scopeSha256: string): void {
    validate(identity, scopeSha256)
    const fd = directory(directoryPath)
    try {
        exclusive(fd, `${identity}.approved`, record(identity, scopeSha256))
        readProvision(fd, identity, scopeSha256)
        fsyncSync(fd)
    } finally { closeSync(fd) }
}
/** Existing provision required; never auto-provision on the executor path. */
export function openHistoricalAuthorizationLedger(directoryPath: string, identity: string, scopeSha256: string): HistoricalAuthorizationLedger {
    validate(identity, scopeSha256)
    const fd = directory(directoryPath)
    let pin: ReturnType<typeof fstatSync>, approvalPin: ReturnType<typeof fstatSync>
    try { approvalPin = readProvision(fd, identity, scopeSha256); pin = fstatSync(fd) } finally { closeSync(fd) }
    return Object.freeze({ identity, scopeSha256, claim: async () => {
        const current = directory(directoryPath)
        try {
            const stat = fstatSync(current)
            if (stat.dev !== pin.dev || stat.ino !== pin.ino) throw new Error('historical ledger directory replaced')
            const approval = readProvision(current, identity, scopeSha256)
            if (approval.dev !== approvalPin.dev || approval.ino !== approvalPin.ino) throw new Error('historical ledger approval replaced')
            const claimed = exclusive(current, `${identity}.consumed`, record(identity, scopeSha256))
            const check = directory(directoryPath)
            try { const fresh = fstatSync(check); if (fresh.dev !== pin.dev || fresh.ino !== pin.ino) throw new Error('historical ledger directory replaced') } finally { closeSync(check) }
            return claimed
        } finally { closeSync(current) }
    } })
}
