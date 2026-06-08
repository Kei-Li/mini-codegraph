import type { QueryManager } from '../../db/queries.js'

export interface LoadBalancerClient {
  className: string
  filePath: string
  fieldName: string
  serviceName?: string
  hasLoadBalanced: boolean
  line: number
  moduleId: string
}

export function indexLoadBalancerClients(
  queries: QueryManager,
  moduleId: string
): LoadBalancerClient[] {
  const results: LoadBalancerClient[] = []
  const allNodes = queries.getAllNodes()
  const nodeAnnCache = queries.getAllAnnotations()

  for (const node of allNodes) {
    if (node.moduleId !== moduleId) continue
    if (node.kind !== 'field' && node.kind !== 'parameter') continue

    const anns = nodeAnnCache.get(node.id) ?? []
    if (!anns.some(a => a.annotationName === 'LoadBalanced')) continue

    let serviceName: string | undefined
    const typeName = node.qualifiedName.split('.').pop() || node.name
    if (typeName.includes('RestTemplate') || typeName.includes('WebClient') || typeName.includes('DiscoveryClient')) {
      serviceName = node.name
    }

    results.push({
      className: node.parentId ? (queries.getNode(node.parentId)?.name || '') : '',
      filePath: node.filePath,
      fieldName: node.name,
      serviceName,
      hasLoadBalanced: true,
      line: node.startLine,
      moduleId,
    })

    queries.insertAnnotation(node.id, 'LoadBalancedClient',
      JSON.stringify({ serviceName, fieldName: node.name }), node.startLine, moduleId)
  }

  return results
}

export function resolveLbUris(queries: QueryManager, moduleId: string): { uri: string; targetService: string }[] {
  const results: { uri: string; targetService: string }[] = []
  const allEdges = queries.getAllEdges()
  const gatewayEdges = allEdges.filter(e => e.kind === 'gateway_route')

  for (const ge of gatewayEdges) {
    try {
      const meta = JSON.parse(ge.metadata || '{}')
      const uri: string = meta.uri || ''
      const lbMatch = uri.match(/lb:\/\/(\w[\w-]*)/)
      if (lbMatch) {
        results.push({ uri, targetService: lbMatch[1] })
      }
    } catch { /* silent */ }
  }

  const feignClients = queries.getNodesByAnnotation('FeignClient')
  const nodeAnnCache = queries.getAllAnnotations()
  for (const fc of feignClients) {
    if (fc.moduleId !== moduleId) continue
    const anns = nodeAnnCache.get(fc.id) ?? []
    const nameAnn = anns.find(a => a.annotationName === 'FeignClient')
    if (nameAnn && !nameAnn.value.includes('url=')) {
      const nameMatch = nameAnn.value.match(/name\s*=\s*["'](\w[\w-]*)["']/)
      if (nameMatch) {
        results.push({ uri: `lb://${nameMatch[1]}`, targetService: nameMatch[1] })
      }
    }
  }

  return results
}
