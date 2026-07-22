import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }))
vi.mock('@/service/database/db', () => ({
    prisma: { newsletterNotifications: { findMany } },
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

describe('analytics keyset pagination', () => {
    beforeEach(() => findMany.mockReset())

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

    it('accepts only safe base-10 integer query values and date-representable bounds', () => {
        const invalidQueries = [
            'event=delivered&begin=1e3&end=2000',
            'event=delivered&begin=0x10&end=20',
            'event=delivered&begin=1&end=2&start=1e3',
            'event=delivered&begin=1&end=2&limit=0x10',
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

    it('uses legacy offset only on the first request, with stable created/id ordering', async () => {
        findMany.mockResolvedValue([event('a', '2026-01-01T00:00:00.000Z'), event('b', '2026-01-01T00:00:00.000Z')])
        const query = validateQueryParams(new URL(base).searchParams)
        const result = await fetchAnalyticsEvents(query, 'site-1', base)
        const args = findMany.mock.calls[0][0]

        expect(args.skip).toBe(4)
        expect(args.orderBy).toEqual([{ created: 'asc' }, { id: 'asc' }])
        expect(args.where.type).toEqual({ in: ['delivered', 'opened'] })
        const next = new URL(result.paging.next)
        expect(next.searchParams.get('start')).toBeNull()
        expect(next.searchParams.get('tag')).toBe('campaign')
        expect(next.searchParams.get('ascending')).toBe('true')
        expect(decodeEventsCursor(next.searchParams.get('cursor')!, 'asc')).toMatchObject({ id: 'b', created: '2026-01-01T00:00:00.000Z' })
    })

    it('preserves a legacy empty page offset and filters without adding a cursor', async () => {
        findMany.mockResolvedValue([])
        const query = validateQueryParams(new URL(base).searchParams)
        const result = await fetchAnalyticsEvents(query, 'site-1', base)
        const next = new URL(result.paging.next)

        expect(result.items).toEqual([])
        expect(next.searchParams.get('start')).toBe('4')
        expect(next.searchParams.get('cursor')).toBeNull()
        expect(next.searchParams.get('event')).toBe('delivered OR opened')
        expect(next.searchParams.get('begin')).toBe('10')
        expect(next.searchParams.get('end')).toBe('20')
        expect(next.searchParams.get('limit')).toBe('2')
        expect(next.searchParams.get('ascending')).toBe('true')
        expect(next.searchParams.get('tag')).toBe('campaign')

        await fetchAnalyticsEvents(validateQueryParams(next.searchParams), 'site-1', next.toString())
        expect(findMany.mock.calls[1][0].skip).toBe(4)
    })

    it('uses the created/id lexicographic seek after duplicate timestamps without skip', async () => {
        const first = validateQueryParams(new URL(base).searchParams)
        findMany.mockResolvedValue([event('a', '2026-01-01T00:00:00.000Z'), event('b', '2026-01-01T00:00:00.000Z')])
        const firstResult = await fetchAnalyticsEvents(first, 'site-1', base)
        const secondUrl = new URL(firstResult.paging.next)
        const second = validateQueryParams(secondUrl.searchParams)
        findMany.mockResolvedValue([event('c', '2026-01-01T00:00:00.000Z')])
        await fetchAnalyticsEvents(second, 'site-1', secondUrl.toString())
        const args = findMany.mock.calls[1][0]

        expect(args.skip).toBeUndefined()
        expect(args.where.AND).toEqual([{ OR: [
            { created: { gt: new Date('2026-01-01T00:00:00.000Z') } },
            { created: new Date('2026-01-01T00:00:00.000Z'), id: { gt: 'b' } },
        ] }])
    })

    it('uses inverse seek for descending cursors and rejects malformed or order-mismatched cursors', async () => {
        const cursor = Buffer.from(JSON.stringify({ v: 1, created: '2026-01-01T00:00:00.000Z', id: 'a', order: 'desc' })).toString('base64url')
        const url = new URL(`https://x.test/?event=delivered&begin=1&end=2&cursor=${cursor}`)
        findMany.mockResolvedValue([event('z', '2026-01-02T00:00:00.000Z')])
        const first = await fetchAnalyticsEvents(validateQueryParams(url.searchParams), 'site-1', url.toString())
        const next = new URL(first.paging.next)
        findMany.mockResolvedValue([])
        await fetchAnalyticsEvents(validateQueryParams(next.searchParams), 'site-1', next.toString())
        expect(findMany.mock.calls[1][0].where.AND).toEqual([{ OR: [
            { created: { lt: new Date('2026-01-02T00:00:00.000Z') } },
            { created: new Date('2026-01-02T00:00:00.000Z'), id: { lt: 'z' } },
        ] }])
        expect(() => validateQueryParams(new URL('https://x.test/?event=x&begin=1&end=2&cursor=not-a-cursor').searchParams)).toThrow(QueryValidationError)
        expect(() => validateQueryParams(new URL(`https://x.test/?event=x&begin=1&end=2&ascending=true&cursor=${next.searchParams.get('cursor')}`).searchParams)).toThrow(QueryValidationError)
    })

    it('keeps an empty page next URL deterministic without advancing its cursor', async () => {
        const cursor = Buffer.from(JSON.stringify({ v: 1, created: '2026-01-01T00:00:00.000Z', id: 'a', order: 'desc' })).toString('base64url')
        const url = new URL(`https://x.test/?event=delivered&begin=1&end=2&cursor=${cursor}`)
        findMany.mockResolvedValue([])
        const result = await fetchAnalyticsEvents(validateQueryParams(url.searchParams), 'site-1', url.toString())
        expect(result.items).toEqual([])
        expect(result.paging.next).toBe(url.toString())
    })
})
