import type { QueryManager } from '../db/queries.js'
import type { MiniCodeGraphNode } from '../types.js'

const STEREOTYPE_ANNOTATIONS = ['Service', 'Component', 'Repository', 'Controller', 'RestController']
const LAYER_ORDER: Record<string, number> = {
  controller: 1,
  rest_controller: 1,
  service: 2,
  repository: 3,
  component: 4,
}

export function indexSpringBeans(queries: QueryManager, moduleId: string): { beans: number; injections: number } {
  let beans = 0
  let injections = 0

  const allNodes = queries.getAllNodes()

  // 1. Identify Spring beans by stereotype annotations and create layer edges
  const beanLayers = new Map<string, string>()
  for (const annName of STEREOTYPE_ANNOTATIONS) {
    const nodes = queries.getNodesByAnnotation(annName)
    for (const node of nodes) {
      const layer = resolveLayer(annName)
      if (layer) {
        beanLayers.set(node.id, layer)
        queries.insertAnnotation(node.id, `stereotype:${layer}`, annName, node.startLine, moduleId)
        beans++
      }
    }
  }

  // 2. If a bean has multiple stereotype annotations, use the most specific one
  for (const node of allNodes) {
    const anns = queries.getAnnotationsByNode(node.id)
    let bestLayer = ''
    let bestOrder = 999
    for (const a of anns) {
      const layer = resolveLayer(a.annotationName)
      if (layer) {
        const order = LAYER_ORDER[layer] ?? 999
        if (order < bestOrder) {
          bestOrder = order
          bestLayer = layer
        }
      }
    }
    if (bestLayer) {
      beanLayers.set(node.id, bestLayer)
    }
  }

  // 3. Scan @Autowired fields and constructor parameters to create injection edges
  for (const node of allNodes) {
    const anns = queries.getAnnotationsByNode(node.id)
    const autowired = anns.find(a => a.annotationName === 'Autowired' || a.annotationName === 'Inject' || a.annotationName === 'Resource')
    if (!autowired) continue
    if (node.kind !== 'field' && node.kind !== 'parameter' && node.kind !== 'method') continue

    const parent = node.parentId ? queries.getNode(node.parentId) : null
    if (!parent) continue

    const typeName = resolveInjectedType(node, allNodes)
    if (!typeName) continue

    const candidates = findMatchingBeans(typeName, allNodes, beanLayers, queries)
    for (const candidate of candidates) {
      queries.insertEdge(parent.id, candidate.id, 'injects', JSON.stringify({
        injectedField: node.name,
        injectedType: typeName,
        autowired: autowired.annotationName,
        qualifier: findQualifier(anns),
      }), node.startLine, node.startColumn)
      injections++
    }
  }

  return { beans, injections }
}

function resolveLayer(annotation: string): string {
  switch (annotation) {
    case 'Controller': return 'controller'
    case 'RestController': return 'rest_controller'
    case 'Service': return 'service'
    case 'Repository': return 'repository'
    case 'Component': return 'component'
    default: return ''
  }
}

function resolveInjectedType(node: MiniCodeGraphNode, allNodes: MiniCodeGraphNode[]): string | null {
  const anns = node.signature || ''
  if (anns) {
    const javaTypeMatch = anns.match(/(\w+(?:\.\w+)*)\s+\w+\s*(?:,|\)|$)/)
    if (javaTypeMatch) return javaTypeMatch[1]
    const qualName = node.qualifiedName
    const lastDot = qualName.lastIndexOf('.')
    if (lastDot > 0) return qualName.substring(0, lastDot)
  }
  return node.name
}

function findMatchingBeans(typeName: string, allNodes: MiniCodeGraphNode[], beanLayers: Map<string, string>, queries: QueryManager): MiniCodeGraphNode[] {
  const results: MiniCodeGraphNode[] = []

  // Direct qualified name match
  const byQName = queries.getNodesByQualifiedName(typeName)
  for (const n of byQName) {
    if (n.kind === 'class' || n.kind === 'interface') {
      results.push(n)
    }
  }

  // Name-based match (class name ends with type name or matches)
  const simpleName = typeName.includes('.') ? typeName.split('.').pop()! : typeName
  const implName = `${simpleName}Impl`
  for (const node of allNodes) {
    if (results.some(r => r.id === node.id)) continue
    if (node.kind !== 'class' && node.kind !== 'interface') continue
    if (node.name === simpleName || node.name === implName) {
      results.push(node)
    }
  }

  return results.slice(0, 5)
}

function findQualifier(anns: { annotationName: string; value: string }[]): string {
  const qual = anns.find(a => a.annotationName === 'Qualifier')
  return qual ? qual.value.replace(/["']/g, '') : ''
}
