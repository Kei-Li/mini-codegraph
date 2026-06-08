import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../../db/queries.js'
import type { OpenApiEndpoint } from '../../types.js'

export function parseOpenApiFile(filePath: string): OpenApiEndpoint[] {
  const endpoints: OpenApiEndpoint[] = []
  try {
    const content = readFileSync(filePath, 'utf-8')

    if (content.trim().startsWith('{')) {
      const json = JSON.parse(content)
      const paths = json.paths ?? {}
      for (const [path, methods] of Object.entries(paths)) {
        for (const [method, detail] of Object.entries(methods as Record<string, unknown>)) {
          if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue
          const d = detail as Record<string, unknown>
          const reqBody = d.requestBody as Record<string, unknown> | undefined
          const reqContent = reqBody?.content as Record<string, unknown> | undefined
          const appJson = reqContent?.['application/json'] as Record<string, unknown> | undefined
          endpoints.push({
            path, method: method.toUpperCase(),
            operationId: (d.operationId as string) ?? `${method}_${path.replace(/[/{}]/g, '_')}`,
            serviceName: (d['x-service'] as string) ?? (d.tags as string[])?.[0],
            parameters: ((d.parameters ?? []) as Record<string, unknown>[]).map((p: Record<string, unknown>) => ({
              name: p.name as string, in: p.in as string, required: (p.required as boolean) ?? false,
            })),
            requestBody: appJson?.$ref as string,
            responses: Object.fromEntries(
              Object.entries((d.responses ?? {}) as Record<string, Record<string, unknown>>).map(([code, r]: [string, Record<string, unknown>]) => [code, (r.description as string) ?? ''])
            ),
          })
        }
      }
    } else {
      const pathSection = content.match(/paths:\n((?:\s+.*\n?)*)/)?.[1] ?? ''
      const endpointRegex = /\s+\/(\S+):\s*\n((?:\s+.*\n?)*?)(?=\s+\/\S|\s+components|$)/g
      let m: RegExpExecArray | null
      while ((m = endpointRegex.exec(pathSection)) !== null) {
        const path = `/${m[1]}`
        const methodMatch = m[2].match(/\s+(\w+):/)
        if (methodMatch && ['get', 'post', 'put', 'delete', 'patch'].includes(methodMatch[1])) {
          const opIdMatch = m[2].match(/operationId:\s*(\S+)/)
          const tagMatch = m[2].match(/tags:\s*\n(?:\s+-\s*(\S+)\n?)*/)
          endpoints.push({
            path, method: methodMatch[1].toUpperCase(),
            operationId: opIdMatch?.[1] ?? `${methodMatch[1]}_${path.replace(/[/{}]/g, '_')}`,
            serviceName: tagMatch?.[1],
            parameters: [], requestBody: undefined, responses: {},
          })
        }
      }
    }
  } catch { /* silent */ }
  return endpoints
}

export function findOpenApiFiles(projectRoot: string): string[] {
  const candidates: string[] = []
  const dirs = [
    join(projectRoot, 'src', 'main', 'resources'),
    join(projectRoot, 'docs'),
    join(projectRoot, 'api-docs'),
    join(projectRoot, 'openapi'),
    join(projectRoot, 'swagger'),
  ]
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir)
    for (const f of files) {
      if (/openapi|swagger|api-docs/i.test(f) && (f.endsWith('.yml') || f.endsWith('.yaml') || f.endsWith('.json'))) {
        candidates.push(join(dir, f))
      }
    }
  }
  return candidates
}

export function indexOpenApiContracts(
  queries: QueryManager,
  projectRoot: string,
  moduleId: string
): OpenApiEndpoint[] {
  const allEndpoints: OpenApiEndpoint[] = []
  const files = findOpenApiFiles(projectRoot)

  for (const f of files) {
    const endpoints = parseOpenApiFile(f)
    allEndpoints.push(...endpoints)

    for (const ep of endpoints) {
      const epId = `openapi:${ep.method}:${ep.path}`

      const allNodes = queries.getAllNodes()
      for (const n of allNodes) {
        const anns = queries.getAnnotationsByNode(n.id)
        for (const a of anns) {
          if (['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping'].includes(a.annotationName)) {
            const routeVal = a.value.replace(/"/g, '')
            if (ep.path === routeVal || ep.path.endsWith(routeVal) || routeVal.endsWith(ep.path)) {
              queries.insertEdge(epId, n.id, 'api_contract',
                JSON.stringify({ operationId: ep.operationId, method: ep.method, path: ep.path }), 0, 0)
            }
          }
        }
      }

      if (ep.serviceName) {
        const targetNodes = queries.searchNodes(ep.serviceName, 10)
          .filter(n => n.moduleId !== moduleId)
        for (const tn of targetNodes) {
          queries.insertEdge(epId, tn.id, 'contract_service',
            JSON.stringify({ service: ep.serviceName }), 0, 0)
        }
      }
    }
  }

  return allEndpoints
}
