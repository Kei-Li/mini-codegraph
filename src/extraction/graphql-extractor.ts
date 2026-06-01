import type { QueryManager } from '../db/queries.js'

export interface GraphQLEndpoint {
  className: string
  methodName: string
  field: string
  returnType: string
  arguments: { name: string; type: string }[]
  kind: 'query' | 'mutation' | 'subscription' | 'schema'
  filePath: string
  line: number
  moduleId: string
}

const GRAPHQL_ANNOTATIONS = [
  { ann: 'QueryMapping', kind: 'query' as const },
  { ann: 'MutationMapping', kind: 'mutation' as const },
  { ann: 'SubscriptionMapping', kind: 'subscription' as const },
  { ann: 'SchemaMapping', kind: 'schema' as const },
  { ann: 'BatchMapping', kind: 'schema' as const },
]

export function indexGraphQLEndpoints(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): GraphQLEndpoint[] {
  const results: GraphQLEndpoint[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    for (const gAnn of GRAPHQL_ANNOTATIONS) {
      if (!line.trim().startsWith(`@${gAnn.ann}`)) continue

      let j = i + 1
      while (j < lines.length && !lines[j].trim().endsWith(')')) j++
      const methodLine = j < lines.length ? lines[j] : ''

      const methodMatch = methodLine.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(([^)]*)\)/)
      if (!methodMatch) continue

      const returnType = methodMatch[1]
      const methodName = methodMatch[2]
      const paramsStr = methodMatch[3]

      const args: { name: string; type: string }[] = []
      const paramParts = paramsStr.split(',')
      for (const pp of paramParts) {
        const pTrim = pp.trim()
        if (!pTrim) continue
        const parts = pTrim.split(/\s+/)
        if (parts.length >= 2) {
          const pType = parts[0]
          const pName = parts[parts.length - 1].replace(/,$/, '')
          if (!pType.startsWith('@')) {
            args.push({ name: pName, type: pType })
          }
        }
      }

      const ep: GraphQLEndpoint = {
        className: filePath.split('/').pop()?.replace('.java', '') || '',
        methodName,
        field: methodName,
        returnType: returnType.replace(/<[^>]*>/g, ''),
        arguments: args,
        kind: gAnn.kind,
        filePath,
        line: i + 1,
        moduleId,
      }
      results.push(ep)

      const nodeId = `${filePath}:${methodName}`
      const parentNodes = queries.searchNodes(ep.className, 3).filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const pn of parentNodes) {
        queries.insertAnnotation(nodeId, gAnn.ann, JSON.stringify({ field: methodName, returnType }), i + 1, moduleId)
        queries.insertEdge(pn.id, nodeId, 'graphql_handler',
          JSON.stringify({ kind: gAnn.kind, field: methodName, returnType }), i + 1, 0)
      }
    }
  }

  return results
}
