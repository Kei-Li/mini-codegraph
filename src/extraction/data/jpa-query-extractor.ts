import type { QueryManager } from '../../db/queries.js'

export interface JpaCustomQuery {
  repositoryClass: string
  methodName: string
  query: string
  nativeQuery: boolean
  countQuery: string
  modification: boolean
  flushAutomatically: boolean
  clearAutomatically: boolean
  filePath: string
  line: number
  moduleId: string
}

export interface JpaProcedure {
  repositoryClass: string
  procedureName: string
  outputParameterType: string
  parameters: { mode: string; type: string; name: string }[]
  filePath: string
  line: number
  moduleId: string
}

export function indexJpaCustomQueries(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): { foundQueries: JpaCustomQuery[]; procedures: JpaProcedure[] } {
  const foundQueries: JpaCustomQuery[] = []
  const procedures: JpaProcedure[] = []
  const lines = source.split('\n')

  const repoClass = filePath.split('/').pop()?.replace('.java', '') || ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

      if (line.trim().startsWith('@Query')) {
      let j = i
      while (j < lines.length && !lines[j].trim().endsWith(')') && !lines[j].trim().includes(');')) j++
      const fullSrc = lines.slice(i, j + 1).join(' ')

      const valueMatch = fullSrc.match(/@Query\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/)
      const nativeMatch = fullSrc.includes('nativeQuery = true')
      const countMatch = fullSrc.match(/countQuery\s*=\s*["']([^"']+)["']/)

      if (!valueMatch) continue

      let methodLine = ''
      for (let k = i; k <= Math.min(j + 2, lines.length - 1); k++) {
        const ml = lines[k]?.trim() || ''
        if (!ml) continue
        const mMethod = ml.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
        if (mMethod) { methodLine = ml; break }
      }
      const methodMatch = methodLine.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
      if (!methodMatch) continue

      const methodName = methodMatch[2]

      const jq: JpaCustomQuery = {
        repositoryClass: repoClass,
        methodName,
        query: valueMatch[1],
        nativeQuery: nativeMatch,
        countQuery: countMatch?.[1] || '',
        modification: false,
        flushAutomatically: false,
        clearAutomatically: false,
        filePath,
        line: i + 1,
        moduleId,
      }

      for (let k = i - 2; k <= i + 2; k++) {
        if (k >= 0 && k < lines.length && lines[k].includes('@Modifying')) {
          jq.modification = true
          jq.flushAutomatically = lines[k].includes('flushAutomatically = true')
          jq.clearAutomatically = lines[k].includes('clearAutomatically = true')
        }
      }

      foundQueries.push(jq)

      const nodeId = `${filePath}:${methodName}`
      const parentNodes = queries.searchNodes(repoClass, 3)
        .filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const pn of parentNodes) {
        queries.insertAnnotation(pn.id, 'JpaQuery',
          JSON.stringify({ query: jq.query, native: jq.nativeQuery, modification: jq.modification }),
          i + 1, moduleId)
        queries.insertEdge(pn.id, `${filePath}:${methodName}`, 'jpa_query',
          JSON.stringify({ query: jq.query, native: jq.nativeQuery, modification: jq.modification }),
          i + 1, 0)
      }

      if (jq.nativeQuery) {
        const tableRefs = jq.query.match(/(?:from|FROM|join|JOIN|update|UPDATE|insert into|INSERT INTO|delete from|DELETE FROM)\s+(\w+)/g)
        if (tableRefs) {
          for (const tr of tableRefs) {
            const tableName = tr.split(/\s+/).pop() || ''
            const jpaNodes = queries.getAllNodes().filter(n => n.kind === 'class' && n.moduleId === moduleId)
            for (const jn of jpaNodes) {
              const anns = queries.getAnnotationsByNode(jn.id)
              const tableAnn = anns.find(a => a.annotationName === 'Table')
              if (tableAnn?.value?.toLowerCase() === tableName.toLowerCase() || jn.name.toLowerCase() === tableName.toLowerCase()) {
                queries.insertEdge(nodeId, jn.id, 'jpa_query_table',
                  JSON.stringify({ query: jq.query, table: tableName }), i + 1, 0)
              }
            }
          }
        }
      }
    }

    if (line.trim().startsWith('@Procedure')) {
      let j = i
      while (j < lines.length && !lines[j].trim().endsWith(')') && !lines[j].trim().includes(');')) j++
      const fullSrc = lines.slice(i, j + 1).join(' ')

      const procName = fullSrc.match(/@Procedure\s*\(\s*["']([^"']+)["']/)?.[1]
        || fullSrc.match(/@Procedure\s*\(\s*value\s*=\s*["']([^"']+)["']/)?.[1]
        || fullSrc.match(/@Procedure\s*\(\s*procedureName\s*=\s*["']([^"']+)["']/)?.[1]
        || ''

      let methodLine = ''
      for (let k = i; k <= Math.min(j + 2, lines.length - 1); k++) {
        const ml = lines[k]?.trim() || ''
        if (ml && !ml.startsWith('@') && !ml.startsWith('import') && !ml.startsWith('package') && ml !== '') {
          methodLine = ml
          break
        }
      }
      const methodMatch = methodLine.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\((?:([^)]*))?/)
      if (!methodMatch) continue

      const outputType = methodMatch[1]
      const methodName = methodMatch[2]
      const paramsStr = methodMatch[3] || ''

      const params: JpaProcedure['parameters'] = paramsStr.split(',')
        .filter(p => p.trim())
        .map(p => {
          const parts = p.trim().split(/\s+/)
          const type = parts[0] || ''
          const name = parts[parts.length - 1]?.replace(/,/g, '') || ''
          return { mode: 'IN', type, name }
        })

      procedures.push({
        repositoryClass: repoClass,
        procedureName: procName || methodName,
        outputParameterType: outputType,
        parameters: params,
        filePath,
        line: i + 1,
        moduleId,
      })

      const parentNodes = queries.searchNodes(repoClass, 3)
        .filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const pn of parentNodes) {
        queries.insertAnnotation(pn.id, 'JpaProcedure',
          JSON.stringify({ procedureName: procName || methodName, outputType }),
          i + 1, moduleId)
      }
    }
  }

  return { foundQueries, procedures }
}
