import type { QueryManager } from '../db/queries.js'

export interface SessionConfig {
  annotation: string
  storeType: 'redis' | 'jdbc' | 'mongo' | 'hazelcast' | 'cassandra' | 'generic'
  maxInactiveInterval?: number
  redisNamespace?: string
  tableName?: string
  collectionName?: string
  filePath: string
  line: number
  moduleId: string
}

const SESSION_ANNOTATIONS: Record<string, SessionConfig['storeType']> = {
  '@EnableRedisHttpSession': 'redis',
  '@EnableJdbcHttpSession': 'jdbc',
  '@EnableMongoHttpSession': 'mongo',
  '@EnableHazelcastHttpSession': 'hazelcast',
  '@EnableCassandraHttpSession': 'cassandra',
  '@EnableSpringHttpSession': 'generic',
}

export function indexSpringSession(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): SessionConfig[] {
  const results: SessionConfig[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const trim = lines[i].trim()

    for (const [ann, storeType] of Object.entries(SESSION_ANNOTATIONS)) {
      if (!trim.startsWith(ann)) continue

      const fullAnnSrc = lines.slice(i, Math.min(i + 5, lines.length)).join(' ')
      const maxInactiveInterval = fullAnnSrc.match(/maxInactiveIntervalInSeconds\s*=\s*(\d+)/)?.[1]
      const redisNamespace = fullAnnSrc.match(/redisNamespace\s*=\s*["']([^"']+)["']/)?.[1]
      const tableName = fullAnnSrc.match(/tableName\s*=\s*["']([^"']+)["']/)?.[1]
      const collectionName = fullAnnSrc.match(/collectionName\s*=\s*["']([^"']+)["']/)?.[1]

      const sc: SessionConfig = {
        annotation: ann,
        storeType,
        maxInactiveInterval: maxInactiveInterval ? parseInt(maxInactiveInterval, 10) : undefined,
        redisNamespace, tableName, collectionName,
        filePath, line: i + 1, moduleId,
      }
      results.push(sc)

      const nodeId = `${filePath}:${ann}`
      queries.insertAnnotation(nodeId, ann,
        JSON.stringify({ storeType, maxInactiveInterval, redisNamespace, tableName, collectionName }),
        i + 1, moduleId)

      const className = filePath.split('/').pop()?.replace('.java', '') || ''
      const parentNodes = queries.searchNodes(className, 3)
        .filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const pn of parentNodes) {
        queries.insertEdge(pn.id, nodeId, 'spring_session',
          JSON.stringify({ storeType, maxInactiveInterval }), i + 1, 0)
      }
      break
    }
  }

  return results
}
