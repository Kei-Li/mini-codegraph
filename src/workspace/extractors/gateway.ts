import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'

export interface GatewayRoute {
  id: string
  paths: string[]
  uri: string
  serviceName: string
}

function extractServiceName(uri: string): string {
  const lb = uri.match(/^lb:\/\/([\w-]+)/)
  if (lb) return lb[1]
  const http = uri.match(/^https?:\/\/([\w-]+)/)
  if (http) return http[1]
  return ''
}

function parseRouteLocatorJava(content: string): GatewayRoute[] {
  const routes: GatewayRoute[] = []

  const blockStart = content.match(/builder\.routes\s*\(\s*\)\s*\{/)
  const routePattern = /\.route\(\s*"([^"]+)"\s*,\s*(?:\w+\s*->\s*)?(?:r\s*->\s*\{?)\s*/g
  let match: RegExpExecArray | null

  while ((match = routePattern.exec(content)) !== null) {
    const routeId = match[1]
    const rest = content.slice(match.index + match[0].length)

    const pathRegex = /\.path\(\s*"([^"]+)"\s*(?:\s*,\s*"([^"]+)")?\s*\)/
    const pathMatch = rest.match(pathRegex)
    if (!pathMatch) continue

    const paths = [pathMatch[1]]
    if (pathMatch[2]) paths.push(pathMatch[2])

    const uriRegex = /\.uri\(\s*"([^"]+)"\s*\)/
    const uriMatch = rest.match(uriRegex)
    if (!uriMatch) continue

    const uri = uriMatch[1]
    routes.push({ id: routeId, paths, uri, serviceName: extractServiceName(uri) })
  }

  return routes
}

function parseGatewayYaml(content: string): GatewayRoute[] {
  const routes: GatewayRoute[] = []
  const lines = content.split('\n')
  let current: Partial<GatewayRoute> | null = null

  for (const line of lines) {
    const idMatch = line.match(/^\s*-\s*id:\s*(.+)/)
    if (idMatch) {
      if (current?.id) {
        if (current.uri && current.paths && current.paths.length > 0) {
          routes.push({ id: current.id, paths: current.paths, uri: current.uri, serviceName: extractServiceName(current.uri) })
        }
      }
      current = { id: idMatch[1].trim() }
      continue
    }
    if (!current) continue

    const uriMatch = line.match(/^\s*uri:\s*(.+)/)
    if (uriMatch) {
      current.uri = uriMatch[1].trim()
      continue
    }

    const predMatch = line.match(/^\s*predicates:\s*Path=(.+)/)
    if (predMatch) {
      current.paths = predMatch[1].split(',').map((s: string) => s.trim())
    }
  }

  if (current?.id && current.uri && current.paths && current.paths.length > 0) {
    routes.push({ id: current.id, paths: current.paths, uri: current.uri, serviceName: extractServiceName(current.uri) })
  }

  return routes
}

function findRouteLocatorFiles(projectRoot: string): string[] {
  const results: string[] = []
  const srcDir = join(projectRoot, 'src', 'main', 'java')
  if (!existsSync(srcDir)) return results

  const scanDir = (dir: string): void => {
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const e of entries) {
        if (e.isDirectory()) scanDir(join(dir, e.name))
        else if (e.name.endsWith('.java')) results.push(join(dir, e.name))
      }
    } catch { /* silent */ }
  }

  scanDir(srcDir)
  return results.filter(f => {
    try {
      const content = readFileSync(f, 'utf-8')
      return content.includes('RouteLocator') && content.includes('.routes()') && content.includes('.uri(')
    } catch { return false }
  })
}

export class GatewayExtractor implements IExtractor {
  name = 'gateway'

  async extract(projectRoot: string, _queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []
    const routes: GatewayRoute[] = []

    // try RouteLocatorBuilder DSL in Java files
    const javaFiles = findRouteLocatorFiles(projectRoot)
    for (const f of javaFiles) {
      try {
        const content = readFileSync(f, 'utf-8')
        routes.push(...parseRouteLocatorJava(content))
      } catch { /* silent */ }
    }

    // try YAML routes
    for (const fileName of ['application.yml', 'application.yaml']) {
      const fp = join(projectRoot, 'src', 'main', 'resources', fileName)
      if (existsSync(fp)) {
        try {
          const content = readFileSync(fp, 'utf-8')
          if (content.includes('gateway') && content.includes('routes')) {
            routes.push(...parseGatewayYaml(content))
          }
        } catch { /* silent */ }
      }
    }

    for (const route of routes) {
      provides.push({
        id: `gateway.${route.serviceName}`,
        name: route.serviceName,
        kind: 'gateway_route',
        signature: `path=${route.paths.join(',')} → ${route.uri}`,
      })

      if (route.serviceName) {
        consumes.push({
          symbolId: `gateway.to.${route.serviceName}.gatewayroute`,
          referenceType: 'http_request',
          sourceLocation: projectRoot,
        })
      }
    }

    return { provides, consumes }
  }
}
