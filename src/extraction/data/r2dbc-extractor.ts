import type { QueryManager } from '../../db/queries.js'

export interface R2dbcEntity {
  className: string
  tableName: string
  columns: string[]
  filePath: string
  line: number
  moduleId: string
}

export function indexR2dbcEntities(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): R2dbcEntity[] {
  const results: R2dbcEntity[] = []
  if (!source.includes('org.springframework.data.relational') &&
      !source.includes('org.springframework.data.r2dbc')) return results

  const lines = source.split('\n')
  const className = filePath.split('/').pop()?.replace('.java', '') || ''
  let tableName = ''
  const columns: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const trim = lines[i].trim()

    if (trim.startsWith('@Table(') || trim.startsWith('@Table ') || trim === '@Table') {
      const fullAnn = lines.slice(i, i + 3).join(' ')
      tableName = fullAnn.match(/value\s*=\s*["']([^"']+)["']/)?.[1] || fullAnn.match(/name\s*=\s*["']([^"']+)["']/)?.[1] || ''
      if (tableName) tableName = tableName.toLowerCase()
      continue
    }

    if (trim.startsWith('@Column(') || trim.startsWith('@Column ') || trim === '@Column') {
      const fullAnn = lines.slice(i, i + 3).join(' ')
      const colName = fullAnn.match(/value\s*=\s*["']([^"']+)["']/)?.[1] || fullAnn.match(/name\s*=\s*["']([^"']+)["']/)?.[1] || ''
      if (colName) columns.push(colName)
    }
  }

  if (tableName || columns.length > 0) {
    const entity: R2dbcEntity = {
      className,
      tableName: tableName || className.toLowerCase(),
      columns,
      filePath, line: 1, moduleId,
    }
    results.push(entity)

    const nodeId = `${filePath}:${className}`
    queries.insertAnnotation(nodeId, 'R2dbcEntity',
      JSON.stringify({ table: entity.tableName, columns }), 1, moduleId)

    const parentNodes = queries.searchNodes(className, 3)
      .filter(n => n.moduleId === moduleId && n.filePath === filePath)
    for (const pn of parentNodes) {
      queries.insertEdge(pn.id, nodeId, 'r2dbc_entity',
        JSON.stringify({ table: entity.tableName }), 1, 0)
    }

    queries.insertEdge(nodeId, `table:${entity.tableName}`, 'database_table',
      JSON.stringify({ source: 'r2dbc', columns }), 1, 0)
  }

  return results
}
