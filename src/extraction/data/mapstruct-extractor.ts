import type { QueryManager } from '../../db/queries.js'

export interface MapStructMapping {
  mapperInterface: string
  methodName: string
  sourceType: string
  targetType: string
  fieldMappings: { source: string; target: string }[]
  filePath: string
}

export function indexMapStructMappers(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): MapStructMapping[] {
  const results: MapStructMapping[] = []

  const mapperAnnMatch = source.match(/@Mapper\s*(?:\([^)]*\))?\s*(?:public\s+)?interface\s+(\w+)/)
  if (!mapperAnnMatch) return results
  const mapperName = mapperAnnMatch[1]
  const mapperNodes = queries.searchNodes(mapperName, 10)
    .filter(n => n.filePath === filePath && n.moduleId === moduleId && n.kind === 'interface')
  if (mapperNodes.length === 0) return results
  const mapperNode = mapperNodes[0]

  queries.insertAnnotation(mapperNode.id, 'Mapper', 'componentModel=spring', 0, moduleId)

  const lines = source.split('\n')
  let currentMethod: { name: string; sourceType: string; targetType: string; fieldMappings: { source: string; target: string }[] } | null = null
  const pendingMappings: { source: string; target: string }[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    const mappingMatch = line.match(/^@Mapping\s*\(\s*source\s*=\s*["']([^"']+)["']\s*,\s*target\s*=\s*["']([^"']+)["']/)
    if (mappingMatch) {
      pendingMappings.push({ source: mappingMatch[1], target: mappingMatch[2] })
      continue
    }

    const methodMatch = line.match(/(\w+(?:<\w+>)?)\s+(\w+)\s*\((\w+(?:<\w+>)?)\s+\w+\)/)
    if (methodMatch && line.includes(';') && !line.startsWith('@') && !line.startsWith('//') && !line.startsWith('default ')) {
      const returnType = methodMatch[1]
      const methodName = methodMatch[2]
      const sourceType = methodMatch[3]

      if (returnType !== 'void' && sourceType !== returnType) {
        currentMethod = { name: methodName, sourceType, targetType: returnType, fieldMappings: [...pendingMappings] }

        const sourceNodes = queries.searchNodes(sourceType.replace(/<[^>]*>/g, ''), 5)
        const targetNodes = queries.searchNodes(returnType.replace(/<[^>]*>/g, ''), 5)

        for (const sn of sourceNodes) {
          if (sn.moduleId === moduleId && sn.kind === 'class') {
            queries.insertEdge(sn.id, mapperNode.id,
              'mapstruct_source', JSON.stringify({ mapper: mapperNode.name, method: methodName, sourceType }), i + 1, 0)
          }
        }

        for (const tn of targetNodes) {
          if (tn.moduleId === moduleId && tn.kind === 'class') {
            queries.insertEdge(mapperNode.id, tn.id,
              'mapstruct_target', JSON.stringify({ mapper: mapperNode.name, method: methodName, targetType: returnType }), i + 1, 0)
          }
        }

        const methodNodes = queries.searchNodes(methodName, 10)
          .filter(n => n.filePath === filePath && n.moduleId === moduleId && n.kind === 'method')
        for (const mn of methodNodes) {
          queries.insertAnnotation(mn.id, 'Mapping',
            currentMethod.fieldMappings.map(m => `${m.source}→${m.target}`).join(', '), i + 1, moduleId)
        }

        results.push({
          mapperInterface: mapperNode.name,
          methodName,
          sourceType,
          targetType: returnType,
          fieldMappings: [...pendingMappings],
          filePath,
        })

        currentMethod = null
        pendingMappings.length = 0
      }
    }

    if (!line.startsWith('@') && !line.startsWith('import') && !line.startsWith('package') && !line.startsWith('/*') && !line.startsWith('*')) {
      if (!methodMatch || !line.includes(';')) {
        pendingMappings.length = 0
      }
    }
  }

  return results
}
