import type { QueryManager } from '../../db/queries.js'

// ── Types ─────────────────────────────────────────────────────

export interface BatchJob {
  name: string; steps: string[]; reader?: string; processor?: string
  writer?: string; chunkSize?: number; filePath: string
}

export interface LdapEntry {
  annotation: string; className: string; baseDn?: string; filePath: string; line: number; moduleId: string
}

export interface LdapOperation {
  type: 'search' | 'lookup' | 'create' | 'update' | 'delete'
  className: string; methodName: string; filter?: string; filePath: string; line: number; moduleId: string
}

export interface SessionConfig {
  annotation: string; storeType: 'redis' | 'jdbc' | 'mongo' | 'hazelcast' | 'cassandra' | 'generic'
  maxInactiveInterval?: number; redisNamespace?: string; tableName?: string
  collectionName?: string; filePath: string; line: number; moduleId: string
}

// ── Batch ─────────────────────────────────────────────────────

export function extractBatchJobs(source: string, filePath: string): BatchJob[] {
  const jobs: BatchJob[] = []
  if (!source.includes('@EnableBatchProcessing') && !source.includes('JobBuilderFactory') && !source.includes('JobBuilder')) return jobs
  const jobMatches = source.matchAll(/(?:JobBuilder|JobBuilderFactory)\s*[.<]\s*(?:get|build)?\s*\(?\s*["'](\w+)["']/g)
  for (const jm of jobMatches) {
    const jobName = jm[1]; const steps: string[] = []
    const stepMatches = source.matchAll(/\.\s*start\s*\(?\s*(\w+)\s*\)|\.\s*next\s*\(?\s*(\w+)\s*\)/g)
    for (const sm of stepMatches) steps.push(sm[1] || sm[2])
    const chunkMatches = [...source.matchAll(/chunk\s*\((\d+)\)/g)]
    const chunkSize = chunkMatches.length > 0 ? parseInt(chunkMatches[0][1]) : undefined
    const readerMatch = source.match(/reader\s*\(\s*(\w+)\s*\)/)
    const processorMatch = source.match(/processor\s*\(\s*(\w+)\s*\)/)
    const writerMatch = source.match(/writer\s*\(\s*(\w+)\s*\)/)
    jobs.push({ name: jobName, steps, reader: readerMatch?.[1], processor: processorMatch?.[1], writer: writerMatch?.[1], chunkSize, filePath })
  }
  return jobs
}

export function indexBatchJobs(queries: QueryManager, source: string, filePath: string, _moduleId: string): BatchJob[] {
  const jobs = extractBatchJobs(source, filePath)
  if (jobs.length === 0) return jobs
  for (const job of jobs) {
    const candidates = queries.searchNodes(job.name, 10).filter(c => c.filePath === filePath)
    for (const c of candidates) queries.insertEdge(c.id, `batch:${job.name}`, 'batch_job', JSON.stringify({ steps: job.steps, chunkSize: job.chunkSize }), 0, 0)
  }
  return jobs
}

// ── LDAP ──────────────────────────────────────────────────────

export function indexSpringLdap(queries: QueryManager, source: string, filePath: string, moduleId: string): { entries: LdapEntry[]; operations: LdapOperation[] } {
  const entries: LdapEntry[] = []; const operations: LdapOperation[] = []; const lines = source.split('\n')
  const className = filePath.split('/').pop()?.replace('.java', '') || ''
  for (let i = 0; i < lines.length; i++) {
    const trim = lines[i].trim()
    if (trim.startsWith('@Entry(') || trim.startsWith('@Entry ') || trim === '@Entry') {
      const fullAnn = lines.slice(i, i + 3).join(' '); const baseDn = fullAnn.match(/base\s*=\s*["']([^"']+)["']/)?.[1]
      entries.push({ annotation: '@Entry', className, baseDn, filePath, line: i + 1, moduleId })
      const nodeId = `${filePath}:Entry`
      queries.insertAnnotation(nodeId, '@Entry', JSON.stringify({ baseDn }), i + 1, moduleId)
      const parentNodes = queries.searchNodes(className, 3).filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const pn of parentNodes) queries.insertEdge(pn.id, nodeId, 'ldap_entry', JSON.stringify({ baseDn }), i + 1, 0)
      continue
    }
    if (trim.startsWith('@LdapRepository') || trim.startsWith('@LdapRepository(')) {
      const nodeId = `${filePath}:LdapRepository`
      queries.insertAnnotation(nodeId, '@LdapRepository', '{}', i + 1, moduleId)
      const parentNodes = queries.searchNodes(className, 3).filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const pn of parentNodes) queries.insertEdge(pn.id, nodeId, 'ldap_repository', '{}', i + 1, 0)
      continue
    }
  }
  const ldapOps = [
    { pattern: /ldapTemplate\.\s*(search|find|lookup)\s*\([^)]*["']([^"']+)["']/g, type: 'search' as const },
    { pattern: /ldapTemplate\.\s*(create|bind)\s*\(/g, type: 'create' as const },
    { pattern: /ldapTemplate\.\s*(update|rebind)\s*\(/g, type: 'update' as const },
    { pattern: /ldapTemplate\.\s*(delete|unbind)\s*\(/g, type: 'delete' as const },
  ]
  for (const op of ldapOps) {
    let m: RegExpExecArray | null
    while ((m = op.pattern.exec(source)) !== null) {
      const methodName = m[2] ?? m[1]; const lineIdx = lines.findIndex(l => l.includes('ldapTemplate'))
      operations.push({ type: op.type, className, methodName, filter: m[2], filePath, line: lineIdx + 1, moduleId })
      queries.insertAnnotation(`${filePath}:ldapTemplate.${methodName}`, 'LdapOperation', JSON.stringify({ type: op.type, filter: m[2] }), lineIdx + 1, moduleId)
    }
  }
  return { entries, operations }
}

// ── Session ───────────────────────────────────────────────────

const SESSION_ANNOTATIONS: Record<string, SessionConfig['storeType']> = {
  '@EnableRedisHttpSession': 'redis', '@EnableJdbcHttpSession': 'jdbc', '@EnableMongoHttpSession': 'mongo',
  '@EnableHazelcastHttpSession': 'hazelcast', '@EnableCassandraHttpSession': 'cassandra', '@EnableSpringHttpSession': 'generic',
}

export function indexSpringSession(queries: QueryManager, source: string, filePath: string, moduleId: string): SessionConfig[] {
  const results: SessionConfig[] = []; const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trim = lines[i].trim()
    for (const [ann, storeType] of Object.entries(SESSION_ANNOTATIONS)) {
      if (!trim.startsWith(ann)) continue
      const fullAnnSrc = lines.slice(i, Math.min(i + 5, lines.length)).join(' ')
      const maxInactiveInterval = fullAnnSrc.match(/maxInactiveIntervalInSeconds\s*=\s*(\d+)/)?.[1]
      const redisNamespace = fullAnnSrc.match(/redisNamespace\s*=\s*["']([^"']+)["']/)?.[1]
      const tableName = fullAnnSrc.match(/tableName\s*=\s*["']([^"']+)["']/)?.[1]
      const collectionName = fullAnnSrc.match(/collectionName\s*=\s*["']([^"']+)["']/)?.[1]
      const sc: SessionConfig = { annotation: ann, storeType, maxInactiveInterval: maxInactiveInterval ? parseInt(maxInactiveInterval, 10) : undefined, redisNamespace, tableName, collectionName, filePath, line: i + 1, moduleId }
      results.push(sc)
      const nodeId = `${filePath}:${ann}`
      queries.insertAnnotation(nodeId, ann, JSON.stringify({ storeType, maxInactiveInterval, redisNamespace, tableName, collectionName }), i + 1, moduleId)
      const className = filePath.split('/').pop()?.replace('.java', '') || ''
      const parentNodes = queries.searchNodes(className, 3).filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const pn of parentNodes) queries.insertEdge(pn.id, nodeId, 'spring_session', JSON.stringify({ storeType, maxInactiveInterval }), i + 1, 0)
      break
    }
  }
  return results
}
