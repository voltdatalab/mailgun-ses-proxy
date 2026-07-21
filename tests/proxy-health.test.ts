import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it } from 'vitest'
import { proxy } from '@/proxy'

const originalApiKey = process.env.API_KEY
function request(pathname: string, authorization?: string) {
    return new NextRequest(`http://proxy.test${pathname}`, { headers: authorization ? { authorization } : undefined })
}

describe('health proxy routing', () => {
    afterEach(() => { process.env.API_KEY = originalApiKey })

    it('allows exactly /healthcheck without API authentication', async () => {
        const response = await proxy(request('/healthcheck'))
        expect(response.status).not.toBe(401)
    })

    it.each(['/healthcheck/details', '/ops/health'])('requires Basic API authentication for %s', async pathname => {
        process.env.API_KEY = 'test-key'
        const response = await proxy(request(pathname))
        expect(response.status).toBe(401)
    })

    it('allows authenticated detailed health', async () => {
        process.env.API_KEY = 'test-key'
        const response = await proxy(request('/ops/health', `Basic ${Buffer.from('api:test-key').toString('base64')}`))
        expect(response.status).not.toBe(401)
    })
})
