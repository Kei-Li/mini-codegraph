import type { QueryManager } from '../../db/queries.js'

export interface RedisHash {
  className: string
  filePath: string
  redisKey: string
  fields: { name: string; type: string }[]
  ttl?: string
}

export interface RedisRepo {
  className: string
  filePath: string
  entityClass: string
  operations: string[]
}

export interface RedisTemplateUsage {
  className: string
  filePath: string
  operations: string[]
  keyPatterns: string[]
}

export function extractRedisHashes(source: string, filePath: string): RedisHash[] {
  const hashes: RedisHash[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const hashMatch = line.match(/@RedisHash\s*\(\s*["']([^"']+)["']\s*\)/)
    if (!hashMatch) continue

    const classLine = lines[i + 1]?.trim() || lines[i].trim()
    const classMatch = classLine.match(/(?:public\s+)?class\s+(\w+)/)
    if (!classMatch) continue

    const className = classMatch[1]
    const redisKey = hashMatch[1]
    const fields: { name: string; type: string }[] = []
    let ttl: string | undefined

    for (let j = i; j < Math.min(lines.length, i + 50); j++) {
      const fl = lines[j].trim()
      if (fl.startsWith('@TimeToLive')) {
        const ttlLine = lines[j + 1]?.trim() || ''
        const ttlMatch = ttlLine.match(/(?:private|public)\s+(\S+)\s+(\w+)/)
        if (ttlMatch) ttl = ttlMatch[2]
      }
      if (fl.startsWith('@Id') || fl.startsWith('@Indexed')) {
        const fieldLine = lines[j + 1]?.trim() || ''
        const fieldMatch = fieldLine.match(/(?:private|public)\s+(\S+)\s+(\w+)/)
        if (fieldMatch) fields.push({ name: fieldMatch[2], type: fieldMatch[1] })
      }
    }

    hashes.push({ className, filePath, redisKey, fields, ttl })
  }

  return hashes
}

export function extractRedisTemplate(source: string, filePath: string): RedisTemplateUsage | null {
  const templateFields = source.match(/(?:private|public)\s+(?:RedisTemplate|StringRedisTemplate)\s+(\w+)/g)
  if (!templateFields) return null

  const classMatch = source.match(/(?:public\s+)?class\s+(\w+)/)
  if (!classMatch) return null

  const operations: string[] = []
  const opPatterns = ['opsForValue', 'opsForHash', 'opsForList', 'opsForSet', 'opsForZSet', 'opsForStream', 'convertAndSend']
  for (const op of opPatterns) {
    if (source.includes(op)) operations.push(op)
  }

  const keyPatterns: string[] = []
  const keyMatches = source.matchAll(/["']([^"']*(?:cache|session|token|redis|key)[^"']*)["']/gi)
  for (const km of keyMatches) {
    if (!keyPatterns.includes(km[1])) keyPatterns.push(km[1])
  }

  return { className: classMatch[1], filePath, operations, keyPatterns: keyPatterns.slice(0, 10) }
}

export function extractRedisRepo(source: string, filePath: string): RedisRepo | null {
  const repoMatch = source.match(/(?:interface|class)\s+(\w+)\s+extends\s+\w*CrudRepository\s*<\s*(\w+)/)
  if (!repoMatch) return null

  const operations: string[] = []
  const methodMatches = source.matchAll(/(find\w+|save|delete\w+|count|exists)\s*\(/g)
  for (const m of methodMatches) {
    if (!operations.includes(m[1])) operations.push(m[1])
  }

  return { className: repoMatch[1], filePath, entityClass: repoMatch[2], operations }
}

export function indexRedisAnnotations(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): { hashes: RedisHash[]; templates: RedisTemplateUsage[]; repos: RedisRepo[] } {
  const hashes = extractRedisHashes(source, filePath)
  const template = extractRedisTemplate(source, filePath)
  const repo = extractRedisRepo(source, filePath)

  for (const hash of hashes) {
    const nodeId = `redis:hash:${filePath}:${hash.className}`
    queries.insertNode({
      id: nodeId, kind: 'redis_hash', name: hash.className, qualifiedName: hash.className,
      filePath, language: 'java', startLine: 0, endLine: 0, startColumn: 0, endColumn: 0,
      docstring: '', signature: JSON.stringify({
        redisKey: hash.redisKey, fields: hash.fields, ttl: hash.ttl,
      }),
      visibility: 'public', isExported: false, parentId: null, moduleId,
    })
  }

  const templates: RedisTemplateUsage[] = []
  if (template) {
    templates.push(template)
    const nodeId = `redis:template:${filePath}:${template.className}`
    queries.insertNode({
      id: nodeId, kind: 'redis_template', name: template.className,
      qualifiedName: template.className, filePath, language: 'java',
      startLine: 0, endLine: 0, startColumn: 0, endColumn: 0,
      docstring: '', signature: JSON.stringify({
        operations: template.operations, keyPatterns: template.keyPatterns,
      }),
      visibility: 'public', isExported: false, parentId: null, moduleId,
    })
  }

  const repos: RedisRepo[] = []
  if (repo) {
    repos.push(repo)
    const nodeId = `redis:repo:${filePath}:${repo.className}`
    queries.insertNode({
      id: nodeId, kind: 'redis_repository', name: repo.className,
      qualifiedName: repo.className, filePath, language: 'java',
      startLine: 0, endLine: 0, startColumn: 0, endColumn: 0,
      docstring: '', signature: JSON.stringify({
        entityClass: repo.entityClass, operations: repo.operations,
      }),
      visibility: 'public', isExported: false, parentId: null, moduleId,
    })
  }

  return { hashes, templates, repos }
}
