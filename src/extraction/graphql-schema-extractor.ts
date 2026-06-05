import type { QueryManager } from '../db/queries.js'

export interface GraphQLType {
  typeName: string
  kind: 'type' | 'input' | 'interface' | 'union' | 'enum' | 'scalar' | 'extend'
  fields: string[]
  filePath: string
  line: number
  moduleId: string
}

export interface GraphQLOperation {
  operation: 'query' | 'mutation' | 'subscription'
  name: string
  returnType: string
  filePath: string
  line: number
  moduleId: string
}

export function indexGraphqlSchema(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): { types: GraphQLType[]; operations: GraphQLOperation[] } {
  const types: GraphQLType[] = []
  const operations: GraphQLOperation[] = []

  const typeRe = /(type|input|interface|union|enum|scalar|extend\s+type)\s+(\w+)(?:\s*\{)?/g
  let m: RegExpExecArray | null
  while ((m = typeRe.exec(source)) !== null) {
    const kind = m[1].replace(/\s+type/, '') as GraphQLType['kind']
    if (kind === 'extend') continue
    const typeName = m[2]
    const typeKind = m[1].includes('extend') ? 'extend' : kind

    const fields: string[] = []
    const braceStart = source.indexOf('{', m.index)
    if (braceStart !== -1) {
      let depth = 1
      let pos = braceStart + 1
      while (depth > 0 && pos < source.length) {
        if (source[pos] === '{') depth++
        else if (source[pos] === '}') depth--
        else if (depth === 1 && source[pos] !== '\n') {
          const fieldEnd = source.indexOf('\n', pos)
          const fieldLine = source.slice(pos, fieldEnd !== -1 ? fieldEnd : pos + 100).trim()
          if (fieldLine && !fieldLine.startsWith('}') && !fieldLine.startsWith('#')) {
            const fieldName = fieldLine.split(':')[0].split('(')[0].trim()
            if (fieldName && !fieldName.includes(' ') && !fieldName.startsWith('{')) {
              fields.push(fieldName)
            }
          }
          pos = fieldEnd !== -1 ? fieldEnd + 1 : source.length
        } else {
          pos++
        }
      }
    }

    const lines = source.split('\n')
    const lineIdx = lines.findIndex(l => l.includes(typeName) && (l.includes('type') || l.includes('input') || l.includes('interface')))

    types.push({
      typeName,
      kind: typeKind,
      fields,
      filePath,
      line: lineIdx + 1,
      moduleId,
    })

    const nodeId = `${filePath}:${typeName}`
    queries.insertAnnotation(nodeId, `GraphQL${typeKind.charAt(0).toUpperCase() + typeKind.slice(1)}`,
      JSON.stringify({ fields }), lineIdx + 1, moduleId)
  }

  const opRe = /(query|mutation|subscription)\s+(\w+)\s*\([^)]*\)\s*:\s*(\w+)/g
  let opM: RegExpExecArray | null
  while ((opM = opRe.exec(source)) !== null) {
    const match = opM
    const lines = source.split('\n')
    const lineIdx = lines.findIndex(l => l.includes(match[2]))
    operations.push({
      operation: match[1] as 'query' | 'mutation' | 'subscription',
      name: match[2],
      returnType: match[3],
      filePath,
      line: lineIdx + 1,
      moduleId,
    })

    const nodeId = `${filePath}:${match[2]}`
    queries.insertAnnotation(nodeId, `GraphQLOperation`,
      JSON.stringify({ operation: match[1], returnType: match[3] }),
      lineIdx + 1, moduleId)
  }

  return { types, operations }
}
