import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'

export class RedisExtractor implements IExtractor {
  name = 'redis'

  async extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    const cacheAnnotationNames = ['Cacheable', 'CachePut', 'CacheEvict', 'Caching']
    for (const annName of cacheAnnotationNames) {
      const cacheNodes = queries.getNodesByAnnotation(annName)
      for (const node of cacheNodes) {
        const anns = queries.getAnnotationsByNode(node.id)
        for (const a of anns) {
          if (a.annotationName === 'Caching') {
            const cacheableMatch = a.value.match(/cacheable\s*=\s*\{@Cacheable\(([^)]+)/)
            if (cacheableMatch) {
              const names = cacheableMatch[1].match(/value\s*=\s*\{([^}]+)\}/) || cacheableMatch[1].match(/cacheNames\s*=\s*\{([^}]+)\}/)
              if (names) {
                for (const n of names[1].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean)) {
                  provides.push({ id: `cache.redis.${n}`, name: n, kind: 'cache_key', signature: `cache:${n}` })
                }
              }
            }
          } else if (a.annotationName === annName) {
            const cacheNames = a.value.match(/cacheNames\s*=\s*\{([^}]+)\}/) || a.value.match(/value\s*=\s*\{([^}]+)\}/)
            if (cacheNames) {
              const names = cacheNames[1].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean)
              for (const name of names) {
                provides.push({
                  id: `cache.redis.${name}`,
                  name,
                  kind: 'cache_key',
                  signature: `cache:${name}`,
                })
              }
            }
          }
        }
      }
    }

    const redisHashNodes = queries.getNodesByIdPrefix('redis:hash:')
    for (const node of redisHashNodes) {
      provides.push({
        id: `redis.hash.${node.name}`,
        name: node.name,
        kind: 'cache_key',
        signature: node.signature || 'redis_hash',
      })
    }

    const redisTemplateNodes = queries.getNodesByIdPrefix('redis:template:')
    for (const node of redisTemplateNodes) {
      consumes.push({
        symbolId: `redis.ops.${node.name}`,
        referenceType: 'cache_get',
        sourceLocation: `${node.filePath}:${node.startLine}:${node.startColumn}`,
      })
    }

    return { provides, consumes }
  }
}
