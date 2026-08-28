import { createConnection, type Connection } from 'mariadb'

import { prisma } from '@/lib/database'
import type {
    NewsletterRetentionApplyDatabase,
    NewsletterRetentionApplyLockLease,
    NewsletterRetentionApplyLockProvider,
} from '@/service/newsletter-retention-applier'

const MYSQL_NAMED_LOCK_MAX_LENGTH = 64

export function getNewsletterRetentionApplyDatabase(): NewsletterRetentionApplyDatabase {
    return prisma as unknown as NewsletterRetentionApplyDatabase
}

export interface NewsletterRetentionMariaDbLockProviderOptions {
    databaseUrl?: string
}

export function createNewsletterRetentionMariaDbLockProvider(
    options: NewsletterRetentionMariaDbLockProviderOptions = {},
): NewsletterRetentionApplyLockProvider {
    const databaseUrl = normalizeDatabaseUrl(options.databaseUrl ?? process.env.DATABASE_URL)

    return {
        async tryAcquire(key: string): Promise<NewsletterRetentionApplyLockLease | null> {
            const lockKey = normalizeLockKey(key)
            let connection: Connection | null = null

            try {
                connection = await createConnection(databaseUrl)
                const acquired = normalizeNamedLockResult(
                    await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [lockKey]),
                    'acquired',
                )

                if (acquired === 0) {
                    await closeConnection(connection, 'newsletter retention lock refusal cleanup failed')
                    connection = null
                    return null
                }

                const ownedConnection = connection
                connection = null
                let released = false

                return {
                    async release(): Promise<void> {
                        if (released) {
                            throw new Error('newsletter retention lock lease is already released')
                        }
                        released = true

                        let releaseSucceeded = false
                        let closeSucceeded = false
                        try {
                            const result = normalizeNamedLockResult(
                                await ownedConnection.query('SELECT RELEASE_LOCK(?) AS released', [lockKey]),
                                'released',
                            )
                            releaseSucceeded = result === 1
                        } catch {
                            releaseSucceeded = false
                        }

                        try {
                            await ownedConnection.end()
                            closeSucceeded = true
                        } catch {
                            closeSucceeded = false
                        }

                        if (!releaseSucceeded || !closeSucceeded) {
                            throw new Error('newsletter retention lock release failed')
                        }
                    },
                }
            } catch {
                if (connection) {
                    try {
                        await connection.end()
                    } catch {
                        // The public error remains intentionally sanitized.
                    }
                }
                throw new Error('newsletter retention lock acquisition failed')
            }
        },
    }
}

function normalizeDatabaseUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new Error('newsletter retention database URL is required')
    }

    if (!/^(?:mysql|mariadb):\/\//.test(value)) {
        throw new Error('newsletter retention database URL is invalid')
    }

    return value.replace(/^mysql:/, 'mariadb:')
}

function normalizeLockKey(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > MYSQL_NAMED_LOCK_MAX_LENGTH) {
        throw new Error('newsletter retention lock key is invalid')
    }

    return value
}

function normalizeNamedLockResult(value: unknown, field: 'acquired' | 'released'): 0 | 1 {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`newsletter retention lock ${field} result is invalid`)
    }

    const row = value[0]
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`newsletter retention lock ${field} result is invalid`)
    }

    const result = (row as Record<string, unknown>)[field]
    if (result !== 0 && result !== 1) {
        throw new Error(`newsletter retention lock ${field} result is invalid`)
    }

    return result
}

async function closeConnection(connection: Connection, errorMessage: string): Promise<void> {
    try {
        await connection.end()
    } catch {
        throw new Error(errorMessage)
    }
}
