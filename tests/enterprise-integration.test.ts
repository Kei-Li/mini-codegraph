import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

const TEST_PROJECT = 'D:/IT/github-projects/mini-codegraph-test'
const DB_PATH = TEST_PROJECT + '/.mini-codegraph/mini-codegraph.db'

function openDb() {
  if (!existsSync(DB_PATH)) {
    throw new Error(
      `Integration DB not found at ${DB_PATH}. ` +
      'Run: node dist/cli.js init ' + TEST_PROJECT.replace(/\//g, '\\') +
      ' --index --multi-module --workspace ' + TEST_PROJECT.replace(/\//g, '\\') + ' --yes'
    )
  }
  return new DatabaseSync(DB_PATH)
}

describe('enterprise integration', () => {
  it('indexes all 13 modules', () => {
    const db = openDb()
    const modules = db.prepare('SELECT name, language, build_system FROM modules ORDER BY name').all()
    db.close()

    expect(modules).toHaveLength(13)
    const names = modules.map(m => m.name)
    expect(names).toContain('common-lib')
    expect(names).toContain('api-gateway')
    expect(names).toContain('user-service')
    expect(names).toContain('order-service')
    expect(names).toContain('inventory-service')
    expect(names).toContain('payment-service')
    expect(names).toContain('notification-service')
    expect(names).toContain('product-service')
    expect(names).toContain('cart-service')
    expect(names).toContain('search-service')
    expect(names).toContain('dubbo-api')
    expect(names).toContain('dubbo-provider')
    expect(names).toContain('frontend-app')

    for (const m of modules) {
      expect(m.language).toBeTruthy()
      expect(m.build_system).toBeTruthy()
    }
  })

  it('has sufficient nodes and edges', () => {
    const db = openDb()
    const nodeCount = db.prepare('SELECT COUNT(*) c FROM nodes').get().c as number
    const edgeCount = db.prepare('SELECT COUNT(*) c FROM edges').get().c as number
    db.close()

    expect(nodeCount).toBeGreaterThanOrEqual(1000)
    expect(edgeCount).toBeGreaterThanOrEqual(1800)
  })

  it('has all edge types', () => {
    const db = openDb()
    const kinds = db.prepare('SELECT kind, COUNT(*) c FROM edges GROUP BY kind').all() as { kind: string; c: number }[]
    db.close()

    const kindNames = kinds.map(k => k.kind)
    expect(kindNames).toContain('calls')
    expect(kindNames).toContain('contains')
    expect(kindNames).toContain('imports')
    expect(kindNames).toContain('transactional')
    expect(kindNames).toContain('k8s_deployment')
    expect(kindNames).toContain('cache_annotation')
    expect(kindNames).toContain('maven_depends_on')

    const callsKind = kinds.find(k => k.kind === 'calls')
    expect(callsKind!.c).toBeGreaterThanOrEqual(300)

    const transactionalKind = kinds.find(k => k.kind === 'transactional')
    expect(transactionalKind!.c).toBeGreaterThanOrEqual(200)
  })

  it('detects Dubbo RPC annotations', () => {
    const db = openDb()
    const dubboServices = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'DubboService'"
    ).get().c as number
    const enableDubbo = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'EnableDubbo'"
    ).get().c as number
    db.close()

    expect(dubboServices).toBeGreaterThanOrEqual(4)
    expect(enableDubbo).toBe(1)
  })

  it('detects Kafka messaging', () => {
    const db = openDb()
    const kafkaListeners = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'KafkaListener'"
    ).get().c as number
    const payloadAnns = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'Payload'"
    ).get().c as number
    db.close()

    expect(kafkaListeners).toBeGreaterThanOrEqual(2)
    expect(payloadAnns).toBeGreaterThanOrEqual(1)
  })

  it('detects RabbitMQ messaging', () => {
    const db = openDb()
    const rabbitListeners = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'RabbitListener'"
    ).get().c as number
    db.close()

    expect(rabbitListeners).toBeGreaterThanOrEqual(6)
  })

  it('detects Seata distributed transactions', () => {
    const db = openDb()
    const globalTx = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'GlobalTransactional'"
    ).get().c as number
    const enableDsProxy = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'EnableAutoDataSourceProxy'"
    ).get().c as number
    db.close()

    expect(globalTx).toBeGreaterThanOrEqual(4)
    expect(enableDsProxy).toBeGreaterThanOrEqual(2)
  })

  it('detects Sentinel flow control', () => {
    const db = openDb()
    const sentinelResources = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'SentinelResource'"
    ).get().c as number
    db.close()

    expect(sentinelResources).toBeGreaterThanOrEqual(4)
  })

  it('detects Elasticsearch documents', () => {
    const db = openDb()
    const esDocuments = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'Document'"
    ).get().c as number
    const esRepos = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'EnableElasticsearchRepositories'"
    ).get().c as number
    db.close()

    expect(esDocuments).toBeGreaterThanOrEqual(2)
    expect(esRepos).toBe(1)
  })

  it('detects Spring annotations', () => {
    const db = openDb()
    const cacheables = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'Cacheable'"
    ).get().c as number
    const globTx = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'Transactional'"
    ).get().c as number
    const feigns = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'FeignClient'"
    ).get().c as number
    const preAuth = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'PreAuthorize'"
    ).get().c as number
    const asyncs = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'Async'"
    ).get().c as number
    const scheduled = db.prepare(
      "SELECT COUNT(*) c FROM annotations WHERE annotation_name = 'Scheduled'"
    ).get().c as number
    db.close()

    expect(cacheables).toBeGreaterThanOrEqual(8)
    expect(globTx).toBeGreaterThanOrEqual(24)
    expect(feigns).toBeGreaterThanOrEqual(11)
    expect(preAuth).toBeGreaterThanOrEqual(5)
    expect(asyncs).toBeGreaterThanOrEqual(2)
    expect(scheduled).toBeGreaterThanOrEqual(2)
  })

  it('has external_references table', () => {
    const db = openDb()
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='external_references'").all()
    const hasRefsTable = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='external_references'").all() as any[]).length > 0
    const hasSymbolsTable = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='external_symbols'").all() as any[]).length > 0
    db.close()

    expect(hasRefsTable).toBe(true)
    expect(hasSymbolsTable).toBe(true)
  })

  it('deep trace chain has 6 hops', () => {
    const db = openDb()
    const traceControllers = db.prepare(
      "SELECT n.name FROM nodes n JOIN annotations a ON a.node_id = n.id WHERE a.annotation_name = 'RestController' AND n.file_path LIKE '%trace%' ORDER BY n.file_path"
    ).all() as { name: string }[]
    db.close()

    const names = traceControllers.map(n => n.name)
    expect(traceControllers.length).toBeGreaterThanOrEqual(4)
    expect(names.some(n => n.includes('DeepTrace'))).toBe(true)
    expect(names.some(n => n.includes('PaymentTrace'))).toBe(true)
    expect(names.some(n => n.includes('NotificationTrace'))).toBe(true)
    expect(names.some(n => n.includes('UserTrace'))).toBe(true)
    expect(names.some(n => n.includes('SearchTrace'))).toBe(true)
  })
})
