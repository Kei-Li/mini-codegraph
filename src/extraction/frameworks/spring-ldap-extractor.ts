import type { QueryManager } from '../../db/queries.js'

export interface LdapEntry {
  annotation: string
  className: string
  baseDn?: string
  filePath: string
  line: number
  moduleId: string
}

export interface LdapOperation {
  type: 'search' | 'lookup' | 'create' | 'update' | 'delete'
  className: string
  methodName: string
  filter?: string
  filePath: string
  line: number
  moduleId: string
}

export function indexSpringLdap(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): { entries: LdapEntry[]; operations: LdapOperation[] } {
  const entries: LdapEntry[] = []
  const operations: LdapOperation[] = []
  const lines = source.split('\n')
  const className = filePath.split('/').pop()?.replace('.java', '') || ''

  for (let i = 0; i < lines.length; i++) {
    const trim = lines[i].trim()

    if (trim.startsWith('@Entry(') || trim.startsWith('@Entry ') || trim === '@Entry') {
      const fullAnn = lines.slice(i, i + 3).join(' ')
      const baseDn = fullAnn.match(/base\s*=\s*["']([^"']+)["']/)?.[1]
      entries.push({ annotation: '@Entry', className, baseDn, filePath, line: i + 1, moduleId })
      const nodeId = `${filePath}:Entry`
      queries.insertAnnotation(nodeId, '@Entry', JSON.stringify({ baseDn }), i + 1, moduleId)
      const parentNodes = queries.searchNodes(className, 3)
        .filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const pn of parentNodes) {
        queries.insertEdge(pn.id, nodeId, 'ldap_entry', JSON.stringify({ baseDn }), i + 1, 0)
      }
      continue
    }

    if (trim.startsWith('@LdapRepository') || trim.startsWith('@LdapRepository(')) {
      const nodeId = `${filePath}:LdapRepository`
      queries.insertAnnotation(nodeId, '@LdapRepository', '{}', i + 1, moduleId)
      const parentNodes = queries.searchNodes(className, 3)
        .filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const pn of parentNodes) {
        queries.insertEdge(pn.id, nodeId, 'ldap_repository', '{}', i + 1, 0)
      }
      continue
    }
  }

  const ldapOps = [
    { pattern: /ldapTemplate\.\s*(search|find|lookup)\s*\([^)]*["']([^"']+)["']/g, type: 'search' as const },
    { pattern: /ldapTemplate\.\s*(create|bind)\s*\(/g, type: 'create' as const },
    { pattern: /ldapTemplate\.\s*(update|rebind)\s*\(/g, type: 'update' as const },
    { pattern: /ldapTemplate\.\s*(delete|unbind)\s*\(/g, type: 'delete' as const },
  ]

  for (const op of ldapOps) {
    let m: RegExpExecArray | null
    while ((m = op.pattern.exec(source)) !== null) {
      const methodName = m[2] ?? m[1]
      const lineIdx = lines.findIndex(l => l.includes('ldapTemplate'))
      operations.push({
        type: op.type, className, methodName,
        filter: m[2], filePath, line: lineIdx + 1, moduleId,
      })
      const nodeId = `${filePath}:ldapTemplate.${methodName}`
      queries.insertAnnotation(nodeId, 'LdapOperation',
        JSON.stringify({ type: op.type, filter: m[2] }), lineIdx + 1, moduleId)
    }
  }

  return { entries, operations }
}
