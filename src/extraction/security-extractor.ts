import type { QueryManager } from '../db/queries.js'

const SECURITY_ANNOTATIONS = new Set([
  'PreAuthorize', 'PostAuthorize', 'PreFilter', 'PostFilter',
  'Secured', 'RolesAllowed', 'PermitAll', 'DenyAll',
  'EnableResourceServer', 'EnableAuthorizationServer',
  'EnableGlobalMethodSecurity', 'EnableWebSecurity',
  'EnableOAuth2Sso', 'EnableOAuth2Client',
])

export function extractSecurityAnnotations(source: string, filePath: string, moduleId: string): {
  nodeId: string; annotationName: string; value: string; line: number
}[] {
  const results: { nodeId: string; annotationName: string; value: string; line: number }[] = []

  for (const annName of SECURITY_ANNOTATIONS) {
    const pattern = new RegExp(`@${annName}\\s*\\(([^)]*)\\)`, 'g')
    let m: RegExpExecArray | null
    while ((m = pattern.exec(source)) !== null) {
      const value = m[1]?.trim() ?? ''
      const line = source.substring(0, m.index).split('\n').length
      const nodeId = `${filePath}:@${annName}:${line}`

      for (let j = line - 1; j < Math.min(line + 2, source.split('\n').length); j++) {
        const dl = source.split('\n')[j]?.trim() ?? ''
        const idMatch = dl.match(/(?:public\s+)?(?:\w+\s+)?(\w+)\s*\(/)
        if (idMatch && !idMatch[1].startsWith('@')) {
          results.push({ nodeId: `${filePath}:${idMatch[1]}:${j + 1}`, annotationName: annName, value, line })
          break
        }
      }
    }
  }

  return results
}

export function indexSecurity(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): void {
  const annotations = extractSecurityAnnotations(source, filePath, moduleId)
  for (const a of annotations) {
    const candidates = queries.searchNodes(a.nodeId, 5)
    for (const c of candidates) {
      queries.insertEdge(c.id, `${filePath}:sec:${a.annotationName}`,
        'secured_by', JSON.stringify({ annotation: a.annotationName, value: a.value }), a.line, 0)
      queries.insertAnnotation(c.id, a.annotationName, a.value, a.line, moduleId)
    }
  }
}
