import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findMany, queryRaw } = vi.hoisted(() => ({ findMany: vi.fn(), queryRaw: vi.fn() }))
vi.mock('@/service/database/db', () => ({
    prisma: { $queryRaw: queryRaw, newsletterNotifications: { findMany } },
}))

import {
    QueryValidationError,
    decodeEventsCursor,
    fetchAnalyticsEvents,
    validateQueryParams,
} from '@/service/events-service/events-utils'

const base = 'https://proxy.internal/v3/site-1/events?event=delivered%20OR%20opened&begin=10&end=20&limit=2&ascending=true&tag=campaign&start=4'
const event = (id: string, created: string) => ({
    id,
    created: new Date(created),
    timestamp: new Date(created),
    type: 'delivered',
    messageId: `message-${id}`,
    rawEvent: '{}',
    newsletter: { toEmail: 'recipient@example.test', newsletterBatch: { batchId: 'batch-1' } },
})
function stubRows(...rows: ReturnType<typeof event>[]) {
    queryRaw.mockResolvedValueOnce(rows.map(row => ({ id: row.id })))
    if (rows.length) findMany.mockResolvedValueOnce([...rows].reverse())
}

function sqlCall(index: number) {
    const query = queryRaw.mock.calls[index][0]
    return { sql: query.sql as string, values: query.values as unknown[] }
}

