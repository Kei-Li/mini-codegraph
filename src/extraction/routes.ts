import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import type { QueryManager } from '../db/queries.js'
import type { GraphQueryManager } from '../graph/queries.js'
import type { VueApiCall } from '../types.js'

export interface RouteInfo {
  framework: string
  method: string
  path: string
  handlerFile: string
  handlerName: string
  handlerLine: number
  sourceLine: string
}

export function detectRoutes(
  projectRoot: string,
  queries: QueryManager,
  graph: GraphQueryManager
): RouteInfo[] {
  const routes: RouteInfo[] = []

  const pkgJsonPath = join(projectRoot, 'package.json')
  const pomPath = join(projectRoot, 'pom.xml')
  const buildGradlePath = join(projectRoot, 'build.gradle')
  const requirementsTxt = join(projectRoot, 'requirements.txt')
  const gemfile = join(projectRoot, 'Gemfile')
  const goMod = join(projectRoot, 'go.mod')
  const composerJson = join(projectRoot, 'composer.json')

  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>

      if (deps.express) routes.push(...detectExpressRoutes(projectRoot, queries, graph))
      if (deps['@nestjs/core']) routes.push(...detectNestRoutes(projectRoot, queries, graph))
      if (deps['next']) routes.push(...detectNextRoutes(projectRoot, queries, graph))
      if (deps.react || deps['react-router-dom']) routes.push(...detectReactRouterRoutes(projectRoot, queries, graph))
      if (deps.fastify) routes.push(...detectFastifyRoutes(projectRoot, queries, graph))
      if (deps.koa) routes.push(...detectKoaRoutes(projectRoot, queries, graph))
      if (deps.nuxt || deps['nuxt3'] || deps['@nuxt/kit']) routes.push(...detectNuxtRoutes(projectRoot, queries, graph))
    } catch {
      // ignore parse errors
    }
  }

  if (existsSync(pomPath) || existsSync(buildGradlePath)) {
    routes.push(...detectSpringRoutes(projectRoot, queries, graph))
    // Also detect RestTemplate-based cross-service HTTP calls (design §8.1)
    routes.push(...detectRestTemplateCalls(projectRoot))
    // Detect WebClient HTTP calls
    routes.push(...detectWebClientCalls(projectRoot))
    // Detect WebFlux functional endpoints
    routes.push(...detectWebFluxRoutes(projectRoot))
  }

  if (existsSync(requirementsTxt)) {
    try {
      const pip = readFileSync(requirementsTxt, 'utf-8')
      if (/^Django/im.test(pip)) routes.push(...detectDjangoRoutes(projectRoot, queries, graph))
      if (/^Flask/im.test(pip)) routes.push(...detectFlaskRoutes(projectRoot, queries, graph))
    } catch { /* silent */ }
  }

  if (existsSync(gemfile)) {
    try {
      const gem = readFileSync(gemfile, 'utf-8')
      if (/gem\s+['"]rails['"]/im.test(gem)) routes.push(...detectRailsRoutes(projectRoot, queries, graph))
    } catch { /* silent */ }
  }

  if (existsSync(goMod)) {
    try {
      const mod = readFileSync(goMod, 'utf-8')
      if (/gin-gonic\/gin/.test(mod)) routes.push(...detectGinRoutes(projectRoot, queries, graph))
    } catch { /* silent */ }
  }

  if (existsSync(composerJson)) {
    try {
      const composer = JSON.parse(readFileSync(composerJson, 'utf-8'))
      const deps = { ...composer.require, ...composer['require-dev'] } as Record<string, string>
      if (deps?.['laravel/framework']) routes.push(...detectLaravelRoutes(projectRoot, queries, graph))
    } catch { /* silent */ }
  }

  // ASP.NET — detect by .csproj files
  const csprojFiles = findFilesByExt(projectRoot, ['.csproj'])
  for (const csproj of csprojFiles) {
    try {
      const csprojContent = readFileSync(csproj, 'utf-8')
      if (/Microsoft\.AspNetCore/.test(csprojContent)) {
        routes.push(...detectAspNetCoreRoutes(projectRoot, queries, graph))
        break
      }
    } catch { /* silent */ }
  }

  return routes
}

function detectExpressRoutes(projectRoot: string, queries: QueryManager, graph: GraphQueryManager): RouteInfo[] {
  const routes: RouteInfo[] = []
  const expressFiles = findFilesByApiPattern(projectRoot, ['.js', '.ts', '.mjs'])
    .filter(f => f.match(/route|router|controller|api|endpoint/i))

  for (const file of expressFiles) {
    try {
      const content = readFileSync(file, 'utf-8')
      const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')

      const routePattern = /\.(get|post|put|delete|patch|all)\(\s*['"](.+?)['"]\s*,/g
      let match: RegExpExecArray | null
      while ((match = routePattern.exec(content)) !== null) {
        const method = match[1].toUpperCase()
        const path = match[2]
        const lineNum = content.substring(0, match.index).split('\n').length

        const handlerMatch = content.substring(match.index).match(/(\w+)\s*[)})]\s*\)/)
        const handlerName = handlerMatch?.[1] ?? 'anonymous'

        routes.push({
          framework: 'express',
          method,
          path,
          handlerFile: relPath,
          handlerName,
          handlerLine: lineNum,
          sourceLine: content.split('\n')[lineNum - 1]?.trim() ?? '',
        })
      }
    } catch {
      // skip
    }
  }

  return routes
}

