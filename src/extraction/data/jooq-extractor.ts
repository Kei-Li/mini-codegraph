import type { QueryManager } from '../../db/queries.js'

export interface JooqTableAccess {
  tableName: string
  className: string
  methodName: string
  operation: 'select' | 'insert' | 'update' | 'delete' | 'ddl'
  filePath: string
  line: number
  moduleId: string
}

export interface JooqConfig {
  dialect?: string
  className: string
  filePath: string
  line: number
  moduleId: string
}

export function indexJooqUsage(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): { tables: JooqTableAccess[]; configs: JooqConfig[] } {
  const tables: JooqTableAccess[] = []
  const configs: JooqConfig[] = []
  const lines = source.split('\n')
  const className = filePath.split('/').pop()?.replace('.java', '') || ''

  if (!source.includes('org.jooq') && !source.includes('DSLContext') &&
      !source.includes('DSL.') && !source.includes('jooq')) return { tables, configs }

  const dslPatterns = [
    { pattern: /DSLContext\s+\w+\s*[.=].*?\.(select(?:Distinct)?|insert(?:Into)?|update|delete(?:From)?)\s*\(\s*["']?(\w+)["']?\s*\.?\w*\s*/g, op: 'select' as const },
    { pattern: /DSL\.(select(?:Distinct)?|insert(?:Into)?|update|delete(?:From)?)\s*\(\s*(\w+)\.\w+/g, op: 'select' as const },
    { pattern: /dsl\.(select(?:Distinct)?|insert(?:Into)?|update|delete(?:From)?)\s*\(\s*(\w+)\.\w+/g, op: 'select' as const },
  ]

  for (const dp of dslPatterns) {
    let m: RegExpExecArray | null
    while ((m = dp.pattern.exec(source)) !== null) {
      const methodName = m[1]
      const tableRef = m[2]
      const lineIdx = lines.findIndex(l => l.includes(tableRef) || l.includes('DSL'))
      tables.push({
        tableName: tableRef.toLowerCase(),
        className, methodName,
        operation: dp.op,
        filePath, line: lineIdx + 1, moduleId,
      })
    }
  }

  const dialectMatch = source.match(/\.(MYSQL|POSTGRES|H2|HSQLDB|SQLITE|MARIADB|ORACLE|SQLSERVER|DB2|DERBY)\b/)
  if (dialectMatch) {
    configs.push({
      dialect: dialectMatch[1],
      className, filePath, line: 1, moduleId,
    })
    queries.insertAnnotation(`${filePath}:DSL`, 'JooqDialect',
      JSON.stringify({ dialect: dialectMatch[1] }), 1, moduleId)
  }

  for (const t of tables) {
    const nodeId = `${filePath}:${t.tableName}`
    queries.insertAnnotation(nodeId, 'JooqTableAccess',
      JSON.stringify({ table: t.tableName, operation: t.operation, method: t.methodName }),
      t.line, moduleId)

    const parentNodes = queries.searchNodes(className, 3)
      .filter(n => n.moduleId === moduleId && n.filePath === filePath)
    for (const pn of parentNodes) {
      queries.insertEdge(pn.id, nodeId, 'jooq_table_access',
        JSON.stringify({ table: t.tableName, operation: t.operation }), t.line, 0)
    }

    queries.insertEdge(nodeId, `table:${t.tableName}`, 'database_table',
      JSON.stringify({ source: 'jooq', operation: t.operation }), t.line, 0)
  }

  return { tables, configs }
}
