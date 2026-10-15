import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import mariadb, { type Connection } from 'mariadb'
vi.mock('@/service/database/db', () => ({ prisma: {} }))
import { buildEventIdQuery } from '@/service/events-service/events-utils'
let db: Connection
const suite = process.env.RUN_EVENTS_MYSQL === 'true' || process.env.runPrismaTests === 'true' ? describe : describe.skip
const schema = `events_query_fixture_${process.pid}`
let created = false
suite('event pagination equivalence on MySQL', () => {
 beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || 'mysql://root:fixture-only@127.0.0.1:39485/fixture')
  db = await mariadb.createConnection({host:url.hostname,port:Number(url.port || 3306),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),allowPublicKeyRetrieval:true})
  await db.query(`CREATE DATABASE ${schema}`)
  created = true
  await db.query(`USE ${schema}`)
  await db.query('CREATE TABLE NewsletterBatch (id varchar(40) PRIMARY KEY, siteId varchar(80))')
  await db.query('CREATE TABLE NewsletterMessages (messageId varchar(40) PRIMARY KEY, newsletterBatchId varchar(40))')
  await db.query('CREATE TABLE NewsletterNotifications (id varchar(40) PRIMARY KEY, type varchar(40), created datetime(3), messageId varchar(40), INDEX idx_notifications_type_created_id(type,created,id))')
  await db.query("INSERT INTO NewsletterBatch VALUES ('b1','site'),('b2','other')")
  await db.query("INSERT INTO NewsletterMessages VALUES ('m1','b1'),('m2','b2')")
  for(let i=0;i<100;i++) await db.query('INSERT INTO NewsletterNotifications VALUES (?,?,?,?)',[String(i).padStart(4,'0'), i%2?'opened':'delivered',new Date(10000+Math.floor(i/4)*1000),i%3?'m1':'m2'])
 })
 afterAll(async () => { if (created) await db.query(`DROP DATABASE ${schema}`); await db?.end() })
 for(const order of ['asc','desc'] as const) it(`matches legacy results across tied timestamps, types, sites, offset and cursor: ${order}`, async () => {
  const params={siteId:'site',type:'delivered OR opened OR delivered',begin:9,end:50,order,limit:7,start:3,url:'https://x.test/'}
  const legacy=await db.query(`SELECT n.id,n.created FROM NewsletterNotifications n JOIN NewsletterMessages m ON m.messageId=n.messageId JOIN NewsletterBatch b ON b.id=m.newsletterBatchId WHERE n.type IN ('delivered','opened') AND b.siteId='site' AND n.created>? AND n.created<? ORDER BY n.created ${order},n.id ${order}`, [new Date(9000),new Date(50000)])
  let pageParams: typeof params & {cursor?: {v:1,created:string,id:string,order:typeof order}}=params
  const actual: string[]=[]
  for(let p=0;p<20;p++) {
   const q=buildEventIdQuery(pageParams)
   const rows=await db.query(q.sql,q.values)
   if(!rows.length)break
   actual.push(...rows.map((r:{id:string})=>r.id))
   const last=rows.at(-1)
   pageParams={...params,cursor:{v:1,created:last.created.toISOString(),id:last.id,order}}
  }
  expect(actual).toEqual(legacy.slice(3).map((r:{id:string})=>r.id))
 })
})