function detectNestRoutes(projectRoot: string, queries: QueryManager, graph: GraphQueryManager): RouteInfo[] {
  const routes: RouteInfo[] = []
  const controllerFiles = findFilesByApiPattern(projectRoot, ['.ts'])
    .filter(f => f.match(/controller|module|resolver/i))

  for (const file of controllerFiles) {
    try {
      const content = readFileSync(file, 'utf-8')
      const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      const lines = content.split('\n')

      let controllerPrefix = ''
      for (const line of lines) {
        const prefixMatch = line.match(/@Controller\(\s*['"](.+?)['"]\s*\)/)
        if (prefixMatch) controllerPrefix = prefixMatch[1]
      }

      const routeMatchers = [
        /@Get\(\s*['"](.+?)['"]\s*\)/g,
        /@Post\(\s*['"](.+?)['"]\s*\)/g,
        /@Put\(\s*['"](.+?)['"]\s*\)/g,
        /@Delete\(\s*['"](.+?)['"]\s*\)/g,
        /@Patch\(\s*['"](.+?)['"]\s*\)/g,
      ]
      const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']

      for (let mi = 0; mi < routeMatchers.length; mi++) {
        let m: RegExpExecArray | null
        while ((m = routeMatchers[mi].exec(content)) !== null) {
          const routePath = m[1]
          const pos = content.substring(0, m.index).split('\n').length
          let handlerName = 'anonymous'
          for (let i = pos - 1; i < lines.length && i < pos + 5; i++) {
            const fMatch = lines[i]?.match(/(?:async\s+)?(\w+)\s*\(/)
            if (fMatch && !fMatch[1].match(/^[A-Z]/)) {
              handlerName = fMatch[1]
              break
            }
          }

          routes.push({
            framework: 'nestjs',
            method: methods[mi],
            path: controllerPrefix ? `${controllerPrefix}${routePath}` : routePath,
            handlerFile: relPath,
            handlerName,
            handlerLine: pos,
            sourceLine: lines[pos - 1]?.trim() ?? '',
          })
        }
      }
    } catch {
      // skip
    }
  }

  return routes
}

function detectNextRoutes(projectRoot: string, queries: QueryManager, graph: GraphQueryManager): RouteInfo[] {
  const routes: RouteInfo[] = []
  const appDir = join(projectRoot, 'app')
  const pagesDir = join(projectRoot, 'pages')

  for (const dir of [appDir, pagesDir]) {
    if (!existsSync(dir)) continue

    const files = findFilesRecursive(dir, ['.tsx', '.jsx', '.ts', '.js'])
    for (const file of files) {
      const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      const routePath = relPath
        .replace(/^app\//, '/')
        .replace(/^pages\//, '/')
        .replace(/\/page\.(tsx|jsx|ts|js)$/, '')
        .replace(/\/route\.(tsx|jsx|ts|js)$/, '')
        .replace(/\.(tsx|jsx|ts|js)$/, '')
        .replace(/\[\.\.\.(\w+)\]/, '*$1')
        .replace(/\[(\w+)\]/, ':$1')
        .replace(/\/index$/, '')

      if (!routePath) continue

      const lineNum = 1

      routes.push({
        framework: 'nextjs',
        method: 'GET',
        path: routePath || '/',
        handlerFile: relPath,
        handlerName: 'default',
        handlerLine: lineNum,
        sourceLine: relPath,
      })
    }
  }

  return routes
}

function detectReactRouterRoutes(projectRoot: string, queries: QueryManager, graph: GraphQueryManager): RouteInfo[] {
  const routes: RouteInfo[] = []

  const routeFiles = findFilesByApiPattern(projectRoot, ['.tsx', '.jsx', '.ts', '.js'])
    .filter(f => f.match(/router|route|app|navigation/i))

  for (const file of routeFiles) {
    try {
      const content = readFileSync(file, 'utf-8')
      const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')

      const routePattern = /<Route\s[^>]*?(?:path=['"](.+?)['"]).*?(?:element=\{?<(\w+)[\s\}>]|component=\{?(\w+)[\s\}>])/gs
      let m: RegExpExecArray | null
      while ((m = routePattern.exec(content)) !== null) {
        const path = m[1]
        const handlerName = m[2] || m[3] || 'anonymous'
        const lineNum = content.substring(0, m.index).split('\n').length

        routes.push({
          framework: 'react-router',
          method: 'GET',
          path,
          handlerFile: relPath,
          handlerName,
          handlerLine: lineNum,
          sourceLine: content.split('\n')[lineNum - 1]?.trim() ?? '',
        })
      }
    } catch {
      // skip
    }
  }

  return routes
}

function detectFastifyRoutes(projectRoot: string, queries: QueryManager, graph: GraphQueryManager): RouteInfo[] {
  const routes: RouteInfo[] = []
  const files = findFilesByApiPattern(projectRoot, ['.js', '.ts', '.mjs'])
    .filter(f => f.match(/route|server|api|plugin/i))

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8')
      const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')

      const routePattern = /\.(get|post|put|delete|patch)\s*\(\s*['"](.+?)['"]\s*,/g
      let m: RegExpExecArray | null
      while ((m = routePattern.exec(content)) !== null) {
        const method = m[1].toUpperCase()
        const path = m[2]
        const lineNum = content.substring(0, m.index).split('\n').length

        routes.push({
          framework: 'fastify',
          method,
          path,
          handlerFile: relPath,
          handlerName: 'anonymous',
          handlerLine: lineNum,
          sourceLine: content.split('\n')[lineNum - 1]?.trim() ?? '',
        })
      }
    } catch {
      // skip
    }
  }

  return routes
}

function detectKoaRoutes(projectRoot: string, queries: QueryManager, graph: GraphQueryManager): RouteInfo[] {
  const routes: RouteInfo[] = []
  const files = findFilesByApiPattern(projectRoot, ['.js', '.ts', '.mjs'])
    .filter(f => f.match(/route|router|controller|api/i))

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8')
      const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')

      const routePattern = /\.(get|post|put|delete|patch|all)\s*\(\s*['"](.+?)['"]\s*,/g
      let m: RegExpExecArray | null
      while ((m = routePattern.exec(content)) !== null) {
        const method = m[1].toUpperCase()
        const path = m[2]
        const lineNum = content.substring(0, m.index).split('\n').length

        routes.push({
          framework: 'koa',
          method,
          path,
          handlerFile: relPath,
          handlerName: 'anonymous',
          handlerLine: lineNum,
          sourceLine: content.split('\n')[lineNum - 1]?.trim() ?? '',
        })
      }
    } catch {
      // skip
    }
  }

  return routes
}

function detectSpringRoutes(projectRoot: string, queries: QueryManager, graph: GraphQueryManager): RouteInfo[] {
  const routes: RouteInfo[] = []
  const javaFiles = findFilesByApiPattern(projectRoot, ['.java'])
    .filter(f => f.match(/controller|resource/i))

  for (const file of javaFiles) {
    try {
      const content = readFileSync(file, 'utf-8')
      const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      const lines = content.split('\n')

      let classPrefix = ''
      const classMatch = content.match(/@RequestMapping\(\s*['"](.+?)['"]\s*\)/)
      if (classMatch) classPrefix = classMatch[1]

      const annotationPattern = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\(\s*['"](.+?)['"]\s*\)/g
      const methodMap: Record<string, string> = {
        GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT',
        DeleteMapping: 'DELETE', PatchMapping: 'PATCH', RequestMapping: 'ANY',
      }

      let m: RegExpExecArray | null
      while ((m = annotationPattern.exec(content)) !== null) {
        const httpMethod = methodMap[m[1]] || 'GET'
        const routePath = m[2]
        const lineNum = content.substring(0, m.index).split('\n').length

        let handlerName = 'anonymous'
        for (let i = lineNum - 1; i < lines.length && i < lineNum + 5; i++) {
          const fMatch = lines[i]?.match(/(?:public\s+)?\w+\s+(\w+)\s*\(/)
          if (fMatch) {
            handlerName = fMatch[1]
            break
          }
        }

        routes.push({
          framework: 'spring',
          method: httpMethod,
          path: `${classPrefix}${routePath}`,
          handlerFile: relPath,
          handlerName,
          handlerLine: lineNum,
          sourceLine: lines[lineNum - 1]?.trim() ?? '',
        })
      }
    } catch {
      // skip
    }
  }

  return routes
}

function detectDjangoRoutes(projectRoot: string, _queries: QueryManager, _graph: GraphQueryManager): RouteInfo[] {
  const routes: RouteInfo[] = []
  const urlFiles = findFilesByApiPattern(projectRoot, ['.py'])
    .filter(f => f.endsWith('urls.py') || f.includes('/urls/'))

  for (const file of urlFiles) {
    try {
      const content = readFileSync(file, 'utf-8')
      const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      const lines = content.split('\n')

      const pattern = /(?:path|re_path|url)\s*\(\s*['"](.+?)['"]\s*,/g
      let m: RegExpExecArray | null
      while ((m = pattern.exec(content)) !== null) {
        const path = m[1]
        const lineNum = content.substring(0, m.index).split('\n').length
        const handlerMatch = content.substring(m.index).match(/(\w+)\.as_view|(\w+)\s*[,)]/)
        const handlerName = handlerMatch?.[1] ?? handlerMatch?.[2] ?? 'anonymous'

        routes.push({
          framework: 'django',
          method: 'ANY',
          path,
          handlerFile: relPath,
          handlerName,
          handlerLine: lineNum,
          sourceLine: lines[lineNum - 1]?.trim() ?? '',
        })
      }
    } catch { /* silent */ }
  }

  return routes
}

function detectFlaskRoutes(projectRoot: string, _queries: QueryManager, _graph: GraphQueryManager): RouteInfo[] {
  const routes: RouteInfo[] = []
  const pyFiles = findFilesByApiPattern(projectRoot, ['.py'])
    .filter(f => f.match(/route|app|api|server|controller/i))

  for (const file of pyFiles) {
    try {
      const content = readFileSync(file, 'utf-8')
      const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      const lines = content.split('\n')

      const pattern = /@(\w+)\.route\(\s*['"](.+?)['"]\s*(?:,\s*methods\s*=\s*\[([^\]]+)\])?/g
      let m: RegExpExecArray | null
      while ((m = pattern.exec(content)) !== null) {
        const path = m[2]
        const methodsStr = m[3]
        const lineNum = content.substring(0, m.index).split('\n').length
        let methods = ['GET']
        if (methodsStr) {
          methods = methodsStr.split(',').map(s => s.trim().replace(/['"]/g, '').toUpperCase())
        }

        let handlerName = 'anonymous'
        for (let i = lineNum; i < lines.length && i < lineNum + 5; i++) {
          const fMatch = lines[i]?.match(/^def\s+(\w+)\s*\(/)
          if (fMatch) { handlerName = fMatch[1]; break }
        }

        for (const method of methods) {
          routes.push({
            framework: 'flask',
            method,
            path,
            handlerFile: relPath,
            handlerName,
            handlerLine: lineNum,
            sourceLine: lines[lineNum - 1]?.trim() ?? '',
          })
        }
      }
    } catch { /* silent */ }
  }

  return routes
}

function detectRailsRoutes(projectRoot: string, _queries: QueryManager, _graph: GraphQueryManager): RouteInfo[] {
  const routes: RouteInfo[] = []
  const routesFile = join(projectRoot, 'config', 'routes.rb')

  if (!existsSync(routesFile)) return routes

  try {
    const content = readFileSync(routesFile, 'utf-8')
    const relPath = 'config/routes.rb'
    const lines = content.split('\n')

    const pattern = /\b(get|post|put|patch|delete|resource|resources)\s+(?::(\w+)|['"](.+?)['"])/g
    const methodMap: Record<string, string> = {
      get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE',
      resource: 'ANY', resources: 'ANY',
    }
    let m: RegExpExecArray | null
    while ((m = pattern.exec(content)) !== null) {
      const keyword = m[1].toLowerCase()
      const method = methodMap[keyword] || 'GET'
      const path = m[2] ? `:${m[2]}` : m[3]
      const lineNum = content.substring(0, m.index).split('\n').length

      let handlerName = 'anonymous'
      const handlerMatch = content.substring(m.index).match(/(?:to:\s*['"]#?(\w+)#?|controller:\s*['"](\w+)['"])/)
      if (handlerMatch) handlerName = handlerMatch[1] || handlerMatch[2]

      routes.push({
        framework: 'rails',
        method,
        path: path.startsWith('/') ? path : `/${path}`,
        handlerFile: relPath,
        handlerName,
        handlerLine: lineNum,
        sourceLine: lines[lineNum - 1]?.trim() ?? '',
      })
    }
  } catch { /* silent */ }

  return routes
}

function detectGinRoutes(projectRoot: string, _queries: QueryManager, _graph: GraphQueryManager): RouteInfo[] {
  const routes: RouteInfo[] = []
  const goFiles = findFilesByApiPattern(projectRoot, ['.go'])
    .filter(f => f.match(/route|router|server|api|handler|controller/i))

  for (const file of goFiles) {
    try {
      const content = readFileSync(file, 'utf-8')
      const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      const lines = content.split('\n')

      const pattern = /\.(GET|POST|PUT|DELETE|PATCH|ANY)\s*\(\s*['"](.+?)['"]\s*,/g
      let m: RegExpExecArray | null
      while ((m = pattern.exec(content)) !== null) {
        const method = m[1]
        const path = m[2]
        const lineNum = content.substring(0, m.index).split('\n').length

        const handlerMatch = content.substring(m.index).match(/(\w+)\s*[,)]/)
        const handlerName = handlerMatch?.[1] ?? 'anonymous'

        routes.push({
          framework: 'gin',
          method,
          path,
          handlerFile: relPath,
          handlerName,
          handlerLine: lineNum,
          sourceLine: lines[lineNum - 1]?.trim() ?? '',
        })
      }
    } catch { /* silent */ }
  }

  return routes
}

function detectLaravelRoutes(projectRoot: string, _queries: QueryManager, _graph: GraphQueryManager): RouteInfo[] {
  const routes: RouteInfo[] = []
  const routeDirs = [join(projectRoot, 'routes'), join(projectRoot, 'app', 'routes')]

  for (const dir of routeDirs) {
    if (!existsSync(dir)) continue
    const phpFiles = findFilesRecursive(dir, ['.php'])

    for (const file of phpFiles) {
      try {
        const content = readFileSync(file, 'utf-8')
        const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
        const lines = content.split('\n')

        const pattern = /Route::(get|post|put|patch|delete|any|match|resource)\s*\(\s*['"](.+?)['"]\s*,/g
        const methodMap: Record<string, string> = {
          get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE',
          any: 'ANY', match: 'ANY', resource: 'GET',
        }
        let m: RegExpExecArray | null
        while ((m = pattern.exec(content)) !== null) {
          const keyword = m[1].toLowerCase()
          const method = methodMap[keyword] || 'GET'
          const path = m[2]
          const lineNum = content.substring(0, m.index).split('\n').length

          const handlerMatch = content.substring(m.index).match(/(\w+)::class|\[(\w+)\.class|(\w+)Controller/)
          const handlerName = handlerMatch?.[1] ?? handlerMatch?.[2] ?? handlerMatch?.[3] ?? 'anonymous'

          routes.push({
            framework: 'laravel',
            method,
            path: path.startsWith('/') ? path : `/${path}`,
            handlerFile: relPath,
            handlerName,
            handlerLine: lineNum,
            sourceLine: lines[lineNum - 1]?.trim() ?? '',
          })
        }
      } catch { /* silent */ }
    }
  }

  return routes
}

export function detectRestTemplateCalls(projectRoot: string): RouteInfo[] {
  const routes: RouteInfo[] = []
  const javaFiles = findFilesByApiPattern(projectRoot, ['.java'])
    .filter(f => {
      try {
        const content = readFileSync(f, 'utf-8')
        return /\brestTemplate\b/.test(content)
      } catch { return false }
    })

  const restMethods = [
    'getForObject', 'getForEntity', 'postForObject', 'postForEntity',
    'put', 'delete', 'patchForObject', 'exchange', 'execute',
  ]
  const urlPattern = new RegExp(
    `restTemplate\\.(?:${restMethods.join('|')})\\s*\\(\\s*['"\`](https?://[^'"\`\\s)]+)['"\`]`,
    'g'
  )

  for (const file of javaFiles) {
    try {
      const content = readFileSync(file, 'utf-8')
      const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      const lines = content.split('\n')
      urlPattern.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = urlPattern.exec(content)) !== null) {
        const fullUri = m[1]
        const pathPart = m[2]
        const lineNum = content.substring(0, m.index).split('\n').length
        routes.push({
          framework: 'spring-resttemplate',
          method: 'ANY',
          path: fullUri,
          handlerFile: relPath,
          handlerName: `restTemplate call: ${fullUri}`,
          handlerLine: lineNum,
          sourceLine: lines[lineNum - 1]?.trim() ?? '',
        })
      }
    } catch { /* silent */ }
  }
  return routes
}

function detectAspNetCoreRoutes(projectRoot: string, _queries: QueryManager, _graph: GraphQueryManager): RouteInfo[] {
  const routes: RouteInfo[] = []
  const csFiles = findFilesByApiPattern(projectRoot, ['.cs'])
    .filter(f => f.match(/controller|endpoint|route/i))

  for (const file of csFiles) {
    try {
      const content = readFileSync(file, 'utf-8')
      const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      const lines = content.split('\n')

      let controllerRoute = ''
      const classRouteMatch = content.match(/\[Route\(\s*["'](.+?)["']\s*\)\]/)
      if (classRouteMatch) controllerRoute = classRouteMatch[1]

      const pattern = /\[HttpGet(?:\(\s*["'](.+?)["']\s*\))?\]|\[HttpPost(?:\(\s*["'](.+?)["']\s*\))?\]|\[HttpPut(?:\(\s*["'](.+?)["']\s*\))?\]|\[HttpDelete(?:\(\s*["'](.+?)["']\s*\))?\]|\[HttpPatch(?:\(\s*["'](.+?)["']\s*\))?\]|\[Route\(\s*["'](.+?)["']\s*\)\]/g
      const methodMap: Record<string, string> = {
        HttpGet: 'GET', HttpPost: 'POST', HttpPut: 'PUT',
        HttpDelete: 'DELETE', HttpPatch: 'PATCH', Route: 'ANY',
      }
      let m: RegExpExecArray | null
      while ((m = pattern.exec(content)) !== null) {
        const attrName = m[0].replace(/\[(\w+).*/, '$1')
        const method = methodMap[attrName] || 'GET'
        const attrPath = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? ''
        const fullPath = controllerRoute ? `${controllerRoute}/${attrPath}`.replace(/\/+/g, '/') : attrPath
        const lineNum = content.substring(0, m.index).split('\n').length

        let handlerName = 'anonymous'
        for (let i = lineNum; i < lines.length && i < lineNum + 5; i++) {
          const fMatch = lines[i]?.match(/(?:public\s+)?(?:async\s+)?\w+\s+(\w+)\s*\(/)
          if (fMatch && !fMatch[1].startsWith('I')) {
            handlerName = fMatch[1]; break
          }
        }

        routes.push({
          framework: 'aspnetcore',
          method,
          path: fullPath.startsWith('/') ? fullPath : `/${fullPath}`,
          handlerFile: relPath,
          handlerName,
          handlerLine: lineNum,
          sourceLine: lines[lineNum - 1]?.trim() ?? '',
        })
      }
    } catch { /* silent */ }
  }

  return routes
}

function detectNuxtRoutes(projectRoot: string, _queries: QueryManager, _graph: GraphQueryManager): RouteInfo[] {
  const routes: RouteInfo[] = []

  const pagesDir = join(projectRoot, 'pages')
  if (!existsSync(pagesDir)) return routes

  const vueFiles = findFilesRecursive(pagesDir, ['.vue'])
  for (const file of vueFiles) {
    const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')

    let routePath = relPath
      .replace(/^pages\//, '/')
      .replace(/\.vue$/, '')
      .replace(/\/index$/, '')
      .replace(/\/_(\w+)/g, '/:$1')
      .replace(/\/\[(\w+)\]/g, '/:$1')
      .replace(/\/\[\.\.\.(\w+)\]/, '/*$1')
      .replace(/\/\((\w+)\)/g, '')

    if (!routePath) routePath = '/'

    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n')

    let handlerName = 'default'
    const exportMatch = content.match(/export\s+(default\s+)?(?:function|const|class)\s+(\w+)/)
    if (exportMatch) handlerName = exportMatch[2]

    routes.push({
      framework: 'nuxt',
      method: 'GET',
      path: routePath,
      handlerFile: relPath,
      handlerName,
      handlerLine: 1,
      sourceLine: lines[0]?.trim() ?? relPath,
    })
  }

  return routes
}

function findFilesByExt(root: string, extensions: string[]): string[] {
  const result: string[] = []
  if (!existsSync(root)) return result
  try {
    const entries = readdirSync(root, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(root, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'target'
            && entry.name !== 'venv' && entry.name !== '.venv') {
          result.push(...findFilesByExt(fullPath, extensions))
        }
      } else if (entry.isFile()) {
        const ext = extname(entry.name)
        if (extensions.includes(ext)) result.push(fullPath)
      }
    }
  } catch { /* silent */ }
  return result
}

function findFilesByApiPattern(root: string, extensions: string[]): string[] {
  const result: string[] = []
  if (!existsSync(root)) return result

  const searchDirs = [
    join(root, 'src'),
    join(root, 'routes'),
    join(root, 'api'),
    join(root, 'controllers'),
    join(root, 'app'),
  ].filter(d => existsSync(d))

  const dirs = searchDirs.length > 0 ? searchDirs : [root]

  for (const dir of dirs) {
    result.push(...findFilesRecursive(dir, extensions))
  }

  return result
}

function findFilesRecursive(dir: string, extensions: string[]): string[] {
  const result: string[] = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'target' && entry.name !== '.nuxt') {
          result.push(...findFilesRecursive(fullPath, extensions))
        }
      } else if (entry.isFile()) {
        const ext = '.' + entry.name.split('.').pop()
        if (extensions.includes(ext)) {
          result.push(fullPath)
        }
      }
    }
  } catch {
    // skip
  }
  return result
}

/**
 * Persist RestTemplate HTTP calls into external_references table
 * so they appear in mini_cg_callers / mini_cg_impact queries.
 */
export function storeRestTemplateReferences(projectRoot: string, queries: QueryManager, serviceName: string): number {
  const routes = detectRestTemplateCalls(projectRoot)
  let count = 0
  for (const route of routes) {
    const url = route.path
    const svcMatch = url.match(/^https?:\/\/([^/]+)/)
    if (!svcMatch) continue
    const targetService = svcMatch[1]
    const symbolId = `http.resttemplate.${targetService}${route.path.replace(/[^a-zA-Z0-9/_-]/g, '_')}`
    queries.insertExternalSymbol(symbolId, route.path, 'http_endpoint', targetService, route.handlerFile, `RestTemplate ${route.path}`, '{}')
    queries.insertExternalReference(`${route.handlerFile}:${route.handlerLine}`, symbolId, 'http_request', targetService, JSON.stringify({ method: 'ANY', url: route.path }), serviceName)
    count++
  }
  return count
}

/**
 * Detect WebClient HTTP calls in Java files (Spring WebClient fluent API).
 */
export function detectWebClientCalls(projectRoot: string): RouteInfo[] {
  const routes: RouteInfo[] = []
  const javaFiles = findFilesByApiPattern(projectRoot, ['.java'])
    .filter(f => {
      try {
        const content = readFileSync(f, 'utf-8')
        return /\bWebClient\b/.test(content)
      } catch { return false }
    })

  const wcRe1 = new RegExp("\\.(get|post|put|delete|patch)\\s*\\(\\s*\\)\\s*\\.\\s*uri\\s*\\(\\s*['\"`](https?://[^'\"`\\s)]+)['\"`]", 'g')
  const wcRe2 = new RegExp("\\.(get|post|put|delete|patch)\\s*\\(\\s*\\)\\s*\\.\\s*uri\\s*\\(\\s*['\"`]([^'\"`\\s)]+)['\"`]", 'g')
  const webClientPatterns = [wcRe1, wcRe2]

  for (const file of javaFiles) {
    try {
      const content = readFileSync(file, 'utf-8')
      const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      const lines = content.split('\n')
      for (const pattern of webClientPatterns) {
        pattern.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = pattern.exec(content)) !== null) {
          const fullUri = m[2]
          const lineNum = content.substring(0, m.index).split('\n').length
          routes.push({
            framework: 'spring-webclient',
            method: m[1].toUpperCase(),
            path: fullUri,
            handlerFile: relPath,
            handlerName: `webClient ${m[1]}() call: ${fullUri}`,
            handlerLine: lineNum,
            sourceLine: lines[lineNum - 1]?.trim() ?? '',
          })
        }
      }
    } catch { /* silent */ }
  }
  return routes
}

/**
 * Persist WebClient HTTP calls into external_references table.
 */
export function storeWebClientReferences(projectRoot: string, queries: QueryManager, serviceName: string): number {
  const routes = detectWebClientCalls(projectRoot)
  let count = 0
  for (const route of routes) {
    const url = route.path
    const svcMatch = url.match(/^https?:\/\/([^/]+)/)
    if (svcMatch) {
      const targetService = svcMatch[1]
      const symbolId = `http.webclient.${targetService}${route.path.replace(/[^a-zA-Z0-9/_-]/g, '_')}`
      queries.insertExternalSymbol(symbolId, route.path, 'http_endpoint', targetService, route.handlerFile, `WebClient ${route.method} ${route.path}`, '{}')
      queries.insertExternalReference(`${route.handlerFile}:${route.handlerLine}`, symbolId, 'http_request', targetService, JSON.stringify({ method: route.method, url: route.path }), serviceName)
      count++
    } else {
      // Relative URI — persist with the current service as target for cross-module traceability
      const pathKey = url.replace(/[^a-zA-Z0-9/_-]/g, '_')
      const symbolId = `http.webclient.local.${pathKey}`
      queries.insertExternalSymbol(symbolId, url, 'http_endpoint', serviceName, route.handlerFile, `WebClient ${route.method} ${url}`, '{}')
      queries.insertExternalReference(`${route.handlerFile}:${route.handlerLine}`, symbolId, 'http_request', serviceName, JSON.stringify({ method: route.method, url, relative: true }), serviceName)
      count++
    }
  }
  return count
}

/**
 * Detect Spring WebFlux functional endpoints (RouterFunction-based routes).
 */
export function detectWebFluxRoutes(projectRoot: string): RouteInfo[] {
  const routes: RouteInfo[] = []
  const javaFiles = findFilesByApiPattern(projectRoot, ['.java'])
    .filter(f => {
      try {
        const content = readFileSync(f, 'utf-8')
        return /\bRouterFunction\b/.test(content)
      } catch { return false }
    })

  const routeRe = new RegExp("\\.route\\s*\\(\\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\\s*\\(\\s*[\"]([^\"]+)[\"]\\s*\\)\\s*,\\s*(\\w+)::(\\w+)", 'g')
  const nestedRe = new RegExp("route\\s*\\(\\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\\s*\\(\\s*[\"]([^\"]+)[\"]\\s*\\)\\s*,\\s*(?:req\\s*->\\s*)?(\\w+)::(\\w+)", 'g')
  const routePattern = routeRe
  const nestedPattern = nestedRe

  for (const file of javaFiles) {
    try {
      const content = readFileSync(file, 'utf-8')
      const relPath = file.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      const lines = content.split('\n')

      for (const pattern of [routePattern, nestedPattern]) {
        pattern.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = pattern.exec(content)) !== null) {
          const httpMethod = m[1]
          const path = m[2]
          const handlerClass = m[3]
          const handlerMethod = m[4]
          const lineNum = content.substring(0, m.index).split('\n').length
          routes.push({
            framework: 'spring-webflux',
            method: httpMethod,
            path,
            handlerFile: relPath,
            handlerName: `${handlerClass}.${handlerMethod}()`,
            handlerLine: lineNum,
            sourceLine: lines[lineNum - 1]?.trim() ?? '',
          })
        }
      }
    } catch { /* silent */ }
  }
  return routes
}

/**
 * Persist WebFlux functional endpoints into external_references table.
 */
export function storeWebFluxReferences(projectRoot: string, queries: QueryManager, serviceName: string): number {
  const routes = detectWebFluxRoutes(projectRoot)
  let count = 0
  for (const route of routes) {
    const symbolId = `http.webflux.${route.method}.${route.path.replace(/[^a-zA-Z0-9/_-]/g, '_')}`
    queries.insertExternalSymbol(symbolId, route.handlerName, 'http_endpoint', serviceName, route.handlerFile, `${route.method} ${route.path}`, '{}')
    count++
  }
  return count
}

/**
 * Extract Feign method-level references from the DB (works in both single-project and workspace modes).
 * Call this after all Java files have been indexed so FeignClient nodes are available.
 */
export function storeFeignMethodReferences(queries: QueryManager, serviceName: string): number {
  const feignNodes = queries.getNodesByAnnotation('FeignClient')
  let count = 0
  for (const node of feignNodes) {
    const anns = queries.getAnnotationsByNode(node.id)
    for (const a of anns) {
      if (a.annotationName === 'FeignClient') {
        const nameMatch = a.value.match(/name\s*=\s*["'](\w[\w-]*)["']/)
        const targetService = nameMatch?.[1] || ''
        // Service-level reference
        const svcSymbolId = `feign.${targetService}.${node.name}`
        queries.insertExternalSymbol(svcSymbolId, node.name, 'rpc_service', targetService, node.filePath, `FeignClient → ${targetService}`, '{}')
        queries.insertExternalReference(`${node.filePath}:${node.startLine}:${node.startColumn}`, svcSymbolId, 'rpc_call', targetService, '{}', serviceName)
        count++

        // Method-level references
        const children = queries.getChildren(node.id)
        for (const child of children) {
          const methodAnns = queries.getAnnotationsByNode(child.id)
          for (const ma of methodAnns) {
            if (['RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping'].includes(ma.annotationName)) {
              const httpMethod = ma.annotationName === 'RequestMapping' ? 'ANY' : ma.annotationName.replace('Mapping', '').toUpperCase()
              const path = ma.value.replace(/["']/g, '')
              const symbolId = `feign.${targetService}.${child.name}${path}`
              queries.insertExternalSymbol(symbolId, child.name, 'rpc_method', targetService, child.filePath, `${httpMethod} ${path}`, '{}')
              queries.insertExternalReference(`${child.filePath}:${child.startLine}:${child.startColumn}`, symbolId, 'rpc_call', targetService, '{}', serviceName)
              count++
            }
          }
        }
      }
    }
  }
  return count
}
