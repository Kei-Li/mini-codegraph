import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../../db/queries.js'
import type { CacheAnnotation, CacheTopology } from '../../types.js'

const CACHE_ANNOTATIONS: string[] = ['Cacheable', 'CacheEvict', 'CachePut', 'Caching']

export function parseCacheAnnotationValue(
  annotationName: string,
  value: string
): Partial<CacheAnnotation> {
  const info: Partial<CacheAnnotation> = {
    type: annotationName as CacheAnnotation['type'],
    cacheNames: [],
    key: '',
    condition: '',
    unless: '',
    keyGenerator: '',
    cacheManager: '',
  }

  if (!value || value === '') return info

  const cleanValue = value.replace(/^@\w+\(|\)$/g, '')
  const parts = splitCacheArgs(cleanValue)

  for (const part of parts) {
    const trimmed = part.trim()

    if (trimmed.match(/^(value|cacheNames)\s*=\s*/)) {
      const match = trimmed.match(/(?:value|cacheNames)\s*=\s*\{?([^}]+)\}?/)
      if (match) {
        info.cacheNames = match[1].split(',').map(s =>
          s.trim().replace(/"/g, '').replace(/'/g, '')
        ).filter(Boolean)
      }
    } else if (trimmed.startsWith('key')) {
      const match = trimmed.match(/key\s*=\s*["']?([^"',)]+)["']?/)
      if (match) {
        info.key = match[1].trim()
      }
    } else if (trimmed.startsWith('condition')) {
      const match = trimmed.match(/condition\s*=\s*["']?([^"',)]+)["']?/)
      if (match) {
        info.condition = match[1].trim()
      }
    } else if (trimmed.startsWith('unless')) {
      const match = trimmed.match(/unless\s*=\s*["']?([^"',)]+)["']?/)
      if (match) {
        info.unless = match[1].trim()
      }
    } else if (trimmed.startsWith('keyGenerator')) {
      const match = trimmed.match(/keyGenerator\s*=\s*["']?(\w+)["']?/)
      if (match) {
        info.keyGenerator = match[1]
      }
    } else if (trimmed.startsWith('cacheManager')) {
      const match = trimmed.match(/cacheManager\s*=\s*["']?(\w+)["']?/)
      if (match) {
        info.cacheManager = match[1]
      }
    }
  }

  if (info.cacheNames!.length === 0 && !value.includes('cacheNames') && !value.includes('value')) {
    const firstArg = cleanValue.split(',')[0].trim().replace(/"/g, '').replace(/'/g, '')
    if (firstArg && !firstArg.includes('=')) {
      info.cacheNames = [firstArg]
    }
  }

  return info
}

function splitCacheArgs(input: string): string[] {
  const args: string[] = []
  let depth = 0
  let current = ''
  let inString = false
  let stringChar = ''

  for (const ch of input) {
    if (inString) {
      current += ch
      if (ch === stringChar) inString = false
    } else if (ch === '"' || ch === "'") {
      current += ch
      inString = true
      stringChar = ch
    } else if (ch === '(' || ch === '{') {
      depth++
      current += ch
    } else if (ch === ')' || ch === '}') {
      depth--
      current += ch
    } else if (ch === ',' && depth === 0) {
      args.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) args.push(current.trim())
  return args
}

export function extractRedisConfig(projectRoot: string): { host: string; port: number; database: number; cluster: boolean } | undefined {
  const candidates = [
    join(projectRoot, 'src', 'main', 'resources', 'application.yml'),
    join(projectRoot, 'src', 'main', 'resources', 'application.yaml'),
    join(projectRoot, 'src', 'main', 'resources', 'application.properties'),
  ]

  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const content = readFileSync(file, 'utf-8')
      if (file.endsWith('.properties')) {
        const lines = content.split('\n')
        let host = 'localhost', port = 6379, database = 0, cluster = false
        for (const line of lines) {
          const [k, v] = line.split('=').map(s => s.trim())
          if (k === 'spring.redis.host') host = v
          else if (k === 'spring.redis.port') port = parseInt(v)
          else if (k === 'spring.redis.database') database = parseInt(v)
          else if (k === 'spring.redis.cluster.nodes') cluster = true
        }
        return { host, port, database, cluster }
      }

      const hostMatch = content.match(/spring:\s*\n\s+redis:\s*\n(?:\s+.*\n)*/)
      if (hostMatch) {
        const block = hostMatch[0]
        const host = block.match(/host:\s*(\S+)/)?.[1] ?? 'localhost'
        const port = parseInt(block.match(/port:\s*(\d+)/)?.[1] ?? '6379')
        const database = parseInt(block.match(/database:\s*(\d+)/)?.[1] ?? '0')
        const cluster = block.includes('cluster:') || block.includes('sentinel:')
        return { host, port, database, cluster }
      }
    } catch { /* silent */ }
  }

  return undefined
}

export function indexCacheAnnotations(
  queries: QueryManager,
  projectRoot: string,
  moduleId: string
): { annotations: CacheAnnotation[]; topologies: CacheTopology[] } {
  const annotations: CacheAnnotation[] = []
  const allNodes = queries.getAllNodes()
  const nodeAnnCache = queries.getAllAnnotations()

  for (const node of allNodes) {
    const anns = nodeAnnCache.get(node.id) ?? []
    for (const ann of anns) {
      if (CACHE_ANNOTATIONS.includes(ann.annotationName)) {
        const parsed = parseCacheAnnotationValue(ann.annotationName, ann.value)
        const cacheAnnotation: CacheAnnotation = {
          type: ann.annotationName as CacheAnnotation['type'],
          cacheNames: parsed.cacheNames ?? [],
          key: parsed.key ?? '',
          condition: parsed.condition ?? '',
          unless: parsed.unless ?? '',
          keyGenerator: parsed.keyGenerator ?? '',
          cacheManager: parsed.cacheManager ?? '',
          nodeId: node.id,
          methodName: node.name,
          className: node.parentId ? queries.getNode(node.parentId)?.name ?? '' : '',
          filePath: node.filePath,
          line: node.startLine,
          moduleId,
        }
        annotations.push(cacheAnnotation)

        const cacheId = `cache:${moduleId}:${cacheAnnotation.cacheNames.join(',')}:${node.name}`
        queries.insertEdge(node.id, cacheId, 'cache_annotation',
          JSON.stringify(cacheAnnotation), node.startLine, 0)
      }
    }
  }

  const nodeAnnotationsCache = new Map<string, string[]>()
  for (const node of allNodes) {
    const anns = nodeAnnCache.get(node.id) ?? []
    const cacheAnns = anns
      .filter(a => CACHE_ANNOTATIONS.includes(a.annotationName))
      .map(a => a.value)
    if (cacheAnns.length > 0) {
      nodeAnnotationsCache.set(node.id, cacheAnns)
    }
  }

  for (const ann of annotations) {
    for (const cacheName of ann.cacheNames) {
      for (const [otherNodeId, otherAnns] of nodeAnnotationsCache) {
        if (otherNodeId === ann.nodeId) continue
        const match = otherAnns.some(v => v.includes(cacheName))
        if (match) {
          queries.insertEdge(ann.nodeId, otherNodeId, 'cache_related',
            JSON.stringify({ cacheName }), 0, 0)
        }
      }
    }
  }

  const redisConfig = extractRedisConfig(projectRoot)
  const cacheNameMap = new Map<string, CacheAnnotation[]>()
  for (const ann of annotations) {
    for (const name of ann.cacheNames) {
      if (!cacheNameMap.has(name)) cacheNameMap.set(name, [])
      cacheNameMap.get(name)!.push(ann)
    }
  }

  const topologies: CacheTopology[] = []
  for (const [cacheName, entries] of cacheNameMap) {
    const services = new Set<string>()
    for (const e of entries) {
      if (e.moduleId) services.add(e.moduleId)
    }
    topologies.push({
      cacheName,
      entries,
      redisConfig,
      relatedServices: Array.from(services),
    })
  }

  return { annotations, topologies }
}
