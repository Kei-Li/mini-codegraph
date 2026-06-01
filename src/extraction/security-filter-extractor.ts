import type { QueryManager } from '../db/queries.js'

export interface SecurityFilterRule {
  className: string
  filePath: string
  methodName: string
  urlPatterns: string[]
  permitAll: boolean
  authenticated: boolean
  hasAuthority: string[]
  hasRole: string[]
  hasAnyRole: string[]
  hasAnyAuthority: string[]
  accessExpression: string
  ignored: boolean
  line: number
  moduleId: string
}

const AUTH_METHODS = [
  'permitAll', 'authenticated', 'denyAll', 'anonymous',
  'rememberMe', 'fullyAuthenticated',
  'hasAuthority', 'hasRole', 'hasAnyAuthority', 'hasAnyRole',
  'hasIpAddress', 'access',
]

export function indexSecurityFilterChains(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): SecurityFilterRule[] {
  const rules: SecurityFilterRule[] = []
  if (!source.includes('SecurityFilterChain') && !source.includes('HttpSecurity') && !source.includes('WebSecurity')) return rules

  const lines = source.split('\n')
  let currentMethod = ''
  let className = filePath.split('/').pop()?.replace('.java', '') || ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const beanMatch = line.match(/(?:public\s+)?SecurityFilterChain\s+(\w+)\s*\(/)
    if (beanMatch) {
      currentMethod = beanMatch[1]
      continue
    }

    if (!currentMethod) continue

    const antMatcherMatch = line.match(/\.(?:antMatcher|requestMatcher|mvcMatcher|regexMatcher)\s*\(\s*["']([^"']+)["']/)
    if (antMatcherMatch) {
      continue
    }

    for (const am of AUTH_METHODS) {
      const authMatch = line.match(new RegExp(`\\.${am}\\s*\\(`))
      if (!authMatch) continue

      const argsMatch = line.match(new RegExp(`\\.${am}\\s*\\(\\s*["']([^"']+)["']`))
      const args = argsMatch?.[1] ? argsMatch[1].split(',').map(a => a.trim().replace(/["']/g, '')) : []

      const urlPatterns: string[] = []
      for (let j = Math.max(0, i - 5); j < i; j++) {
        const urlMatch = lines[j].match(/\.(?:antMatcher|requestMatcher|mvcMatcher)\s*\(\s*["']([^"']+)["']/)
        if (urlMatch) urlPatterns.push(urlMatch[1])
        const reMatch = lines[j].match(/\.requestMatchers\s*\(\s*["']([^"']+)["']/)
        if (reMatch) urlPatterns.push(reMatch[1])
      }
      if (urlPatterns.length === 0) urlPatterns.push('/**')

      const rule: SecurityFilterRule = {
        className, filePath, methodName: currentMethod,
        urlPatterns,
        permitAll: am === 'permitAll',
        authenticated: am === 'authenticated',
        hasAuthority: am === 'hasAuthority' ? args : [],
        hasRole: am === 'hasRole' ? args : [],
        hasAnyRole: am === 'hasAnyRole' ? args : [],
        hasAnyAuthority: am === 'hasAnyAuthority' ? args : [],
        accessExpression: am === 'access' ? (argsMatch?.[1] || '') : '',
        ignored: line.includes('ignoring') || line.includes('WebSecurityCustomizer'),
        line: i + 1,
        moduleId,
      }
      rules.push(rule)

      const nodeId = `${filePath}:security_filter:${i}`
      const parentNodes = queries.searchNodes(className, 3)
        .filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const pn of parentNodes) {
        const annValue = JSON.stringify({
          urlPatterns, method: am, roles: args, expression: argsMatch?.[1],
        })
        queries.insertAnnotation(nodeId, `SecurityFilter_${am}`, annValue, i + 1, moduleId)
        queries.insertEdge(pn.id, nodeId, 'security_filter_rule', annValue, i + 1, 0)
      }
      break
    }

    if (line.trim().includes('}') && currentMethod) {
      currentMethod = ''
    }
  }

  return rules
}

export function indexWebSecurityCustomizer(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): string[] {
  const ignored: string[] = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes('ignoring') && line.includes('antMatchers')) {
      const match = line.match(/antMatchers\s*\(\s*["']([^"']+)["']/)
      if (match) ignored.push(match[1])
    }
    if (line.includes('ignoring') && line.includes('requestMatchers')) {
      const match = line.match(/requestMatchers\s*\(\s*["']([^"']+)["']/)
      if (match) ignored.push(match[1])
    }
  }
  return ignored
}
