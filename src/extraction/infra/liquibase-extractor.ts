import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface LiquibaseChangeLog {
  id: string
  filePath: string
  databaseChangeLogId: string
  changes: LiquibaseChange[]
  includePaths: string[]
}

export interface LiquibaseChange {
  id: string
  author: string
  fileName: string
  changeSetId: string
  changeTypes: { type: string; detail: Record<string, string> }[]
  labels: string[]
  contextFilter: string
  comment: string
}

function extractXmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`)
  const m = re.exec(xml)
  return m ? m[1].trim() : ''
}

function extractXmlAttribute(xml: string, attr: string): string {
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`)
  const m = re.exec(xml)
  return m ? m[1].trim() : ''
}

function parseChangeTypes(changeXml: string): { type: string; detail: Record<string, string> }[] {
  const types: { type: string; detail: Record<string, string> }[] = []
  const changeTagRe = /<(\w+)([^>]*)>/g
  const knownTypes = ['createTable', 'addColumn', 'dropTable', 'dropColumn', 'addPrimaryKey',
    'addForeignKeyConstraint', 'createIndex', 'dropIndex', 'insert', 'update', 'delete',
    'sql', 'sqlFile', 'createView', 'dropView', 'renameTable', 'renameColumn',
    'modifyDataType', 'addUniqueConstraint', 'createSequence', 'dropSequence',
    'createProcedure', 'createFunction', 'createTrigger', 'mergeColumns',
    'loadData', 'loadUpdateData', 'tagDatabase', 'rollback', 'customChange',
    'createTable', 'modifyDataType']

  let m: RegExpExecArray | null
  while ((m = changeTagRe.exec(changeXml)) !== null) {
    if (knownTypes.includes(m[1])) {
      const attrs = m[2].trim()
      const detail: Record<string, string> = {}
      const attrRe = /(\w+)\s*=\s*["']([^"']*)["']/g
      let am: RegExpExecArray | null
      while ((am = attrRe.exec(attrs)) !== null) {
        detail[am[1]] = am[2]
      }
      types.push({ type: m[1], detail })
    }
  }
  return types
}

export function parseLiquibaseChangelog(filePath: string): LiquibaseChangeLog | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const dbChangeLogId = extractXmlAttribute(content, 'changeSet')
    const includes: string[] = []
    const includeRe = /<include\s+file=["']([^"']+)["']/g
    let im: RegExpExecArray | null
    while ((im = includeRe.exec(content)) !== null) {
      includes.push(im[1])
    }

    const changes: LiquibaseChange[] = []
    const changeSetRe = /<changeSet\s+([\s\S]*?)<\/changeSet>/g
    let cm: RegExpExecArray | null
    while ((cm = changeSetRe.exec(content)) !== null) {
      const changeSetXml = cm[0]
      const csId = extractXmlAttribute(changeSetXml, 'id')
      const author = extractXmlAttribute(changeSetXml, 'author')
      const labels = extractXmlAttribute(changeSetXml, 'labels').split(',').map(l => l.trim()).filter(Boolean)
      const contextFilter = extractXmlAttribute(changeSetXml, 'contextFilter') || extractXmlAttribute(changeSetXml, 'context')

      const changeTypes = parseChangeTypes(changeSetXml)
      const comment = extractXmlTag(changeSetXml, 'comment')

      if (csId) {
        changes.push({
          id: `liquibase:${csId}`,
          author,
          fileName: filePath,
          changeSetId: csId,
          changeTypes,
          labels,
          contextFilter,
          comment,
        })
      }
    }

    return {
      id: `liquibase:${filePath}`,
      filePath,
      databaseChangeLogId: extractXmlTag(content, 'databaseChangeLog') || dbChangeLogId,
      changes,
      includePaths: includes,
    }
  } catch {
    return null
  }
}

export function findLiquibaseFiles(projectRoot: string): string[] {
  const files: string[] = []
  const searchDirs = [
    join(projectRoot, 'src', 'main', 'resources', 'db', 'changelog'),
    join(projectRoot, 'db', 'changelog'),
    join(projectRoot, 'src', 'main', 'resources'),
  ]
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue
    try {
      const entries = readdirSync(dir, { recursive: true }) as string[]
      for (const e of entries) {
        if (e.endsWith('.xml') || e.endsWith('.yaml') || e.endsWith('.yml')) {
          try {
            const full = join(dir, e)
            const content = readFileSync(full, 'utf-8')
            if (content.includes('databaseChangeLog') || content.includes('changeSet')) {
              files.push(full)
            }
          } catch { /* silent */ }
        }
      }
    } catch { /* silent */ }
  }
  return files
}

export function detectLiquibase(projectRoot: string): boolean {
  const pomPath = join(projectRoot, 'pom.xml')
  if (existsSync(pomPath)) {
    try {
      const content = readFileSync(pomPath, 'utf-8')
      if (content.includes('liquibase-core') || content.includes('liquibase-maven-plugin')) {
        return true
      }
    } catch { /* silent */ }
  }
  return findLiquibaseFiles(projectRoot).length > 0
}
