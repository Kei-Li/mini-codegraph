import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../../db/queries.js'

export interface K8sServiceDetail {
  name: string
  namespace: string
  type: string
  clusterIP: string
  ports: { port: number; targetPort: number | string; protocol: string; name: string }[]
  selector: Record<string, string>
}

export interface K8sIngressDetail {
  name: string
  namespace: string
  host: string
  paths: { path: string; pathType: string; serviceName: string; servicePort: number | string }[]
  tlsHosts: string[]
}

export interface K8sNetworkPolicy {
  name: string
  namespace: string
  podSelector: Record<string, string>
  policyTypes: string[]
  ingressRules: { from: { podSelector?: Record<string, string>; namespaceSelector?: Record<string, string>; ipBlock?: string }[]; ports: { port: number | string; protocol: string }[] }[]
  egressRules: { to: { podSelector?: Record<string, string>; namespaceSelector?: Record<string, string>; ipBlock?: string }[]; ports: { port: number | string; protocol: string }[] }[]
}

export function parseK8sNetworkYaml(content: string): {
  services: K8sServiceDetail[]; ingresses: K8sIngressDetail[]; networkPolicies: K8sNetworkPolicy[]
} {
  const services: K8sServiceDetail[] = []
  const ingresses: K8sIngressDetail[] = []
  const networkPolicies: K8sNetworkPolicy[] = []
  const docs = content.split(/\n---\n/)

  for (const doc of docs) {
    const kindMatch = doc.match(/kind:\s*(\w+)/)
    if (!kindMatch) continue
    const kind = kindMatch[1]
    const nameMatch = doc.match(/name:\s*(\S+)/)
    const nsMatch = doc.match(/namespace:\s*(\S+)/)
    const name = nameMatch?.[1] || 'unknown'
    const namespace = nsMatch?.[1] || 'default'

    if (kind === 'Service') {
      const typeMatch = doc.match(/type:\s*(\w+)/)
      const clusterIPMatch = doc.match(/clusterIP:\s*(\S+)/)
      const ports: K8sServiceDetail['ports'] = []
      const portSection = doc.match(/ports:\n((?:\s+-.*\n?)*)/)?.[1]
      if (portSection) {
        const portBlocks = portSection.split(/\n\s+-/).slice(1)
        for (const pb of portBlocks.length > 0 ? portBlocks : [portSection]) {
          const pMatch = pb.match(/port:\s*(\d+)/)
          const tpMatch = pb.match(/targetPort:\s*(\d+|\w+)/)
          const protoMatch = pb.match(/protocol:\s*(\w+)/)
          const nMatch = pb.match(/name:\s*(\S+)/)
          if (pMatch) ports.push({
            port: parseInt(pMatch[1]), targetPort: tpMatch?.[1] || pMatch[1],
            protocol: protoMatch?.[1] || 'TCP', name: nMatch?.[1] || '',
          })
        }
      }
      const selector: Record<string, string> = {}
      const selSection = doc.match(/selector:\n((?:\s+.*\n?)*)/)?.[1]
      if (selSection) {
        for (const m of selSection.matchAll(/(\w+):\s*(\S+)/g)) selector[m[1]] = m[2]
      }
      services.push({ name, namespace, type: typeMatch?.[1] || 'ClusterIP', clusterIP: clusterIPMatch?.[1] || '', ports, selector })
    }

    if (kind === 'Ingress') {
      const hosts: { host: string; tls: boolean }[] = []
      const hostMatches = doc.matchAll(/host:\s*(\S+)/g)
      for (const hm of hostMatches) hosts.push({ host: hm[1], tls: false })
      const tlsHosts: string[] = []
      const tlsSection = doc.match(/tls:\n((?:\s+.*\n?)*)/)?.[1]
      if (tlsSection) {
        for (const m of tlsSection.matchAll(/hosts?:\s*(\S+)/g)) tlsHosts.push(m[1])
      }

      const ruleSections = doc.split(/- host:/).slice(1)
      if (ruleSections.length === 0 && hosts.length > 0) {
        const paths: K8sIngressDetail['paths'] = []
        const pathSection = doc.match(/paths?:\n((?:\s+.*\n?)*)/)?.[1]
        if (pathSection) {
          for (const m of pathSection.matchAll(/path:\s*(\S+)\s*\n.*?serviceName:\s*(\S+).*?servicePort:\s*(\d+|\w+)/gs)) {
            paths.push({ path: m[1], pathType: 'Prefix', serviceName: m[2], servicePort: m[3] })
          }
        }
        for (const h of hosts) {
          ingresses.push({ name, namespace, host: h.host, paths, tlsHosts: tlsHosts.filter(th => th === h.host) })
        }
      }
      for (const rs of ruleSections) {
        const hostMatch = rs.match(/^(\S+)/)
        const host = hostMatch?.[1] || hosts[0]?.host || ''
        const paths: K8sIngressDetail['paths'] = []
        const pathSection = rs.match(/paths?:\n((?:\s+.*\n?)*)/)?.[1]
        if (pathSection) {
          const blockMatches = pathSection.matchAll(/- path:\s*(\S+).*?pathType:\s*(\S+).*?serviceName:\s*(\S+).*?servicePort:\s*(\d+|\w+)/gs)
          for (const m of blockMatches) {
            paths.push({ path: m[1], pathType: m[2], serviceName: m[3], servicePort: parseInt(m[4]) || m[4] })
          }
        }
        if (host) ingresses.push({ name, namespace, host, paths, tlsHosts: tlsHosts.filter(th => th === host) })
      }
    }

    if (kind === 'NetworkPolicy') {
      const policyTypes: string[] = []
      const ptMatch = doc.match(/policyTypes:\n((?:\s+-.*\n?)*)/)?.[1]
      if (ptMatch) {
        for (const m of ptMatch.matchAll(/-\s*(\w+)/g)) policyTypes.push(m[1])
      } else {
        if (doc.includes('ingress:')) policyTypes.push('Ingress')
        if (doc.includes('egress:')) policyTypes.push('Egress')
      }

      const podSelector: Record<string, string> = {}
      const psSection = doc.match(/podSelector:\n((?:\s+.*\n?)*)/)?.[1]
      if (psSection) {
        for (const m of psSection.matchAll(/(\w+):\s*(\S+)/g)) podSelector[m[1]] = m[2]
      }

      const ingressRules: K8sNetworkPolicy['ingressRules'] = []
      const ingressSection = doc.match(/(?:ingress:\n)((?:\s+.*\n?)*?)(?:\n\S|\Z)/)?.[1]
      if (ingressSection) {
        const fromBlocks = ingressSection.split(/\n\s+- from:/).slice(1)
        for (const fb of fromBlocks) {
          const from: K8sNetworkPolicy['ingressRules'][0]['from'] = []
          const ps = fb.match(/podSelector:\n((?:\s+.*\n?)*)/)?.[1]
          const ns = fb.match(/namespaceSelector:\n((?:\s+.*\n?)*)/)?.[1]
          const ip = fb.match(/ipBlock:\s*(\S+)/)?.[1]
          const item: Record<string, unknown> = {}
          if (ps) { const sel: Record<string, string> = {}; for (const m of ps.matchAll(/(\w+):\s*(\S+)/g)) sel[m[1]] = m[2]; item.podSelector = sel }
          if (ns) { const sel: Record<string, string> = {}; for (const m of ns.matchAll(/(\w+):\s*(\S+)/g)) sel[m[1]] = m[2]; item.namespaceSelector = sel }
          if (ip) item.ipBlock = ip
          from.push(item)
          const portSection = fb.match(/ports:\n((?:\s+.*\n?)*)/)?.[1]
          const ports: { port: number | string; protocol: string }[] = []
          if (portSection) { for (const m of portSection.matchAll(/port:\s*(\d+|\w+).*?protocol:\s*(\w+)/gs)) ports.push({ port: m[1], protocol: m[2] }) }
          ingressRules.push({ from, ports })
        }
      }

      networkPolicies.push({ name, namespace, podSelector, policyTypes, ingressRules, egressRules: [] })
    }
  }

  return { services, ingresses, networkPolicies }
}

