import type { QueryManager } from '../../db/queries.js'
import type { VueApiCall } from '../../types.js'

export function extractVueApiCalls(source: string, filePath: string): VueApiCall[] {
  const calls: VueApiCall[] = []

  const fetchPattern = /(?:await\s+)?(?:fetch|axios|http|\$axios|api)\s*[\(.]\s*['"`]([^'"`]+)['"`]/g
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
  _moduleId: string
): { apiCall: VueApiCall; controllerNodeId: string; route: string }[] {
  const resolved: { apiCall: VueApiCall; controllerNodeId: string; route: string }[] = []

  const allControllers = queries.getNodesByAnnotation('RestController')
    .concat(queries.getNodesByAnnotation('Controller'))

  // Build a map of controller id → @RequestMapping class-level prefix
  const ctrlPrefixMap = new Map<string, string>()
  for (const ctrl of allControllers) {
    const ctrlAnns = queries.getAnnotationsByNode(ctrl.id)
    let prefix = ''
    for (const ca of ctrlAnns) {
      if (ca.annotationName === 'RequestMapping') {
        prefix = ca.value.replace(/["']/g, '')
        break
      }
    }
    ctrlPrefixMap.set(ctrl.id, prefix)
  }

  // Pre-index all controller method routes for fast matching
  interface ControllerRoute {
    ctrlId: string
    methodId: string
    httpMethod: string
    fullPath: string
  }
  const allRoutes: ControllerRoute[] = []
  for (const ctrl of allControllers) {
    const prefix = ctrlPrefixMap.get(ctrl.id) ?? ''
    const ctrlChildren = queries.getChildren(ctrl.id)
    for (const method of ctrlChildren) {
      const methodAnns = queries.getAnnotationsByNode(method.id)
      for (const a of methodAnns) {
        if (['RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping'].includes(a.annotationName)) {
          const httpMethod = a.annotationName === 'RequestMapping' ? 'ANY'
            : a.annotationName.replace('Mapping', '').toUpperCase()
          const routePath = a.value.replace(/["']/g, '')
          const fullPath = `${prefix}${routePath}`
          allRoutes.push({ ctrlId: ctrl.id, methodId: method.id, httpMethod, fullPath })
        }
      }
    }
  }

  for (const call of apiCalls) {
    // Normalize: strip protocol/host, strip query string, remove trailing slash
    let urlPath = call.url
      .replace(/^https?:\/\/[^/]+/, '')
      .split('?')[0]
      .replace(/\/+$/, '') || '/'

    // Score each candidate route
    let bestScore = -1
    let bestMatch: ControllerRoute | null = null

    for (const route of allRoutes) {
      let score = matchUrlToRouteScored(urlPath, route.fullPath)

      // Exact path match
      if (urlPath === route.fullPath) score = 100

      // Bonus for matching HTTP method
      if (route.httpMethod === 'ANY' || route.httpMethod === call.method) score += 10

      if (score > bestScore) {
        bestScore = score
        bestMatch = route
      }
    }

    if (bestMatch && bestScore >= 60) {
      resolved.push({ apiCall: call, controllerNodeId: bestMatch.methodId, route: bestMatch.fullPath })
    }
  }

  return resolved
}

function matchUrlToRouteScored(url: string, route: string): number {
  const urlParts = url.split('/').filter(Boolean)
  const routeParts = route.split('/').filter(Boolean)
  if (urlParts.length !== routeParts.length) return 0

  let score = 60
  for (let i = 0; i < urlParts.length; i++) {
    const rp = routeParts[i] ?? ''
    if (rp.startsWith('{') || rp.startsWith(':')) {
      score += 5 // path variable matches anything
      continue
    }
    if (rp === urlParts[i]) {
      score += 10 // exact segment match
    } else if (rp.toLowerCase() === urlParts[i].toLowerCase()) {
      score += 5 // case-insensitive match
    } else {
      return 0 // segment mismatch
    }
  }
  return score
}
