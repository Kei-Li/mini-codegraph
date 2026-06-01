import type { QueryManager } from '../db/queries.js'

function escapeId(label: string): string {
  return label.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1')
}

export function generateArchitectureDiagram(queries: QueryManager): string {
  const lines: string[] = ['graph TB']
  const allNodes = queries.getAllNodes()

  const moduleGroups = new Map<string, { serviceName: string; className: string }[]>()
  for (const n of allNodes) {
    if (n.moduleId && n.kind === 'class') {
      if (!moduleGroups.has(n.moduleId)) moduleGroups.set(n.moduleId, [])
      const sn = n.name.split('.').pop() ?? n.name
      moduleGroups.get(n.moduleId)!.push({ serviceName: n.moduleId, className: sn })
    }
  }

  for (const [moduleId, members] of moduleGroups) {
    const subgraphId = `sub_${escapeId(moduleId)}`
    lines.push(`  subgraph ${subgraphId}["${moduleId}"]`)
    for (const m of members) {
      const nid = escapeId(`${moduleId}.${m.className}`)
      lines.push(`    ${nid}["${m.className}"]`)
    }
    lines.push('  end')
  }

  const edgeTypes = ['feign_client', 'mybatis_mapper', 'rpc_call', 'http_call', 'depend_on']
  for (const et of edgeTypes) {
    const edges = queries.getEdgesByType(et)
    for (const e of edges) {
      const src = escapeId(e.sourceId.replace(/[^a-zA-Z0-9_]/g, '_'))
      const dst = escapeId(e.targetId.replace(/[^a-zA-Z0-9_]/g, '_'))
      if (src !== dst) {
        lines.push(`  ${src} --${et}--> ${dst}`)
      }
    }
  }

  for (const n of allNodes) {
    const annotations = queries.getAnnotationsByNode(n.id)
    for (const a of annotations) {
      if (['RestController', 'Controller', 'Service', 'Repository', 'Component', 'Configuration', 'FeignClient'].includes(a.annotationName)) {
        const nid = escapeId(n.id.replace(/[^a-zA-Z0-9_]/g, '_'))
        lines.push(`  ${nid}:::${a.annotationName.toLowerCase()}`)
      }
    }
  }

  lines.push('')
  lines.push('  classDef restcontroller fill:#e1f5fe,stroke:#0288d1')
  lines.push('  classDef controller fill:#e1f5fe,stroke:#0288d1')
  lines.push('  classDef service fill:#f3e5f5,stroke:#7b1fa2')
  lines.push('  classDef repository fill:#e8f5e9,stroke:#388e3c')
  lines.push('  classDef feignclient fill:#fff3e0,stroke:#f57c00')
  lines.push('  classDef component fill:#f9fbe7,stroke:#afb42b')
  lines.push('  classDef configuration fill:#eceff1,stroke:#546e7a')

  return lines.join('\n')
}

export function generateServiceDependencyDiagram(queries: QueryManager): string {
  const lines: string[] = ['graph LR']
  const allNodes = queries.getAllNodes()
  const services = new Set<string>()
  for (const n of allNodes) {
    if (n.moduleId) services.add(n.moduleId)
  }

  for (const s of services) {
    const sid = escapeId(s)
    lines.push(`  ${sid}["${s}"]`)
  }

  const edgeTypes = ['feign_client', 'rpc_call', 'http_call']
  for (const et of edgeTypes) {
    const edges = queries.getEdgesByType(et)
    for (const e of edges) {
      const srcNode = allNodes.find(n => n.id === e.sourceId)
      const tgtNode = allNodes.find(n => n.id === e.targetId)
      if (srcNode && tgtNode && srcNode.moduleId && tgtNode.moduleId && srcNode.moduleId !== tgtNode.moduleId) {
        const src = escapeId(srcNode.moduleId)
        const dst = escapeId(tgtNode.moduleId)
        lines.push(`  ${src} --${et}--> ${dst}`)
      }
    }
  }

  return lines.join('\n')
}

export function generateGatewayDiagram(
  queries: QueryManager,
  routes: { id: string; uri: string; predicates: string[]; filters: string[] }[]
): string {
  const lines: string[] = ['graph TB']
  lines.push('  gateway["API Gateway"]')
  lines.push('  gateway:::gateway')

  const targetServices = new Set(routes.map(r => r.uri))
  for (const ts of targetServices) {
    const sid = escapeId(ts)
    lines.push(`  ${sid}["${ts}"]`)
  }
  for (const r of routes) {
    const sid = escapeId(r.uri)
    const routeId = `route_${escapeId(r.id)}`
    lines.push(`  gateway -- "${r.predicates.join(', ')}" --> ${routeId}["${r.id}"]`)
    lines.push(`  ${routeId} --> ${sid}`)
  }

  lines.push('  classDef gateway fill:#ffebee,stroke:#c62828')
  return lines.join('\n')
}

export function generateSequenceDiagram(queries: QueryManager, serviceName: string): string {
  const lines: string[] = ['sequenceDiagram']
  const allNodes = queries.getAllNodes()
  const services = new Set<string>()
  for (const n of allNodes) {
    if (n.moduleId && n.moduleId.includes(serviceName)) services.add(n.moduleId)
  }

  const feignEdges = queries.getEdgesByType('feign_client')
  const seen = new Set<string>()

  for (const e of feignEdges) {
    const src = allNodes.find(n => n.id === e.sourceId)
    const tgt = allNodes.find(n => n.id === e.targetId)
    if (!src || !tgt) continue

    const srcModule = src.moduleId ?? 'unknown'
    const tgtModule = tgt.moduleId ?? 'unknown'
    const actorSrc = escapeId(srcModule)
    const actorTgt = escapeId(tgtModule)

    if (!seen.has(actorSrc)) {
      lines.push(`  participant ${actorSrc} as "${srcModule}"`)
      seen.add(actorSrc)
    }
    if (!seen.has(actorTgt)) {
      lines.push(`  participant ${actorTgt} as "${tgtModule}"`)
      seen.add(actorTgt)
    }

    const edgeMeta = e.metadata ? JSON.parse(e.metadata) : {}
    lines.push(`  ${actorSrc}->>+${actorTgt}: FeignClient ${edgeMeta.method ?? 'GET'} ${edgeMeta.path ?? ''}`)
    lines.push(`  ${actorTgt}-->>-${actorSrc}: Response`)
  }

  return lines.join('\n')
}

export function getAllMermaidDiagrams(queries: QueryManager): {
  architecture: string
  dependencies: string
  sequence: string
} {
  return {
    architecture: generateArchitectureDiagram(queries),
    dependencies: generateServiceDependencyDiagram(queries),
    sequence: generateSequenceDiagram(queries, ''),
  }
}