export function indexK8sNetworkResources(
  queries: QueryManager,
  projectRoot: string,
  moduleId: string
): { services: K8sServiceDetail[]; ingresses: K8sIngressDetail[]; networkPolicies: K8sNetworkPolicy[] } {
  const allServices: K8sServiceDetail[] = []
  const allIngresses: K8sIngressDetail[] = []
  const allNetPols: K8sNetworkPolicy[] = []

  const k8sDirs = [
    join(projectRoot, 'k8s'), join(projectRoot, 'deploy'),
    join(projectRoot, 'kubernetes'), join(projectRoot, 'manifest'),
  ]

  for (const dir of k8sDirs) {
    if (!existsSync(dir)) continue
    let entries: string[]
    try {
      entries = readdirSync(dir, { recursive: true }) as string[]
    } catch {
      continue
    }
    let count = 0
    for (const e of entries) {
      if (!e.endsWith('.yml') && !e.endsWith('.yaml')) continue
      if (++count > 200) break
      const f = join(dir, e)
      let content: string
      try {
        content = readFileSync(f, 'utf-8')
      } catch { continue }
      const parsed = parseK8sNetworkYaml(content)
      allServices.push(...parsed.services)
      allIngresses.push(...parsed.ingresses)
      allNetPols.push(...parsed.networkPolicies)
    }
  }

  for (const svc of allServices) {
    const svcId = `k8s:Service:${svc.name}`
    queries.insertAnnotation(svcId, 'K8sService',
      JSON.stringify({ type: svc.type, clusterIP: svc.clusterIP, ports: svc.ports }), 0, moduleId)

    const allNodes = queries.getAllNodes()
    for (const n of allNodes) {
      if (n.moduleId && n.name.toLowerCase().includes(svc.name.toLowerCase())) {
        queries.insertEdge(svcId, n.id, 'k8s_service_binding',
          JSON.stringify({ serviceType: svc.type, ports: svc.ports }), 0, 0)
      }
    }
  }

  for (const ing of allIngresses) {
    const ingId = `k8s:Ingress:${ing.name}:${ing.host}`
    queries.insertNode({
      id: ingId, kind: 'route', name: `${ing.name}:${ing.host}`,
      qualifiedName: `ingress:${ing.host}`,
      filePath: `k8s/${ing.name}.yaml`, language: 'yaml',
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
      docstring: `Ingress ${ing.name} (${ing.host})`, signature: `host: ${ing.host}`,
      visibility: 'public', isExported: true, parentId: null, moduleId,
    })

    for (const p of ing.paths) {
      queries.insertAnnotation(ingId, 'IngressPath',
        JSON.stringify({ host: ing.host, path: p.path, serviceName: p.serviceName, servicePort: p.servicePort }), 0, moduleId)

      const matchedServices = allServices.filter(s => s.name === p.serviceName)
      for (const ms of matchedServices) {
        const svcId = `k8s:Service:${ms.name}`
        queries.insertEdge(ingId, svcId, 'ingress_to_service',
          JSON.stringify({ path: p.path, serviceName: p.serviceName }), 0, 0)
      }

      const allNodes = queries.getAllNodes()
      for (const n of allNodes) {
        const anns = queries.getAnnotationsByNode(n.id)
        for (const a of anns) {
          if (['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping', 'RequestMapping'].includes(a.annotationName)) {
            const routePath = a.value.replace(/"/g, '')
            if (p.path.includes(routePath) || routePath.includes(p.path)) {
              queries.insertEdge(ingId, n.id, 'ingress_route_match',
                JSON.stringify({ host: ing.host, ingressPath: p.path, controllerPath: routePath }), 0, 0)
            }
          }
        }
      }
    }

    for (const tls of ing.tlsHosts) {
      queries.insertAnnotation(ingId, 'IngressTLS', JSON.stringify({ host: tls }), 0, moduleId)
    }
  }

  for (const np of allNetPols) {
    const npId = `k8s:NetworkPolicy:${np.name}`
    queries.insertAnnotation(npId, 'K8sNetworkPolicy',
      JSON.stringify({ policyTypes: np.policyTypes, podSelector: np.podSelector, ingressRules: np.ingressRules.length }), 0, moduleId)

    for (const rule of np.ingressRules) {
      for (const from of rule.from) {
        if (from.podSelector) {
          for (const [k, v] of Object.entries(from.podSelector)) {
            const matched = queries.getAllNodes().filter(n => n.moduleId && (n.name.includes(v) || n.filePath.includes(v)))
            for (const m of matched) {
              queries.insertEdge(npId, m.id, 'network_policy_allow',
                JSON.stringify({ direction: 'ingress', selector: `${k}=${v}`, ports: rule.ports }), 0, 0)
            }
          }
        }
      }
    }
  }

  return { services: allServices, ingresses: allIngresses, networkPolicies: allNetPols }
}
