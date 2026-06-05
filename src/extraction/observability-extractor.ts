import type { QueryManager } from '../db/queries.js'

export interface ObservationPoint {
  classFile: string
  methodName: string
  kind: 'observed' | 'timed' | 'counted' | 'span_tag'
  name?: string
  description?: string
  line: number
  moduleId: string
}

export function indexObservationAnnotations(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): ObservationPoint[] {
  const results: ObservationPoint[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    let kind: ObservationPoint['kind'] | null = null
    let name: string | undefined
    let description: string | undefined

    if (line.startsWith('@Observed') || line.startsWith('@Observation')) {
      kind = 'observed'
      const nameMatch = line.match(/name\s*=\s*["']([^"']+)["']/)
      if (nameMatch) name = nameMatch[1]
    } else if (line.startsWith('@Timed')) {
      kind = 'timed'
      const nameMatch = line.match(/value\s*=\s*["']([^"']+)["']/)
      if (nameMatch) name = nameMatch[1]
    } else if (line.startsWith('@Counted')) {
      kind = 'counted'
      const nameMatch = line.match(/value\s*=\s*["']([^"']+)["']/)
      if (nameMatch) name = nameMatch[1]
    } else if (line.startsWith('@SpanTag')) {
      kind = 'span_tag'
    }

    if (!kind) continue

    let j = i + 1
    while (j < lines.length && !lines[j].trim().includes('(') && !lines[j].trim().includes('{')) j++
    const methodLine = lines[j] || lines[i]
    const methodMatch = methodLine.match(/(?:\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
    if (!methodMatch) continue

    const methodName = methodMatch[1]

    const obs: ObservationPoint = {
      classFile: filePath,
      methodName,
      kind,
      name,
      description,
      line: i + 1,
      moduleId,
    }
    results.push(obs)

    const nodeId = `${filePath}:${methodName}`
    const parentNodes = queries.searchNodes(filePath.split('/').pop()?.replace('.java', '') || '', 3)
      .filter(n => n.moduleId === moduleId && n.filePath === filePath)
    for (const pn of parentNodes) {
      queries.insertAnnotation(nodeId, kind === 'observed' ? 'Observed' : kind === 'timed' ? 'Timed' : 'Counted',
        JSON.stringify({ name, description }), i + 1, moduleId)
      queries.insertEdge(pn.id, nodeId, 'observation_point',
        JSON.stringify({ kind, name, description }), i + 1, 0)
    }

    if (source.includes('management.tracing') || source.includes('micrometer-tracing') || source.includes('ObservationRegistry')) {
      queries.insertAnnotation(nodeId, 'TracingEnabled', '{}', i + 1, moduleId)
    }
  }

  return results
}
