import type { QueryManager } from '../db/queries.js'

const RESILIENCE_ANNOTATIONS = new Set([
  'CircuitBreaker', 'Retry', 'Bulkhead', 'RateLimiter', 'TimeLimiter',
  'Fallback', 'HystrixCommand', 'HystrixCollapser',
])

export function extractResilienceAnnotations(source: string, filePath: string): {
  annotationName: string; value: string; line: number; methodName: string
}[] {
  const results: { annotationName: string; value: string; line: number; methodName: string }[] = []

  for (const ann of RESILIENCE_ANNOTATIONS) {
    const pattern = new RegExp(`@${ann}\\s*\\(([^)]*)\\)`, 'g')
    let m: RegExpExecArray | null
    while ((m = pattern.exec(source)) !== null) {
      const value = m[1]?.trim() ?? ''
      const line = source.substring(0, m.index).split('\n').length

      let methodName = 'unknown'
      const lines = source.split('\n')
      for (let j = line - 1; j < Math.min(line + 3, lines.length); j++) {
        const dl = lines[j]?.trim() ?? ''
        const idMatch = dl.match(/(?:public\s+)?(?:\w+\s+)?(\w+)\s*\(/)
        if (idMatch) { methodName = idMatch[1]; break }
      }

      results.push({ annotationName: ann, value, line, methodName })
    }
  }

  return results
}

export function indexResilience(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): void {
  const annotations = extractResilienceAnnotations(source, filePath)
  for (const a of annotations) {
    const candidates = queries.searchNodes(a.methodName, 10)
      .filter(n => n.filePath === filePath)
    for (const c of candidates) {
      queries.insertEdge(c.id, `resilience:${a.annotationName}:${c.id}`,
        'resilience_policy',
        JSON.stringify({ annotation: a.annotationName, value: a.value, fallbackMethod: a.value.match(/fallbackMethod\s*=\s*"(\w+)"/)?.[1] ?? '' }),
        a.line, 0)
    }
  }
}
