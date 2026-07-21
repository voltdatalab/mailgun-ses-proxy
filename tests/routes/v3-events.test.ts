import { describe, expect, it, vi } from 'vitest'

const { fetchAnalyticsEvents, validateQueryParams, error } = vi.hoisted(() => ({
    fetchAnalyticsEvents: vi.fn(),
    validateQueryParams: vi.fn(),
    error: vi.fn(),
}))

vi.mock('@/service/events-service/events-utils', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/service/events-service/events-utils')>(),
    fetchAnalyticsEvents,
    validateQueryParams,
}))
vi.mock('@/lib/core/logger', () => ({
    default: { child: () => ({ debug: vi.fn(), error }) },
}))

import { GET } from '@/app/v3/[siteId]/events/[[...slug]]/route'

describe('GET /v3/[siteId]/events error handling', () => {
    it('does not expose database errors', async () => {
        validateQueryParams.mockReturnValue({})
        fetchAnalyticsEvents.mockRejectedValue(new Error('SQLSTATE secret query'))
        const response = await GET({ nextUrl: new URL('https://x.test/v3/site-1/events'), url: 'https://x.test/v3/site-1/events' } as never, { params: Promise.resolve({ siteId: 'site-1' }) })

        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ message: 'Unable to fetch analytics events' })
        expect(error).toHaveBeenCalledWith({ errorClass: 'Error', siteId: 'site-1' }, 'error when fetching analytics events')
        expect(JSON.stringify(error.mock.calls)).not.toContain('SQLSTATE')
    })
})
