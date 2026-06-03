import { readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { QueryManager } from '../db/queries.js'
import type { GatewayRouteInfo } from '../types.js'

export function parseGatewayYaml(content: string): GatewayRouteInfo[] {
  const routes: GatewayRouteInfo[] = []
  const routeBlocks = content.split(/(?=^\s+- id:)/m)

  for (const block of routeBlocks) {
    const idMatch = block.match(/id:\s*["']?(\S+)["']?/)
    if (!idMatch) continue
    const uriMatch = block.match(/uri:\s*["']?(lb:[^\s'"]+)[^'"]?["']?/)
    const orderMatch = block.match(/order:\s*(\d+)/)

    const predMatch = content.match(/predicates:\n((?:\s+- .*\n?)*)/)
    const predicates = predMatch
      ? [...predMatch[1].matchAll(/- \s*(.+)/g)].map(m => m[1].trim())
      : []

    const filtMatch = content.match(/filters:\n((?:\s+- .*\n?)*)/)
    const filters = filtMatch
      ? [...filtMatch[1].matchAll(/- \s*(.+)/g)].map(m => m[1].trim())
      : []

    routes.push({
      id: idMatch[1],
      uri: uriMatch?.[1] ?? '',
      predicates,
      filters,
      order: orderMatch ? parseInt(orderMatch[1]) : 0,
      metadata: {},
    })
  }

  return routes
}

export function parseGatewayConfig(projectRoot: string): GatewayRouteInfo[] {
  const candidates = [
    join(projectRoot, 'src', 'main', 'resources', 'application.yml'),
    join(projectRoot, 'src', 'main', 'resources', 'application.yaml'),
    join(projectRoot, 'src', 'main', 'resources', 'application-gateway.yml'),
    join(projectRoot, 'src', 'main', 'resources', 'bootstrap.yml'),
  ]

  for (const f of candidates) {
    if (!existsSync(f)) continue
    try {
      const content = readFileSync(f, 'utf-8')
      const yamlSection = content.match(/spring:\s*\n\s+cloud:\s*\n\s+gateway:\s*\n((?:\s+.*\n?)*)/)
      if (yamlSection) {
        const routeSection = yamlSection[1].match(/routes:\n((?:\s+.*\n?)*)/)
        if (routeSection) {
          return parseGatewayYaml(routeSection[0])
        }
      }
    } catch { /* silent */ }
  }

  return []
}

export function indexGatewayRoutes(
  queries: QueryManager,
  projectRoot: string,
  moduleId: string
): GatewayRouteInfo[] {
  const routes = parseGatewayConfig(projectRoot)
  if (routes.length === 0) return routes

  for (const route of routes) {
    const routeId = `gateway:${route.id}`

    const targetService = route.uri.replace(/^lb:\/\//, '').replace(/^http:\/\//, '').split(/[:/]/)[0]
    const targetNodes = queries.searchNodes(targetService, 20)
      .filter(n => n.moduleId !== moduleId)

    for (const tn of targetNodes) {
      queries.insertEdge(routeId, tn.id, 'routes_to',
        JSON.stringify({ gatewayRoute: route.id, uri: route.uri, predicates: route.predicates }),
        0, 0)
    }

    for (const pred of route.predicates) {
      const pathMatch = pred.match(/Path=\/([\w/-]+)/)
      if (pathMatch) {
        const urlPath = pathMatch[1]
        const allNodes = queries.getAllNodes()
        for (const n of allNodes) {
          const anns = queries.getAnnotationsByNode(n.id)
          for (const a of anns) {
            if (['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping', 'RequestMapping'].includes(a.annotationName)) {
              const routeVal = a.value.replace(/"/g, '')
              if (urlPath.includes(routeVal.replace(/^\//, '')) || routeVal.includes(urlPath)) {
                queries.insertEdge(routeId, n.id, 'gateway_to_endpoint',
                  JSON.stringify({ predicate: pred, endpoint: routeVal }), 0, 0)
              }
            }
          }
        }
      }
    }
  }

  return routes
}
