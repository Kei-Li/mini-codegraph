import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../../db/queries.js'

export interface K8sResource {
  kind: string
  name: string
  namespace: string
  labels: Record<string, string>
  selector: Record<string, string>
  image: string
  ports: string[]
  replicas: number
  configData: Record<string, string>
  serviceName: string
  ingressRules: { host: string; paths: string[] }[]
}

export function parseK8sYaml(content: string): K8sResource[] {
  const resources: K8sResource[] = []
  const docs = content.split(/\n---\n/)

  for (const doc of docs) {
    const kindMatch = doc.match(/kind:\s*(\w+)/)
    if (!kindMatch) continue
    const kind = kindMatch[1]

    const nameMatch = doc.match(/name:\s*(\S+)/)
    const nsMatch = doc.match(/namespace:\s*(\S+)/)
    const labelMatches = [...doc.matchAll(/(\w+):\s*(\S+)/g)]
    const labels: Record<string, string> = {}
    for (const m of labelMatches) labels[m[1]] = m[2]

    const imageMatch = doc.match(/image:\s*(\S+)/)
    const portMatches = [...doc.matchAll(/containerPort:\s*(\d+)/g)].map(m => m[1])
    const repMatch = doc.match(/replicas:\s*(\d+)/)
    const selector: Record<string, string> = {}

    const selSection = doc.match(/selector:\n((?:\s+.*\n?)*)/)?.[1]
    if (selSection) {
      const selMatches = [...selSection.matchAll(/(\w+):\s*(\S+)/g)]
      for (const m of selMatches) selector[m[1]] = m[2]
    }

    const configData: Record<string, string> = {}
    const dataSection = doc.match(/data:\n((?:\s+.*\n?)*)/)?.[1]
    if (dataSection) {
      const dataMatches = [...dataSection.matchAll(/(\w+):\s*(.+)/g)]
      for (const m of dataMatches) configData[m[1]] = m[2]
    }

    const ingressRules: { host: string; paths: string[] }[] = []
    const hostMatches = [...doc.matchAll(/host:\s*(\S+)/g)]
    const pathMatches = [...doc.matchAll(/paths?:\n((?:\s+.*\n?)*)/g)]
    for (const hm of hostMatches) {
      const paths = pathMatches[0]?.[1]
        ? [...pathMatches[0][1].matchAll(/path:\s*(\S+)/g)].map(m => m[1])
        : []
      ingressRules.push({ host: hm[1], paths })
    }

    resources.push({
      kind, name: nameMatch?.[1] ?? 'unknown', namespace: nsMatch?.[1] ?? 'default',
      labels, selector, image: imageMatch?.[1] ?? '', ports: portMatches,
      replicas: repMatch ? parseInt(repMatch[1]) : 1,
      configData, serviceName: nameMatch?.[1] ?? '',
      ingressRules,
    })
  }

  return resources
}

export function findK8sFiles(projectRoot: string): string[] {
  const files: string[] = []
  const k8sDirs = [
    join(projectRoot, 'k8s'),
    join(projectRoot, 'deploy'),
    join(projectRoot, 'kubernetes'),
    join(projectRoot, 'manifest'),
    join(projectRoot, '.k8s'),
  ]
  for (const dir of k8sDirs) {
    if (!existsSync(dir)) continue
    const entries = readdirSync(dir, { recursive: true }) as string[]
    for (const e of entries) {
      if (e.endsWith('.yml') || e.endsWith('.yaml')) files.push(join(dir, e))
    }
  }
  return files
}

export function indexK8sResources(
  queries: QueryManager,
  projectRoot: string,
  _moduleId: string
): K8sResource[] {
  const allResources: K8sResource[] = []
  const files = findK8sFiles(projectRoot)

  for (const f of files) {
    const content = readFileSync(f, 'utf-8')
    const resources = parseK8sYaml(content)
    allResources.push(...resources)

    for (const r of resources) {
      const resId = `k8s:${r.kind}:${r.name}`

      if (r.kind === 'Deployment') {
        for (const [k, v] of Object.entries(r.selector)) {
          const matched = queries.getAllNodes()
            .filter(n => n.moduleId && (n.name.toLowerCase().includes(v.toLowerCase()) || n.filePath.toLowerCase().includes(v.toLowerCase())))
          for (const m of matched) {
            queries.insertEdge(resId, m.id, 'k8s_deployment',
              JSON.stringify({ selector: `${k}=${v}`, replicas: r.replicas, image: r.image }), 0, 0)
          }
        }
      }

      if (r.kind === 'Service') {
        const allNodes = queries.getAllNodes()
        for (const n of allNodes) {
          if (n.moduleId && n.name.toLowerCase().includes(r.name.toLowerCase())) {
            queries.insertEdge(resId, n.id, 'k8s_service',
              JSON.stringify({ ports: r.ports }), 0, 0)
          }
        }
      }

      if (r.kind === 'Ingress') {
        for (const rule of r.ingressRules) {
          const routeId = `ingress:${rule.host}`
          for (const p of rule.paths) {
            const allNodes = queries.getAllNodes()
            for (const n of allNodes) {
              const anns = queries.getAnnotationsByNode(n.id)
              for (const a of anns) {
                if (['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping'].includes(a.annotationName)) {
                  const rv = a.value.replace(/"/g, '')
                  if (p.includes(rv) || rv.includes(p)) {
                    queries.insertEdge(routeId, n.id, 'ingress_route',
                      JSON.stringify({ host: rule.host, path: p }), 0, 0)
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return allResources
}
