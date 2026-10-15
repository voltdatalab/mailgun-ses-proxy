import { beforeEach, describe, expect, it, vi } from 'vitest'
const { query, hydrate } = vi.hoisted(() => ({ query: vi.fn(), hydrate: vi.fn() }))
vi.mock('@/service/database/db', () => ({ prisma: { $queryRaw: query, newsletterNotifications: { findMany: hydrate } } }))
import { getEmailEvents } from '@/service/events-service/events-utils'
const params = { siteId: 'nucleo.jor.br', type: 'delivered OR opened', begin: 1, end: 2000000000, order: 'asc' as const, limit: 300, start: 0, url: 'https://example.test/events' }
describe('bounded event reads', () => {
 beforeEach(() => { query.mockReset(); hydrate.mockReset() })
 it('selects only indexed IDs before loading bounded payloads', async () => {
  query.mockResolvedValue([])
  await getEmailEvents(params)
  expect(query).toHaveBeenCalledOnce()
  const sql = query.mock.calls[0][0].sql
  expect(sql).toContain('MAX_EXECUTION_TIME(2000)')
  expect(sql).toContain('FORCE INDEX (idx_notifications_type_created_id)')
  expect(sql).toContain('UNION ALL')
  expect(sql).not.toContain('rawEvent')
  expect(hydrate).not.toHaveBeenCalled()
 })
 it('rejects overlapping polls instead of accumulating database work and releases on failure', async () => {
  let reject!: (e: Error) => void
  query.mockImplementationOnce(() => new Promise((_, no) => { reject = no }))
  const first = getEmailEvents(params)
  await expect(getEmailEvents(params)).rejects.toThrow('Analytics busy')
  expect(query).toHaveBeenCalledOnce()
  reject(new Error('query timed out'))
  await expect(first).rejects.toThrow('query timed out')
  query.mockResolvedValue([])
  await expect(getEmailEvents(params)).resolves.toMatchObject({ items: [] })
 })
})

it('hydrates only selected IDs, restores their order, and omits campaign contents', async () => {
 query.mockResolvedValue([{id:'b',created:new Date(20000)},{id:'a',created:new Date(20000)}])
 const row=(id:string)=>({id,created:new Date(20000),timestamp:new Date(20000),type:'delivered',messageId:id,rawEvent:'{}',newsletter:{toEmail:'test@example.test',newsletterBatch:{batchId:'batch'}}})
 hydrate.mockResolvedValue([row('a'),row('b')])
 const result=await getEmailEvents(params)
 expect(result.items.map(item=>item.id)).toEqual(['b-b','a-a'])
 expect(hydrate.mock.calls.at(-1)![0].where).toEqual({id:{in:['b','a']}})
 expect(JSON.stringify(hydrate.mock.calls.at(-1)![0])).not.toContain('contents')
})
