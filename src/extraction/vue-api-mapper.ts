import { readFileSync } from 'node:fs'
import type { QueryManager } from '../db/queries.js'
import type { VueApiCall } from '../types.js'

export function extractVueApiCalls(source: string, filePath: string): VueApiCall[] {
  const calls: VueApiCall[] = []
  const lines = source.split('\n')

  const fetchPattern = /(?:await\s+)?(?:useFetch|fetch|axios|http|\$axios|api)\s*[\(.]\s*['"`]([^'"`]+)['"`]/g
  let m: RegExpExecArray | null
  while ((m = fetchPattern.exec(source)) !== null) {
    const url = m[1]
    const lineNum = source.substring(0, m.index).split('\n').length
    calls.push({ componentFile: filePath, method: 'GET', url, handler: m[0].trim(), line: lineNum })
  }

  const methodPatterns = [
    { regex: /\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g, method: (m: RegExpExecArray) => m[1].toUpperCase() },
    { regex: /\.request\(\s*['"`](\w+)['"`]\s*,\s*['"`]([^'"`]+)['"`]/g, method: (m: RegExpExecArray) => m[1].toUpperCase() },
  ]

  for (const { regex, method: getMethod } of methodPatterns) {
    let pm: RegExpExecArray | null
    while ((pm = regex.exec(source)) !== null) {
      const url = pm[2] || pm[1]
      const method = getMethod(pm)
      const lineNum = source.substring(0, pm.index).split('\n').length
      calls.push({ componentFile: filePath, method, url, handler: pm[0].trim(), line: lineNum })
    }
  }

  const useFetchPattern = /useFetch\s*\(\s*['"`]([^'"`]+)['"`]/g
  while ((m = useFetchPattern.exec(source)) !== null) {
    const url = m[1]
    const lineNum = source.substring(0, m.index).split('\n').length
    calls.push({ componentFile: filePath, method: 'GET', url, handler: `useFetch('${url}')`, line: lineNum })
  }

  const baseURLPattern = /(?:baseURL|baseUrl|BASE_URL)\s*[:=]\s*['"`]([^'"`]+)['"`]/g
  let baseURLs: string[] = []
  while ((m = baseURLPattern.exec(source)) !== null) {
    baseURLs.push(m[1])
  }

  if (baseURLs.length > 0) {
    calls.forEach(c => {
      if (!c.url.startsWith('http') && !c.url.startsWith('/')) {
        c.url = `${baseURLs[0]}${c.url.startsWith('/') ? '' : '/'}${c.url}`
      }
    })
  }

  return calls
}

export function resolveVueApiToController(
  queries: QueryManager,
  apiCalls: VueApiCall[],
  moduleId: string
): { apiCall: VueApiCall; controllerNodeId: string; route: string }[] {
  const resolved: { apiCall: VueApiCall; controllerNodeId: string; route: string }[] = []

  for (const call of apiCalls) {
    const urlPath = call.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    const pathParts = urlPath.split('/').filter(Boolean)

    const allControllers = queries.getNodesByAnnotation('RestController')
      .concat(queries.getNodesByAnnotation('Controller'))

    for (const ctrl of allControllers) {
      const ctrlChildren = queries.getChildren(ctrl.id)
      for (const method of ctrlChildren) {
        const anns = queries.getAnnotationsByNode(method.id)
        for (const a of anns) {
          if (['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping'].includes(a.annotationName)) {
            const routePath = a.value.replace(/"/g, '')
            const ctrlPrefix = getControllerPrefix(ctrl)
            const fullPath = `${ctrlPrefix}${routePath}`

            if (urlPath === fullPath ||
                (pathParts.length > 0 && fullPath.includes(pathParts[pathParts.length - 1])) ||
                matchUrlToRoute(urlPath, fullPath)) {
              resolved.push({ apiCall: call, controllerNodeId: method.id, route: fullPath })
            }
          }
        }
      }
    }
  }

  return resolved
}

function getControllerPrefix(ctrl: any): string {
  try {
    const ctrlText = JSON.stringify(ctrl)
    return ctrlText.match(/"value":"([^"]+)"/)?.[1] ?? ''
  } catch { return '' }
}

function matchUrlToRoute(url: string, route: string): boolean {
  const urlParts = url.split('/').filter(Boolean)
  const routeParts = route.split('/').filter(Boolean)
  if (urlParts.length !== routeParts.length) return false
  for (let i = 0; i < urlParts.length; i++) {
    if (routeParts[i]?.startsWith('{') || routeParts[i]?.startsWith(':')) continue
    if (routeParts[i] !== urlParts[i]) return false
  }
  return true
}