describe('analytics keyset pagination', () => {
    beforeEach(() => { findMany.mockReset(); queryRaw.mockReset() })

    it('validates the Mailgun query contract', () => {
        expect(validateQueryParams(new URL(base).searchParams)).toMatchObject({
            start: 4, limit: 2, event: 'delivered OR opened', begin: 10, end: 20, order: 'asc', cursor: undefined,
        })
        expect(validateQueryParams(new URL('https://x.test/?event=delivered&begin=1&end=2').searchParams).order).toBe('desc')
        expect(validateQueryParams(new URL('https://x.test/?event=delivered&begin=1&end=2&ascending=0').searchParams).order).toBe('desc')
        expect(validateQueryParams(new URL('https://x.test/?event=delivered&begin=1&end=2&ascending=yes').searchParams).order).toBe('asc')

        for (const query of [
            'event=delivered&begin=2&end=2', 'event=delivered&begin=no&end=2',
            'event=delivered&begin=1&end=2&limit=0', 'event=delivered&begin=1&end=2&limit=301',
            'event=delivered&begin=1&end=2&start=-1', 'event=delivered&begin=1&end=2&ascending=maybe',
            'event=%20&begin=1&end=2',
        ]) expect(() => validateQueryParams(new URL(`https://x.test/?${query}`).searchParams)).toThrow(QueryValidationError)
    })

    it('accepts Ghost queries with fractional timestamps and omitted Mailgun time bounds', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-07-22T21:00:00.000Z'))
        try {
            expect(validateQueryParams(new URL(
                'https://x.test/?event=delivered%20OR%20opened&begin=1750000000.125&limit=300&ascending=yes',
            ).searchParams)).toMatchObject({
                event: 'delivered OR opened', begin: 1750000000.125, end: 1784754000, order: 'asc',
            })
            expect(validateQueryParams(new URL('https://x.test/?event=delivered&end=1750000000.875').searchParams)).toMatchObject({
                begin: 0, end: 1750000000.875,
            })
        } finally { vi.useRealTimers() }
    })

    it('accepts only safe base-10 numeric time bounds and integer pagination values', () => {
        const invalidQueries = [
            'event=delivered&begin=1e3&end=2000', 'event=delivered&begin=0x10&end=20',
            'event=delivered&begin=1&end=2&start=1e3', 'event=delivered&begin=1&end=2&limit=0x10',
            'event=delivered&begin=9007199254740992&end=9007199254740993',
            'event=delivered&begin=1&end=9007199254740992',
            'event=delivered&begin=8640000000001&end=8640000000002',
            'event=delivered&begin=1&end=2&start=1.5',
            'event=delivered&begin=1&end=2&limit=Infinity',
        ]
        for (const query of invalidQueries) {
            expect(() => validateQueryParams(new URL(`https://x.test/?${query}`).searchParams)).toThrow(QueryValidationError)
        }
    })

    it('uses legacy offset only on the first request, with stable created/id ordering and bound filters', async () => {
        stubRows(event('a', '2026-01-01T00:00:00.000Z'), event('b', '2026-01-01T00:00:00.000Z'))
        const query = validateQueryParams(new URL(base).searchParams)
        const result = await fetchAnalyticsEvents(query, 'site-1', base)
        const { sql, values } = sqlCall(0)
        expect(sql).toContain('FORCE INDEX (idx_notifications_type_created_id)')
        expect(sql).toContain('STRAIGHT_JOIN NewsletterMessages')
        expect(sql).toContain('UNION ALL')
        expect(sql).toContain('ORDER BY q.created ASC, q.id ASC')
        expect(sql).toContain('MAX_EXECUTION_TIME(5000)')
        expect(sql).toContain('LIMIT ? OFFSET ?')
        expect(values).toEqual([
            'delivered', 'site-1', new Date(10000), new Date(20000), 6,
            'opened', 'site-1', new Date(10000), new Date(20000), 6,
            2, 4,
        ])
        expect(findMany.mock.calls[0][0].where).toEqual({ id: { in: ['a', 'b'] } })
        expect(result.items.map(item => item.id)).toEqual(['a-message-a', 'b-message-b'])
        const next = new URL(result.paging.next)
        expect(next.searchParams.get('start')).toBeNull()
        expect(next.searchParams.get('tag')).toBe('campaign')
        expect(next.searchParams.get('ascending')).toBe('true')
        expect(decodeEventsCursor(next.searchParams.get('cursor')!, 'asc')).toMatchObject({ id: 'b', created: '2026-01-01T00:00:00.000Z' })
    })

    it('preserves a legacy empty page offset and filters without loading payloads', async () => {
        stubRows()
        const result = await fetchAnalyticsEvents(validateQueryParams(new URL(base).searchParams), 'site-1', base)
        const next = new URL(result.paging.next)
        expect(result.items).toEqual([])
        expect(findMany).not.toHaveBeenCalled()
        expect(next.searchParams.get('start')).toBe('4')
        expect(next.searchParams.get('cursor')).toBeNull()
        expect(next.searchParams.get('event')).toBe('delivered OR opened')
        expect(next.searchParams.get('begin')).toBe('10')
        expect(next.searchParams.get('end')).toBe('20')
        expect(next.searchParams.get('limit')).toBe('2')
        expect(next.searchParams.get('ascending')).toBe('true')
        expect(next.searchParams.get('tag')).toBe('campaign')
        stubRows()
        await fetchAnalyticsEvents(validateQueryParams(next.searchParams), 'site-1', next.toString())
        expect(sqlCall(1).values.at(-1)).toBe(4)
    })

    it('uses the created/id lexicographic seek after duplicate timestamps without offset', async () => {
        stubRows(event('a', '2026-01-01T00:00:00.000Z'), event('b', '2026-01-01T00:00:00.000Z'))
        const firstResult = await fetchAnalyticsEvents(validateQueryParams(new URL(base).searchParams), 'site-1', base)
        const secondUrl = new URL(firstResult.paging.next)
        stubRows(event('c', '2026-01-01T00:00:00.000Z'))
        await fetchAnalyticsEvents(validateQueryParams(secondUrl.searchParams), 'site-1', secondUrl.toString())
        const { sql, values } = sqlCall(1)
        expect(sql).toContain('n.created > ? OR (n.created = ? AND n.id > ?)')
        expect(values.filter(value => value === 'b')).toHaveLength(2)
        expect(values.slice(-3)).toEqual([2, 2, 0])
    })

    it('uses inverse seek for descending cursors and rejects malformed or order-mismatched cursors', async () => {
        const cursor = Buffer.from(JSON.stringify({ v: 1, created: '2026-01-01T00:00:00.000Z', id: 'a', order: 'desc' })).toString('base64url')
        const url = new URL(`https://x.test/?event=delivered&begin=1&end=2&cursor=${cursor}`)
        stubRows(event('z', '2026-01-02T00:00:00.000Z'))
        const first = await fetchAnalyticsEvents(validateQueryParams(url.searchParams), 'site-1', url.toString())
        const next = new URL(first.paging.next)
        stubRows()
        await fetchAnalyticsEvents(validateQueryParams(next.searchParams), 'site-1', next.toString())
        expect(sqlCall(0).sql).toContain('n.created < ? OR (n.created = ? AND n.id < ?)')
        expect(sqlCall(0).sql).toContain('ORDER BY n.created DESC, n.id DESC')
        expect(sqlCall(1).values).toContain('z')
        expect(() => validateQueryParams(new URL('https://x.test/?event=x&begin=1&end=2&cursor=not-a-cursor').searchParams)).toThrow(QueryValidationError)
        expect(() => validateQueryParams(new URL(`https://x.test/?event=x&begin=1&end=2&ascending=true&cursor=${next.searchParams.get('cursor')}`).searchParams)).toThrow(QueryValidationError)
    })

    it('keeps an empty page next URL deterministic without advancing its cursor', async () => {
        const cursor = Buffer.from(JSON.stringify({ v: 1, created: '2026-01-01T00:00:00.000Z', id: 'a', order: 'desc' })).toString('base64url')
        const url = new URL(`https://x.test/?event=delivered&begin=1&end=2&cursor=${cursor}`)
        stubRows()
        const result = await fetchAnalyticsEvents(validateQueryParams(url.searchParams), 'site-1', url.toString())
        expect(result.items).toEqual([])
        expect(result.paging.next).toBe(url.toString())
    })

    it('fails closed when a notification disappears between ID selection and hydration', async () => {
        queryRaw.mockResolvedValueOnce([{ id: 'missing' }])
        findMany.mockResolvedValueOnce([])
        await expect(fetchAnalyticsEvents(validateQueryParams(new URL(base).searchParams), 'site-1', base))
            .rejects.toThrow('retry the request')
    })

    it('uses the migrated composite index and deterministic outer order for a single event type', async () => {
        const url = 'https://x.test/?event=opened&begin=1&end=2&limit=1&start=3'
        stubRows(event('a', '2026-01-01T00:00:00.000Z'))
        await fetchAnalyticsEvents(validateQueryParams(new URL(url).searchParams), 'site-1', url)
        const { sql, values } = sqlCall(0)
        expect(sql).not.toContain('UNION ALL')
        expect(sql).toContain('ORDER BY q.created DESC, q.id DESC')
        expect(values).toEqual(['opened', 'site-1', new Date(1000), new Date(2000), 4, 1, 3])
    })

    it('binds hostile site and type values rather than interpolating SQL', async () => {
        const url = 'https://x.test/?event=delivered%27%20OR%201%3D1&begin=1&end=2'
        stubRows()
        await fetchAnalyticsEvents(validateQueryParams(new URL(url).searchParams), "site' OR 1=1", url)
        const { sql, values } = sqlCall(0)
        expect(sql).not.toContain('1=1')
        expect(values).toContain("site' OR 1=1")
        expect(values).toContain("delivered'")
        expect(values).toContain('1=1')
    })
})
