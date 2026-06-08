import type { QueryManager } from '../../db/queries.js'

export interface DDLTable {
  tableName: string
  filePath: string
  columns: { name: string; type: string; nullable: boolean; key: string; extra: string }[]
  indexes: { name: string; columns: string; unique: boolean }[]
  engine?: string
  charset?: string
}

export interface SQLStatement {
  filePath: string
  className: string
  methodName: string
  sql: string
  dbType: 'mybatis' | 'jpa' | 'jdbc'
  parameters: string[]
  returnType: string
}

const DDL_PATTERNS = [
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`?\w+`?\.)?`?(\w+)`?\s*\(/i,
  /ALTER\s+TABLE\s+(?:`?\w+`?\.)?`?(\w+)`?/i,
]

function extractDDL(filePath: string, source: string): DDLTable[] {
  const tables: DDLTable[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    for (const pattern of DDL_PATTERNS) {
      const match = line.match(pattern)
      if (!match) continue

      const tableName = match[1]
      const columns: { name: string; type: string; nullable: boolean; key: string; extra: string }[] = []
      const indexes: { name: string; columns: string; unique: boolean }[] = []
      let engine: string | undefined
      let charset: string | undefined

      let j = i + 1
      while (j < lines.length && !lines[j].trim().startsWith(';') && !lines[j].trim().startsWith(')')) {
        const colLine = lines[j].trim()
        if (colLine.startsWith('`') || /^\w+\s/.test(colLine)) {
          if (!colLine.includes('INDEX') && !colLine.includes('KEY') && !colLine.includes('CONSTRAINT')) {
            const colMatch = colLine.match(/`?(\w+)`?\s+(\w+(?:\([^)]*\))?(?:\s+\w+)*)\s*,?\s*(?:NOT\s+NULL|NULL|DEFAULT\s+\S+|AUTO_INCREMENT|PRIMARY\s+KEY)?/i)
            if (colMatch) {
              columns.push({
                name: colMatch[1], type: colMatch[2],
                nullable: !colLine.includes('NOT NULL'),
                key: colLine.includes('PRI') || colLine.includes('PRIMARY') ? 'PRI' :
                     colLine.includes('UNI') ? 'UNI' : colLine.includes('MUL') ? 'MUL' : '',
                extra: colLine.includes('AUTO_INCREMENT') ? 'auto_increment' : '',
              })
            }
          } else if (colLine.includes('INDEX') || colLine.includes('KEY')) {
            const idxMatch = colLine.match(/(?:UNIQUE\s+)?(?:INDEX|KEY)\s+(?:`?(\w+)`?)?\s*\(`?([^`)]+)`?\)/i)
            if (idxMatch) {
              indexes.push({
                name: idxMatch[1] || '',
                columns: idxMatch[2],
                unique: colLine.includes('UNIQUE'),
              })
            }
          }
        }
        if (colLine.includes('ENGINE=')) {
          const eMatch = colLine.match(/ENGINE\s*=\s*(\w+)/i)
          if (eMatch) engine = eMatch[1]
        }
        if (colLine.includes('CHARSET=') || colLine.includes('CHARACTER SET')) {
          const cMatch = colLine.match(/(?:CHARSET|CHARACTER\s+SET)\s*=\s*(\w+)/i)
          if (cMatch) charset = cMatch[1]
        }
        j++
      }

      tables.push({ tableName, filePath, columns, indexes, engine, charset })
    }
  }

  return tables
}

function extractSQLStatements(filePath: string, source: string, className: string): SQLStatement[] {
  const statements: SQLStatement[] = []
  const lines = source.split('\n')
  let currentClassName = className

  const classMatch = source.match(/(?:public\s+)?(?:class|interface)\s+(\w+)/)
  if (classMatch) currentClassName = classMatch[1]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    const mybatisAnn = line.match(/@(?:Select|Insert|Update|Delete)\s*\(\s*["'](.+?)["']\s*\)/s)
    if (mybatisAnn) {
      const methodLine = lines[i + 1]?.trim() || ''
      const methodMatch = methodLine.match(/(\w+)\s*\(/)
      statements.push({
        filePath, className: currentClassName,
        methodName: methodMatch ? methodMatch[1] : 'unknown',
        sql: mybatisAnn[1], dbType: 'mybatis', parameters: [], returnType: '',
      })
      continue
    }

    const jpaQuery = line.match(/@Query\s*\(\s*(?:value\s*=\s*)?["'](.+?)["']/s)
    if (jpaQuery) {
      const methodLine = lines[i + 1]?.trim() || ''
      const methodMatch = methodLine.match(/(\w+)\s*\(/)
      const params = methodLine.match(/@Param\s*\(\s*["'](\w+)["']\s*\)/g) || []
      statements.push({
        filePath, className: currentClassName,
        methodName: methodMatch ? methodMatch[1] : 'unknown',
        sql: jpaQuery[1], dbType: 'jpa',
        parameters: params.map(p => p.match(/["'](\w+)["']/)?.[1] || ''),
        returnType: methodLine.match(/:\s*(\w+)/)?.[1] || '',
      })
      continue
    }

    const jdbcMatch = line.match(/(?:String\s+\w+\s*=\s*)["'](SELECT\s+.+?FROM\s+\w+)["']/is)
    if (jdbcMatch) {
      const methodLines = lines.slice(Math.max(0, i - 3), i + 1).join(' ')
      const methodMatch = methodLines.match(/(?:public|private)\s+\S+\s+(\w+)\s*\(/)
      statements.push({
        filePath, className: currentClassName,
        methodName: methodMatch ? methodMatch[1] : 'unknown',
        sql: jdbcMatch[1], dbType: 'jdbc', parameters: [], returnType: '',
      })
    }
  }

  return statements
}

export function indexSQLStatements(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): { ddl: DDLTable[]; sqls: SQLStatement[] } {
  const className = filePath.split('/').pop()?.replace('.java', '') || ''
  const ddl = extractDDL(filePath, source)
  const sqls = extractSQLStatements(filePath, source, className)

  for (const table of ddl) {
    const nodeId = `mysql:table:${table.tableName}`
    queries.insertNode({
      id: nodeId, kind: 'sql_table', name: table.tableName, qualifiedName: table.tableName,
      filePath, language: 'sql', startLine: 0, endLine: 0, startColumn: 0, endColumn: 0,
      docstring: '', signature: JSON.stringify({
        columns: table.columns.length, engine: table.engine, charset: table.charset,
      }),
      visibility: 'public', isExported: false, parentId: null, moduleId,
    })

    const existingEntityNodes = queries.searchNodes(table.tableName, 5)
    for (const en of existingEntityNodes) {
      if (en.kind === 'class' || en.kind === 'entity' || en.id.startsWith('jpa:')) {
        queries.insertEdge(nodeId, en.id, 'maps_to', JSON.stringify({ kind: 'sql_table_entity' }), 0, 0)
      }
    }
  }

  for (const sql of sqls) {
    const nodeId = `mysql:sql:${filePath}:${sql.methodName}`
    queries.insertNode({
      id: nodeId, kind: 'sql_statement', name: sql.methodName,
      qualifiedName: `${sql.className}.${sql.methodName}`, filePath, language: 'java',
      startLine: 0, endLine: 0, startColumn: 0, endColumn: 0,
      docstring: '', signature: JSON.stringify({ sql: sql.sql.slice(0, 200), dbType: sql.dbType }),
      visibility: 'public', isExported: false, parentId: null, moduleId,
    })

    const parentNodes = queries.searchNodes(sql.className, 3).filter(n => n.moduleId === moduleId && n.filePath === filePath)
    for (const pn of parentNodes) {
      queries.insertEdge(pn.id, nodeId, 'contains', JSON.stringify({ kind: 'sql_statement', dbType: sql.dbType }), 0, 0)
    }
  }

  return { ddl, sqls }
}
