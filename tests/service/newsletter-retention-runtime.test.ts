import { beforeEach, describe, expect, it, vi } from 'vitest'

const createConnection = vi.hoisted(() => vi.fn())
const prismaMock = vi.hoisted(() => ({ marker: 'prisma-delegate' }))

vi.mock('mariadb', () => ({ createConnection }))
vi.mock('@/lib/database', () => ({ prisma: prismaMock }))

import {
    createNewsletterRetentionMariaDbLockProvider,
    getNewsletterRetentionApplyDatabase,
} from '@/service/newsletter-retention-runtime'

interface ConnectionFixtureOptions {
    acquired?: unknown
    released?: unknown
    acquireFailure?: unknown
    releaseFailure?: unknown
    endFailure?: unknown
}

function makeConnection(options: ConnectionFixtureOptions = {}) {
    const query = vi.fn(async (sql: string) => {
        if (sql.includes('GET_LOCK')) {
            if (options.acquireFailure) throw options.acquireFailure
            return [{ acquired: options.acquired ?? 1 }]
        }
        if (sql.includes('RELEASE_LOCK')) {
            if (options.releaseFailure) throw options.releaseFailure
            return [{ released: options.released ?? 1 }]
        }
        throw new Error('unexpected SQL')
    })
    const end = vi.fn(async () => {
        if (options.endFailure) throw options.endFailure
    })
    const connection = { query, end }
    createConnection.mockResolvedValue(connection)
    return { connection, query, end }
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('newsletter retention runtime adapters', () => {
    it('returns the shared Prisma client as the apply database delegate', () => {
        expect(getNewsletterRetentionApplyDatabase()).toBe(prismaMock)
    })

    it('holds a named lock on one dedicated connection and releases it on that same connection', async () => {
        const { connection, query, end } = makeConnection()
        const provider = createNewsletterRetentionMariaDbLockProvider({
            databaseUrl: 'mysql://user:password@db.invalid/proxy',
        })

        const lease = await provider.tryAcquire('newsletter-retention-apply')

        expect(lease).not.toBeNull()
        expect(createConnection).toHaveBeenCalledWith('mariadb://user:password@db.invalid/proxy')
        expect(query).toHaveBeenNthCalledWith(1, 'SELECT GET_LOCK(?, 0) AS acquired', ['newsletter-retention-apply'])
        expect(end).not.toHaveBeenCalled()

        await lease?.release()

        expect(query).toHaveBeenNthCalledWith(2, 'SELECT RELEASE_LOCK(?) AS released', ['newsletter-retention-apply'])
        expect(end).toHaveBeenCalledOnce()
        await expect(createConnection.mock.results[0].value).resolves.toBe(connection)
    })

    it('returns null and closes the connection when another owner holds the lock', async () => {
        const { query, end } = makeConnection({ acquired: 0 })
        const provider = createNewsletterRetentionMariaDbLockProvider({
            databaseUrl: 'mariadb://user:password@db.invalid/proxy',
        })

        await expect(provider.tryAcquire('newsletter-retention-apply')).resolves.toBeNull()

        expect(query).toHaveBeenCalledTimes(1)
        expect(end).toHaveBeenCalledOnce()
    })

    it('sanitizes connection and malformed acquisition failures and closes when possible', async () => {
        const secret = 'mysql://secret-user:secret-pass@private-host/proxy'
        createConnection.mockRejectedValueOnce(new Error(secret))
        const failedConnectionProvider = createNewsletterRetentionMariaDbLockProvider({
            databaseUrl: 'mariadb://user:password@db.invalid/proxy',
        })

        await expect(failedConnectionProvider.tryAcquire('newsletter-retention-apply')).rejects.toThrow(
            'newsletter retention lock acquisition failed',
        )

        const { end } = makeConnection({ acquired: 'SECRET_RESULT' })
        const malformedProvider = createNewsletterRetentionMariaDbLockProvider({
            databaseUrl: 'mariadb://user:password@db.invalid/proxy',
        })
        let error: unknown
        try {
            await malformedProvider.tryAcquire('newsletter-retention-apply')
        } catch (caught) {
            error = caught
        }

        expect((error as Error).message).toBe('newsletter retention lock acquisition failed')
        expect((error as Error).message).not.toContain('SECRET_RESULT')
        expect(end).toHaveBeenCalledOnce()
    })

    it('closes the connection and emits only a sanitized error when release fails', async () => {
        const { end } = makeConnection({ releaseFailure: new Error('SECRET_RELEASE') })
        const provider = createNewsletterRetentionMariaDbLockProvider({
            databaseUrl: 'mariadb://user:password@db.invalid/proxy',
        })
        const lease = await provider.tryAcquire('newsletter-retention-apply')

        await expect(lease?.release()).rejects.toThrow('newsletter retention lock release failed')
        expect(end).toHaveBeenCalledOnce()
    })

    it('treats unexpected release ownership and connection-close failure as release failures', async () => {
        const unexpected = makeConnection({ released: 0 })
        const providerUnexpected = createNewsletterRetentionMariaDbLockProvider({
            databaseUrl: 'mariadb://user:password@db.invalid/proxy',
        })
        const unexpectedLease = await providerUnexpected.tryAcquire('newsletter-retention-apply')
        await expect(unexpectedLease?.release()).rejects.toThrow('newsletter retention lock release failed')
        expect(unexpected.end).toHaveBeenCalledOnce()

        const closeFailure = makeConnection({ endFailure: new Error('SECRET_CLOSE') })
        const providerCloseFailure = createNewsletterRetentionMariaDbLockProvider({
            databaseUrl: 'mariadb://user:password@db.invalid/proxy',
        })
        const closeFailureLease = await providerCloseFailure.tryAcquire('newsletter-retention-apply')
        await expect(closeFailureLease?.release()).rejects.toThrow('newsletter retention lock release failed')
        expect(closeFailure.end).toHaveBeenCalledOnce()
    })

    it('makes a lease single-use and never issues a second RELEASE_LOCK', async () => {
        const { query } = makeConnection()
        const provider = createNewsletterRetentionMariaDbLockProvider({
            databaseUrl: 'mariadb://user:password@db.invalid/proxy',
        })
        const lease = await provider.tryAcquire('newsletter-retention-apply')

        await lease?.release()
        await expect(lease?.release()).rejects.toThrow('newsletter retention lock lease is already released')
        expect(query).toHaveBeenCalledTimes(2)
    })

    it('rejects missing/invalid URLs and invalid lock keys before opening a connection', async () => {
        expect(() => createNewsletterRetentionMariaDbLockProvider({ databaseUrl: '' })).toThrow(
            'newsletter retention database URL is required',
        )
        expect(() => createNewsletterRetentionMariaDbLockProvider({ databaseUrl: 'https://db.invalid' })).toThrow(
            'newsletter retention database URL is invalid',
        )

        const provider = createNewsletterRetentionMariaDbLockProvider({
            databaseUrl: 'mariadb://user:password@db.invalid/proxy',
        })
        await expect(provider.tryAcquire(' x ')).rejects.toThrow('newsletter retention lock key is invalid')
        await expect(provider.tryAcquire('x'.repeat(65))).rejects.toThrow('newsletter retention lock key is invalid')
        expect(createConnection).not.toHaveBeenCalled()
    })
})
