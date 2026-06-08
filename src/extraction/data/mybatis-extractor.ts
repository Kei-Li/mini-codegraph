import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { QueryManager } from '../../db/queries.js'

export interface MyBatisMapping {
  namespace: string
  id: string
  statementType: string
  parameterType: string
  resultType: string
  sql: string
  filePath: string
  line: number
}

export interface MyBatisResult {
  mappings: MyBatisMapping[]
  errors: string[]
}

export function parseMyBatisXmlFile(filePath: string, projectRoot: string): MyBatisResult {
  const result: MyBatisResult = { mappings: [], errors: [] }

  try {
    const content = readFileSync(filePath, 'utf-8')
    const relPath = relative(projectRoot, filePath).replace(/\\/g, '/')

    const namespaceMatch = content.match(/<mapper\s+namespace\s*=\s*["']([^"']+)["']/)
    if (!namespaceMatch) return result

    const namespace = namespaceMatch[1]

    const statementTypes = ['select', 'insert', 'update', 'delete']
    for (const stmtType of statementTypes) {
      const tagRegex = new RegExp(`<${stmtType}\\s+([^>]*)>`, 'g')
      const idRegex = /id\s*=\s*["']([^"']+)["']/
      const paramRegex = /parameterType\s*=\s*["']([^"']+)["']/
      const resultRegex = /resultType\s*=\s*["']([^"']+)["']/

      let m: RegExpExecArray | null
      while ((m = tagRegex.exec(content)) !== null) {
        const attrs = m[1]
        const idMatch = attrs.match(idRegex)
        if (!idMatch) continue
        const id = idMatch[1]
        const parameterType = attrs.match(paramRegex)?.[1] ?? ''
        const resultType = attrs.match(resultRegex)?.[1] ?? ''
        const lineNum = content.substring(0, m.index).split('\n').length

        const startIdx = m.index
        const closeTag = `</${stmtType}>`
        const endIdx = content.indexOf(closeTag, startIdx)
        const sqlBlock = endIdx > startIdx
          ? content.substring(startIdx, endIdx + closeTag.length)
          : ''

        result.mappings.push({
          namespace,
          id,
          statementType: stmtType,
          parameterType,
          resultType,
          sql: sqlBlock,
          filePath: relPath,
          line: lineNum,
        })
      }
    }
  } catch (e) {
    result.errors.push(`Error parsing MyBatis XML ${filePath}: ${e}`)
  }

  return result
}

export function indexMyBatisMappers(
  queries: QueryManager,
  projectRoot: string,
  mybatisDir: string,
  _moduleId: string
): MyBatisMapping[] {
  const allMappings: MyBatisMapping[] = []

  const scanDir = (dir: string) => {
    if (!existsSync(dir)) return
    const entries = readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) scanDir(fullPath)
      } else if (entry.name.endsWith('.xml')) {
        const content = readFileSync(fullPath, 'utf-8')
        if (content.includes('<!DOCTYPE mapper') || content.includes('<mapper ')) {
          const parsed = parseMyBatisXmlFile(fullPath, projectRoot)
          allMappings.push(...parsed.mappings)
        }
      }
    }
  }

  scanDir(mybatisDir)

  for (const mapping of allMappings) {
    const edgeSourceId = `mybatis:${mapping.filePath}:${mapping.line}`

    const candidateNodes = queries.searchNodes(mapping.namespace, 5)
    for (const candidate of candidateNodes) {
      if (candidate.kind === 'interface' || candidate.kind === 'class') {
        const children = queries.getChildren(candidate.id)
        const methodNode = children.find(c => c.name === mapping.id)
        if (methodNode) {
          queries.insertEdge(
            methodNode.id,
            edgeSourceId,
            'mybatis_mapping',
            JSON.stringify({
              namespace: mapping.namespace,
              sqlId: `${mapping.namespace}.${mapping.id}`,
              statementType: mapping.statementType,
              xmlPath: mapping.filePath,
            }),
            mapping.line,
            0
          )
        }
      }
    }
  }

  return allMappings
}

export function findMyBatisMapperDir(projectRoot: string): string | null {
  const candidates = [
    join(projectRoot, 'src', 'main', 'resources', 'mapper'),
    join(projectRoot, 'src', 'main', 'resources', 'mappers'),
    join(projectRoot, 'src', 'main', 'resources', 'mybatis'),
    join(projectRoot, 'src', 'main', 'resources', 'sqlmap'),
    join(projectRoot, 'mapper'),
    join(projectRoot, 'mappers'),
  ]

  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }

  if (existsSync(join(projectRoot, 'src', 'main', 'resources'))) {
    return join(projectRoot, 'src', 'main', 'resources')
  }

  return null
}
