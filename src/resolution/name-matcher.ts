import type { QueryManager } from '../db/queries.js'
import type { CodeGraphNode } from '../types.js'

export interface MatchResult {
  node: CodeGraphNode
  confidence: number
  strategy: string
}

export function matchReference(
  queries: QueryManager,
  refName: string,
  sourceFile: string,
  sourceModuleId: string,
  kind?: string
): MatchResult[] {
  const results: MatchResult[] = []

  const exactMatches = queries.searchNodes(refName, 50)
  for (const node of exactMatches) {
    if (node.filePath === sourceFile) continue
    if (kind && node.kind !== kind) continue

    let confidence = 0.3
    let strategy = 'name_match'

    if (node.name === refName && node.qualifiedName === refName) {
      confidence = 0.9
      strategy = 'exact_qualified_name'
    } else if (node.name === refName) {
      confidence = 0.7
      strategy = 'exact_name'
    } else if (node.qualifiedName.endsWith(`.${refName}`)) {
      confidence = 0.6
      strategy = 'qualified_name_suffix'
    }

    if (node.qualifiedName.includes(refName)) {
      confidence = Math.max(confidence, 0.5)
      strategy = 'qualified_name_contains'
    }

    results.push({ node, confidence, strategy })
  }

  if (refName.includes('.')) {
    const parts = refName.split('.')
    const simpleName = parts[parts.length - 1]
    const scopeName = parts[parts.length - 2]

    const simpleMatches = queries.searchNodes(simpleName, 30)
    for (const node of simpleMatches) {
      if (node.filePath === sourceFile) continue
      if (results.some(r => r.node.id === node.id)) continue
      if (kind && node.kind !== kind) continue

      const parent = node.parentId ? queries.getNode(node.parentId) : null
      if (parent && (parent.name === scopeName || parent.qualifiedName.endsWith(`.${scopeName}`))) {
        results.push({ node, confidence: 0.8, strategy: 'scoped_name_match' })
      }
    }
  }

  if (kind === 'class' || kind === 'interface') {
    const classCandidates = queries.searchNodes(refName, 30).filter(n =>
      ['class', 'interface', 'enum'].includes(n.kind)
    )
    for (const node of classCandidates) {
      if (node.filePath === sourceFile) continue
      if (results.some(r => r.node.id === node.id)) continue
      const baseName = node.qualifiedName.split('.').pop()
      if (baseName === refName) {
        results.push({ node, confidence: 0.75, strategy: 'class_name_match' })
      }
    }
  }

  results.sort((a, b) => b.confidence - a.confidence)
  return results.slice(0, 10)
}

export function findImplementations(
  queries: QueryManager,
  interfaceNode: CodeGraphNode
): CodeGraphNode[] {
  if (!['interface', 'type_alias'].includes(interfaceNode.kind)) return []

  const results: CodeGraphNode[] = []
  const nodeName = interfaceNode.name
  const nodeQName = interfaceNode.qualifiedName
  const simpleName = nodeQName.split('.').pop() ?? nodeName

  const allNodes = queries.getAllNodes()

  for (const n of allNodes) {
    if (n.id === interfaceNode.id) continue
    if (n.kind !== 'class' && n.kind !== 'enum') continue

    if (n.qualifiedName === nodeName || n.qualifiedName.endsWith(`.${nodeName}`) ||
        n.qualifiedName.endsWith(`.${nodeName}Impl`) || n.qualifiedName.endsWith(`Impl`)) {
      if (!results.find(r => r.id === n.id)) results.push(n)
      continue
    }

    if (nodeName.startsWith('I') && /^I[A-Z]/.test(nodeName)) {
      const implName = nodeName.slice(1)
      if (n.name === implName || n.name === `${implName}Impl`) {
        if (!results.find(r => r.id === n.id)) results.push(n)
        continue
      }
    }

    if (n.name.endsWith('Impl')) {
      const baseName = n.name.slice(0, -4)
      if (nodeName === baseName || simpleName === baseName) {
        if (!results.find(r => r.id === n.id)) results.push(n)
        continue
      }
    }
  }

  return results
}

export function resolveByNameAcrossModules(
  queries: QueryManager,
  name: string,
  excludeModuleId?: string
): CodeGraphNode[] {
  const results = queries.searchNodes(name, 100)
  if (excludeModuleId) {
    return results.filter(n => n.moduleId && n.moduleId !== excludeModuleId)
  }
  return results
}
