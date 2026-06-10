import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../../db/queries.js'
import type { CacheAnnotation, CacheTopology } from '../../types.js'

// ── Types ─────────────────────────────────────────────────────

export interface AspectAdvice {
  aspectClass: string; filePath: string
  adviceType: 'Before' | 'After' | 'Around' | 'AfterReturning' | 'AfterThrowing'
  pointcutExpression: string; methodName: string; line: number; moduleId: string
}

export interface PointcutDef {
  aspectClass: string; pointcutName: string; expression: string; line: number
}

export interface AsyncAnnotation {
  classFile: string; methodName: string; returnType: string
  annotation: 'Async' | 'Scheduled' | 'AsyncScheduled' | 'JobRunr' | 'JobRunrRecurring'
  cronExpression?: string; fixedRate?: number; fixedDelay?: number
  initialDelay?: number; executor?: string; line: number; moduleId: string
  virtualThread?: boolean; jobName?: string
}

export interface ControllerAdvice {
  className: string; filePath: string
  basePackages: string[]; assignableTypes: string[]; annotations: string[]
  exceptionHandlers: { exceptionType: string; methodName: string; returnType: string; responseStatus?: number }[]
  initBinders: { methodName: string; parameterNames: string[] }[]
  modelAttributes: { methodName: string; attributeName: string }[]
  line: number; moduleId: string
}

export interface InterceptorInfo {
  className: string; filePath: string
  type: 'HandlerInterceptor' | 'OncePerRequestFilter' | 'Filter' | 'WebFilter'
  methodName: string; urlPatterns: string[]; order: number; line: number; moduleId: string
}

export interface HttpExchangeInterface {
  interfaceName: string; filePath: string; basePath: string
  methods: { name: string; httpMethod: string; path: string; returnType: string }[]
  line: number; moduleId: string
}

export interface ProfileAnnotation {
  className: string; filePath: string; profiles: string[]; line: number; moduleId: string
}

export interface SecurityFilterRule {
  className: string; filePath: string; methodName: string
  urlPatterns: string[]; permitAll: boolean; authenticated: boolean
  hasAuthority: string[]; hasRole: string[]; hasAnyRole: string[]
  hasAnyAuthority: string[]; accessExpression: string; ignored: boolean
  line: number; moduleId: string
}

// ── AOP ───────────────────────────────────────────────────────

function findAnnotationEnd(lines: string[], start: number): number {
  let j = start; let depth = 0; let found = false
  for (; j < lines.length; j++) {
    const tr = lines[j]
    for (let k = 0; k < tr.length; k++) {
      if (tr[k] === '(') { depth++; found = true }
      else if (tr[k] === ')') depth--
    }
    if (found && depth <= 0 && j >= start) return j
  }
  return j
}

function findMethodLine(lines: string[], afterLine: number): string | undefined {
  for (let k = afterLine; k < lines.length; k++) {
    const tr = lines[k].trim()
    if (!tr || tr.startsWith('@') || tr.startsWith('import') || tr.startsWith('package') || tr === '{' || tr === '}') continue
    if (tr.match(/(?:\w+(?:<[^>]*>)?\s+)+\w+\s*\(/)) return tr
  }
  return undefined
}

export function indexAopAnnotations(
  queries: QueryManager, source: string, filePath: string, moduleId: string
): { advices: AspectAdvice[]; pointcuts: PointcutDef[] } {
  const advices: AspectAdvice[] = []; const pointcuts: PointcutDef[] = []
  const lines = source.split('\n')
  if (!source.includes('@Aspect')) return { advices, pointcuts }
  let currentAspect = filePath.split('/').pop()?.replace('.java', '') || ''
  const adviceTypes = ['Before', 'After', 'Around', 'AfterReturning', 'AfterThrowing'] as const
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('@Pointcut')) {
      let j = findAnnotationEnd(lines, i)
      if (j >= lines.length) continue
      const fullSrc = lines.slice(i, j + 1).join(' ')
      const exprMatch = fullSrc.match(/@Pointcut\s*\(\s*["']([^"']+)["']/)
      if (!exprMatch) continue
      const methodLine = findMethodLine(lines, j + 1) || lines[j]
      const nameMatch = methodLine.match(/(?:public\s+)?void\s+(\w+)\s*\(/)
      if (nameMatch) {
        pointcuts.push({ aspectClass: currentAspect, pointcutName: nameMatch[1], expression: exprMatch[1], line: i + 1 })
        queries.insertAnnotation(`${filePath}:${nameMatch[1]}`, 'Pointcut', exprMatch[1], i + 1, moduleId)
      }
      continue
    }
    for (const at of adviceTypes) {
      if (!line.trim().startsWith(`@${at}`)) continue
      let j = findAnnotationEnd(lines, i)
      if (j >= lines.length) continue
      const fullSrc = lines.slice(i, j + 1).join(' ')
      const valueMatch = fullSrc.match(new RegExp(`@${at}\\s*\\((?:value\\s*=\\s*)?["']([^"']+)["']`))
      const pointcutRef = fullSrc.match(new RegExp(`@${at}\\s*\\(\\s*(\\w+)`))
      const expression = valueMatch?.[1] || pointcutRef?.[1] || ''
      const methodLine = findMethodLine(lines, j)
      const methodMatch = methodLine?.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
      const methodName = methodMatch?.[2] || `advice_${at}_${i + 1}`
      const advice: AspectAdvice = { aspectClass: currentAspect, filePath, adviceType: at, pointcutExpression: expression, methodName, line: i + 1, moduleId }
      advices.push(advice)
      const nodeId = `${filePath}:${methodName}`
      const parentNodes = queries.searchNodes(currentAspect, 3).filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const pn of parentNodes) {
        queries.insertAnnotation(nodeId, `Aspect_${at}`, JSON.stringify({ pointcut: expression, method: methodName }), i + 1, moduleId)
        queries.insertEdge(pn.id, nodeId, `aspect_${at.toLowerCase()}`, JSON.stringify({ pointcut: expression }), i + 1, 0)
      }
    }
  }
  for (const pc of pointcuts) {
    for (const ad of advices) {
      if (ad.pointcutExpression === pc.pointcutName) ad.pointcutExpression = pc.expression
    }
  }
  return { advices, pointcuts }
}

export function resolvePointcutMatches(queries: QueryManager, advices: AspectAdvice[], moduleId: string): { advice: AspectAdvice; matchedNodes: string[] }[] {
  const results: { advice: AspectAdvice; matchedNodes: string[] }[] = []
  const allNodes = queries.getAllNodes().filter(n => n.moduleId === moduleId)
  for (const ad of advices) {
    const expr = ad.pointcutExpression; const matched: string[] = []
    const executionMatch = expr.match(/execution\(\s*\*?\s*(\w+(?:\.\w+)*)\.(\w+)\s*\(/)
    if (executionMatch) {
      const targetClassPattern = executionMatch[1].replace(/\*/g, '.*')
      const targetMethodPattern = executionMatch[2].replace(/\*/g, '.*')
      for (const node of allNodes) {
        if (node.kind === 'method') {
          const parent = node.parentId ? queries.getNode(node.parentId) : null
          const parentQName = parent?.qualifiedName || ''
          const classMatch = targetClassPattern === '.*' || parentQName.match(new RegExp(targetClassPattern))
          const methodMatch = node.name.match(new RegExp(targetMethodPattern))
          if (classMatch && methodMatch) {
            matched.push(node.id)
            queries.insertEdge(ad.filePath, node.id, 'aspect_weave', JSON.stringify({ adviceType: ad.adviceType, pointcut: expr }), ad.line, 0)
          }
        }
      }
    }
    const annotationMatch = expr.match(/@annotation\(\s*(\w+)\s*\)/)
    if (annotationMatch) {
      const annName = annotationMatch[1]
      const annNodes = queries.getNodesByAnnotation(annName)
      for (const an of annNodes) {
        if (an.moduleId === moduleId) {
          matched.push(an.id)
          queries.insertEdge(ad.filePath, an.id, 'aspect_weave', JSON.stringify({ adviceType: ad.adviceType, pointcut: expr }), ad.line, 0)
        }
      }
    }
    const withinMatch = expr.match(/within\(\s*(\w+(?:\.\w+)*)\s*\)/)
    if (withinMatch) {
      const pattern = withinMatch[1].replace(/\*/g, '.*')
      for (const node of allNodes) {
        if (node.kind === 'class' && node.qualifiedName.match(new RegExp(pattern))) {
          matched.push(node.id)
          queries.insertEdge(ad.filePath, node.id, 'aspect_weave', JSON.stringify({ adviceType: ad.adviceType, pointcut: expr }), ad.line, 0)
        }
      }
    }
    if (matched.length > 0) results.push({ advice: ad, matchedNodes: matched })
  }
  return results
}

// ── Async ─────────────────────────────────────────────────────

function detectVirtualThreadsEnabled(source: string): boolean {
  return source.includes('@EnableVirtualThreads') || source.includes('VirtualThreadTaskExecutor') || source.includes('spring.threads.virtual.enabled=true')
}

export function indexAsyncAnnotations(queries: QueryManager, source: string, filePath: string, moduleId: string): AsyncAnnotation[] {
  const results: AsyncAnnotation[] = []; const lines = source.split('\n'); const vtContext = detectVirtualThreadsEnabled(source)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    let annotation: AsyncAnnotation['annotation'] | null = null
    if (line.startsWith('@Async')) annotation = 'Async'
    else if (line.startsWith('@Scheduled')) annotation = 'Scheduled'
    else if (line.startsWith('@Job(') || line.startsWith('@Job ') || line === '@Job') annotation = 'JobRunr'
    else if (line.startsWith('@Recurring(') || line.startsWith('@Recurring ') || line === '@Recurring') annotation = 'JobRunrRecurring'
    else if (line.startsWith('@EnableVirtualThreads')) {
      queries.insertAnnotation(`${filePath}:EnableVirtualThreads`, 'EnableVirtualThreads', '{}', i + 1, moduleId)
      continue
    }
    if (!annotation) continue
    let j = i + 1
    while (j < lines.length && !lines[j].trim().endsWith(')') && !lines[j].trim().includes('{')) j++
    const methodLine = j < lines.length && lines[j].trim().includes('(') ? lines[j] : lines[i]
    const fullAnnSrc = lines.slice(i, j + 1).join(' ')
    const methodMatch = methodLine.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
    if (!methodMatch) continue
    const returnType = methodMatch[1]; const methodName = methodMatch[2]
    let cronExpr: string | undefined; let fixedRate: number | undefined; let fixedDelay: number | undefined
    let initialDelay: number | undefined; let executor: string | undefined; let jobName: string | undefined
    if (annotation === 'Scheduled' || annotation === 'JobRunrRecurring') {
      const cronM = fullAnnSrc.match(/cron\s*=\s*["']([^"']+)["']/)
      if (cronM) cronExpr = cronM[1]
      const rateM = fullAnnSrc.match(/fixedRate\s*=\s*(\d+)/)
      if (rateM) fixedRate = parseInt(rateM[1], 10)
      const delayM = fullAnnSrc.match(/fixedDelay\s*=\s*(\d+)/)
      if (delayM) fixedDelay = parseInt(delayM[1], 10)
      const initM = fullAnnSrc.match(/initialDelay\s*=\s*(\d+)/)
      if (initM) initialDelay = parseInt(initM[1], 10)
    } else if (annotation === 'JobRunr') {
      const nameM = fullAnnSrc.match(/(?:name|id)\s*=\s*["']([^"']+)["']/)
      if (nameM) jobName = nameM[1]
    } else {
      const execM = fullAnnSrc.match(/@Async\s*\(\s*["']([^"']+)["']/)
      if (execM) executor = execM[1]
    }
    const ann: AsyncAnnotation = { classFile: filePath, methodName, returnType, annotation, cronExpression: cronExpr, fixedRate, fixedDelay, initialDelay, executor, line: i + 1, moduleId, virtualThread: vtContext, jobName }
    results.push(ann)
    const nodeId = `${filePath}:${methodName}`
    const parentNodes = queries.searchNodes(filePath.split('/').pop()?.replace('.java', '') || '', 3).filter(n => n.moduleId === moduleId && n.filePath === filePath)
    for (const pn of parentNodes) {
      const meta: Record<string, any> = { cron: cronExpr, fixedRate, fixedDelay, executor }
      if (vtContext) meta.virtualThread = true
      if (ann.jobName) meta.jobName = ann.jobName
      queries.insertAnnotation(nodeId, annotation, JSON.stringify(meta), i + 1, moduleId)
      let edgeKind = 'async_method'
      if (annotation === 'Scheduled') edgeKind = 'scheduled_method'
      else if (annotation === 'JobRunr') edgeKind = 'jobrunr_method'
      else if (annotation === 'JobRunrRecurring') edgeKind = 'jobrunr_recurring'
      queries.insertEdge(pn.id, nodeId, edgeKind, JSON.stringify(meta), i + 1, 0)
    }
  }
  return results
}

// ── Controller Advice ─────────────────────────────────────────

export function indexControllerAdvice(queries: QueryManager, source: string, filePath: string, moduleId: string): ControllerAdvice[] {
  const results: ControllerAdvice[] = []; const lines = source.split('\n')
  let currentAdvice: { className: string; basePackages: string[]; assignableTypes: string[]; annotations: string[]; exceptionHandlers: ControllerAdvice['exceptionHandlers']; initBinders: ControllerAdvice['initBinders']; modelAttributes: ControllerAdvice['modelAttributes'] } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('@ControllerAdvice') || line.startsWith('@RestControllerAdvice')) {
      const basePackages: string[] = []; const assignableTypes: string[] = []; const annotations: string[] = []
      const bpMatch = line.match(/basePackages\s*=\s*\{([^}]+)\}/)
      if (bpMatch) basePackages.push(...bpMatch[1].split(',').map(s => s.trim().replace(/["']/g, '')))
      const bpSingle = line.match(/basePackages\s*=\s*["']([^"']+)["']/)
      if (bpSingle) basePackages.push(bpSingle[1])
      const atMatch = line.match(/assignableTypes\s*=\s*\{([^}]+)\}/)
      if (atMatch) assignableTypes.push(...atMatch[1].split(',').map(s => s.trim().replace(/["']/g, '')))
      const annMatch = line.match(/annotations\s*=\s*\{([^}]+)\}/)
      if (annMatch) annotations.push(...annMatch[1].split(',').map(s => s.trim().replace(/["']/g, '')))
      currentAdvice = { className: '', basePackages, assignableTypes, annotations, exceptionHandlers: [], initBinders: [], modelAttributes: [] }
      continue
    }
    if (!currentAdvice) continue
    const classMatch = line.match(/(?:public\s+)?class\s+(\w+)/)
    if (classMatch) currentAdvice.className = classMatch[1]
    if (line.startsWith('@ExceptionHandler')) {
      const excMatch = line.match(/@ExceptionHandler\s*\(\s*\{?\s*([^)}]+)\s*\}?\s*\)/)
      const exceptionTypes: string[] = []
      if (excMatch) { for (const et of excMatch[1].split(',')) exceptionTypes.push(et.trim().replace(/\.class/g, '')) }
      else { exceptionTypes.push('Exception') }
      let j = i + 1
      while (j < lines.length && !lines[j].trim().includes('(') && !lines[j].trim().startsWith('public')) j++
      const methodLine = (lines[j] || lines[i] || '').trim()
      const methodMatch = methodLine.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
      if (methodMatch) {
        const returnType = methodMatch[1]; const methodName = methodMatch[2]
        let responseStatus: number | undefined
        const isProblemDetail = returnType.includes('ProblemDetail') || returnType.includes('ErrorResponse') || source.includes('spring.mvc.problemdetails.enabled=true') || source.includes('spring.webflux.problemdetails.enabled=true')
        for (let k = i - 3; k <= i + 3; k++) {
          if (k >= 0 && k < lines.length && lines[k].includes('@ResponseStatus')) {
            const rsMatch = lines[k].match(/@ResponseStatus\s*\(\s*(?:value\s*=\s*)?(?:HttpStatus\.)?(\w+)\s*\)/)
            if (rsMatch) { const statusMap: Record<string, number> = { OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, INTERNAL_SERVER_ERROR: 500, SERVICE_UNAVAILABLE: 503 }; responseStatus = statusMap[rsMatch[1]] || 500 }
          }
        }
        for (const et of exceptionTypes) {
          currentAdvice.exceptionHandlers.push({ exceptionType: et, methodName, returnType, responseStatus })
          const caNodes = queries.searchNodes(currentAdvice.className, 10).filter(n => n.moduleId === moduleId && n.filePath === filePath && n.kind === 'class')
          for (const cn of caNodes) {
            const meta: Record<string, any> = { exceptionType: et, methodName, responseStatus }
            if (isProblemDetail) meta.problemDetail = true
            queries.insertAnnotation(cn.id, 'ExceptionHandler', JSON.stringify(meta), i + 1, moduleId)
            const excNodes = queries.searchNodes(et, 5).filter(n => n.moduleId === moduleId && n.kind === 'class')
            for (const en of excNodes) queries.insertEdge(cn.id, en.id, 'exception_handler', JSON.stringify(meta), i + 1, 0)
          }
        }
      }
    }
    if (line.startsWith('@InitBinder')) {
      const attrMatch = line.match(/@InitBinder\s*\(\s*["']([^"']+)["']/)
      const binderName = attrMatch?.[1] || ''
      let j = i + 1
      while (j < lines.length && !lines[j].trim().includes('(')) j++
      const methodLine = lines[j] || ''
      const methodMatch = methodLine.match(/void\s+(\w+)\s*\(/)
      if (methodMatch) currentAdvice.initBinders.push({ methodName: methodMatch[1], parameterNames: binderName ? [binderName] : [] })
    }
    if (line.startsWith('@ModelAttribute')) {
      const nameMatch = line.match(/@ModelAttribute\s*\(\s*["']([^"']+)["']/)
      const attrName = nameMatch?.[1] || ''
      let j = i + 1
      while (j < lines.length && !lines[j].trim().includes('(')) j++
      const methodLine = lines[j] || ''
      const methodMatch = methodLine.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
      if (methodMatch) currentAdvice.modelAttributes.push({ methodName: methodMatch[2], attributeName: attrName })
    }
    if (line.trim() === '}' && currentAdvice.className) {
      const ca: ControllerAdvice = { className: currentAdvice.className, filePath, basePackages: [...currentAdvice.basePackages], assignableTypes: [...currentAdvice.assignableTypes], annotations: [...currentAdvice.annotations], exceptionHandlers: [...currentAdvice.exceptionHandlers], initBinders: [...currentAdvice.initBinders], modelAttributes: [...currentAdvice.modelAttributes], line: i + 1, moduleId }
      results.push(ca)
      const caNodes = queries.searchNodes(ca.className, 10).filter(n => n.moduleId === moduleId && n.filePath === filePath && n.kind === 'class')
      for (const cn of caNodes) queries.insertAnnotation(cn.id, 'ControllerAdvice', JSON.stringify({ basePackages: ca.basePackages, assignableTypes: ca.assignableTypes, annotations: ca.annotations }), i + 1, moduleId)
      currentAdvice = null
    }
  }
  return results
}

// ── Interceptor ───────────────────────────────────────────────

export function indexInterceptors(queries: QueryManager, source: string, filePath: string, moduleId: string): InterceptorInfo[] {
  const results: InterceptorInfo[] = []; const lines = source.split('\n')
  let className = filePath.split('/').pop()?.replace('.java', '') || ''
  let type: InterceptorInfo['type'] | null = null
  if (source.includes('implements HandlerInterceptor')) type = 'HandlerInterceptor'
  else if (source.includes('extends OncePerRequestFilter')) type = 'OncePerRequestFilter'
  else if (source.includes('implements Filter') && !source.includes('HandlerInterceptor')) type = 'Filter'
  else if (source.includes('implements WebFilter')) type = 'WebFilter'
  if (!type && !source.includes('WebMvcConfigurer') && !source.includes('addInterceptors')) return results
  if (type) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const classMatch = line.match(/(?:public\s+)?class\s+(\w+)/)
      if (classMatch) className = classMatch[1]
      const methodOverrides = ['preHandle', 'postHandle', 'afterCompletion', 'doFilterInternal', 'doFilter', 'filter']
      for (const mo of methodOverrides) {
        if (line.trim().startsWith('public') && line.includes(mo) && line.includes('(')) {
          results.push({ className, filePath, type, methodName: mo, urlPatterns: ['/*'], order: 0, line: i + 1, moduleId })
          queries.insertAnnotation(`${filePath}:${className}:${mo}`, 'Interceptor', JSON.stringify({ type, urlPatterns: ['/*'] }), i + 1, moduleId)
        }
      }
    }
  }
  if (source.includes('WebMvcConfigurer') || source.includes('addInterceptors')) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.includes('addInterceptors') || line.includes('addPathPatterns')) {
        const patterns: string[] = []
        let j = i
        while (j < lines.length && !lines[j].trim().includes(';')) {
          const pm = lines[j].match(/["']([^"']+)["']/g)
          if (pm) patterns.push(...pm.map(p => p.replace(/["']/g, '')))
          j++
        }
        const excludeMatch = source.match(/excludePathPatterns\s*\(([^)]*)\)/)
        let interceptorRef = ''
        for (let k = Math.max(0, i - 5); k < i; k++) {
          const regMatch = lines[k].match(/\.addInterceptor\s*\(\s*(\w+)\s*\)/)
          if (regMatch) interceptorRef = regMatch[1]
        }
        if (interceptorRef) queries.insertAnnotation(`${filePath}:WebMvcConfigurer`, 'InterceptorRegistration', JSON.stringify({ interceptorRef, urlPatterns: patterns, excludePatterns: excludeMatch?.[1] || '' }), i + 1, moduleId)
      }
    }
  }
  return results
}

// ── HTTP Exchange ─────────────────────────────────────────────

const EXCHANGE_ANNOTATIONS = ['HttpExchange', 'GetExchange', 'PostExchange', 'PutExchange', 'DeleteExchange', 'PatchExchange']

export function extractHttpExchanges(source: string, filePath: string): HttpExchangeInterface[] {
  const results: HttpExchangeInterface[] = []; const lines = source.split('\n')
  let currentInterface: { interfaceName: string; basePath: string; methods: HttpExchangeInterface['methods'] } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('@HttpExchange')) {
      const pathMatch = line.match(/(?:value|path)\s*=\s*["']([^"']+)["']/)
      const basePath = pathMatch ? pathMatch[1] : '/'
      for (let j = i; j < Math.min(i + 5, lines.length); j++) {
        const ifaceMatch = lines[j].match(/(?:public\s+)?interface\s+(\w+)/)
        if (ifaceMatch) { currentInterface = { interfaceName: ifaceMatch[1], basePath, methods: [] }; break }
      }
      continue
    }
    if (!currentInterface) continue
    for (const ann of EXCHANGE_ANNOTATIONS) {
      if (ann === 'HttpExchange') continue
      if (line.startsWith(`@${ann}`)) {
        const pathMatch = line.match(/(?:value|path)\s*=\s*["']([^"']+)["']/)
        const path = pathMatch ? pathMatch[1] : '/'
        const httpMethod = ann.replace('Exchange', '').toUpperCase()
        let j = i + 1
        while (j < lines.length && !lines[j].trim().includes('(') && !lines[j].trim().startsWith('}')) j++
        const methodLine = lines[j] || lines[i]
        const methodMatch = methodLine.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
        if (methodMatch) currentInterface.methods.push({ name: methodMatch[2], httpMethod, path, returnType: methodMatch[1] })
        break
      }
    }
    if (line.trim() === '}' && currentInterface.interfaceName) {
      results.push({ interfaceName: currentInterface.interfaceName, filePath, basePath: currentInterface.basePath, methods: currentInterface.methods, line: i + 1, moduleId: '' })
      currentInterface = null
    }
  }
  return results
}

export function indexHttpExchanges(queries: QueryManager, source: string, filePath: string, moduleId: string): HttpExchangeInterface[] {
  const ifaces = extractHttpExchanges(source, filePath)
  for (const iface of ifaces) {
    iface.moduleId = moduleId
    const nodeId = `httpexchange:${filePath}:${iface.interfaceName}`
    queries.insertNode({ id: nodeId, kind: 'interface', name: iface.interfaceName, qualifiedName: `${moduleId}.${iface.interfaceName}`, filePath, language: 'java', startLine: iface.line, endLine: iface.line, startColumn: 0, endColumn: 0, docstring: '', signature: `@HttpExchange ${iface.basePath}`, visibility: 'public', isExported: true, parentId: null, moduleId })
    for (const m of iface.methods) {
      const methodNodeId = `${nodeId}:${m.name}`
      queries.insertNode({ id: methodNodeId, kind: 'method', name: m.name, qualifiedName: `${iface.interfaceName}.${m.name}`, filePath, language: 'java', startLine: iface.line, endLine: iface.line, startColumn: 0, endColumn: 0, docstring: '', signature: `@${m.httpMethod}Exchange ${m.path}`, visibility: 'public', isExported: true, parentId: nodeId, moduleId })
      queries.insertEdge(nodeId, methodNodeId, 'contains', '{}', iface.line, 0)
    }
  }
  return ifaces
}

// ── Security ──────────────────────────────────────────────────

const SECURITY_ANNOTATIONS = new Set(['PreAuthorize', 'PostAuthorize', 'PreFilter', 'PostFilter', 'Secured', 'RolesAllowed', 'PermitAll', 'DenyAll', 'EnableGlobalMethodSecurity', 'EnableMethodSecurity', 'EnableWebSecurity', 'EnableWebFluxSecurity', 'EnableOAuth2Sso', 'EnableOAuth2Client', 'RegisteredOAuth2AuthorizedClient'])

export function extractSecurityAnnotations(source: string, filePath: string, _moduleId: string): { nodeId: string; annotationName: string; value: string; line: number }[] {
  const results: { nodeId: string; annotationName: string; value: string; line: number }[] = []
  for (const annName of SECURITY_ANNOTATIONS) {
    const pattern = new RegExp(`@${annName}\\s*\\(([^)]*)\\)`, 'g')
    let m: RegExpExecArray | null
    while ((m = pattern.exec(source)) !== null) {
      const value = m[1]?.trim() ?? ''; const line = source.substring(0, m.index).split('\n').length
      for (let j = line - 1; j < Math.min(line + 2, source.split('\n').length); j++) {
        const dl = source.split('\n')[j]?.trim() ?? ''
        const idMatch = dl.match(/(?:public\s+)?(?:\w+\s+)?(\w+)\s*\(/)
        if (idMatch && !idMatch[1].startsWith('@')) { results.push({ nodeId: `${filePath}:${idMatch[1]}:${j + 1}`, annotationName: annName, value, line }); break }
      }
    }
  }
  return results
}

export function indexSecurity(queries: QueryManager, source: string, filePath: string, moduleId: string): void {
  const annotations = extractSecurityAnnotations(source, filePath, moduleId)
  for (const a of annotations) {
    const candidates = queries.searchNodes(a.nodeId, 5)
    for (const c of candidates) {
      queries.insertEdge(c.id, `${filePath}:sec:${a.annotationName}`, 'secured_by', JSON.stringify({ annotation: a.annotationName, value: a.value }), a.line, 0)
      queries.insertAnnotation(c.id, a.annotationName, a.value, a.line, moduleId)
    }
  }
}

// ── Security Filter Chain ─────────────────────────────────────

const AUTH_METHODS = ['permitAll', 'authenticated', 'denyAll', 'anonymous', 'rememberMe', 'fullyAuthenticated', 'hasAuthority', 'hasRole', 'hasAnyAuthority', 'hasAnyRole', 'hasIpAddress', 'access']

export function indexSecurityFilterChains(queries: QueryManager, source: string, filePath: string, moduleId: string): SecurityFilterRule[] {
  const rules: SecurityFilterRule[] = []
  if (!source.includes('SecurityFilterChain') && !source.includes('HttpSecurity') && !source.includes('WebSecurity')) return rules
  const lines = source.split('\n'); let currentMethod = ''; let className = filePath.split('/').pop()?.replace('.java', '') || ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const beanMatch = line.match(/(?:public\s+)?SecurityFilterChain\s+(\w+)\s*\(/)
    if (beanMatch) { currentMethod = beanMatch[1]; continue }
    if (!currentMethod) continue
    for (const am of AUTH_METHODS) {
      const authMatch = line.match(new RegExp(`\\.${am}\\s*\\(`))
      if (!authMatch) continue
      const argsMatch = line.match(new RegExp(`\\.${am}\\s*\\(\\s*["']([^"']+)["']`))
      const args = argsMatch?.[1] ? argsMatch[1].split(',').map(a => a.trim().replace(/["']/g, '')) : []
      const urlPatterns: string[] = []
      for (let j = Math.max(0, i - 5); j < i; j++) {
        const urlMatch = lines[j].match(/\.(?:antMatcher|requestMatcher|mvcMatcher)\s*\(\s*["']([^"']+)["']/)
        if (urlMatch) urlPatterns.push(urlMatch[1])
        const reMatch = lines[j].match(/\.requestMatchers\s*\(\s*["']([^"']+)["']/)
        if (reMatch) urlPatterns.push(reMatch[1])
      }
      if (urlPatterns.length === 0) urlPatterns.push('/**')
      const rule: SecurityFilterRule = { className, filePath, methodName: currentMethod, urlPatterns, permitAll: am === 'permitAll', authenticated: am === 'authenticated', hasAuthority: am === 'hasAuthority' ? args : [], hasRole: am === 'hasRole' ? args : [], hasAnyRole: am === 'hasAnyRole' ? args : [], hasAnyAuthority: am === 'hasAnyAuthority' ? args : [], accessExpression: am === 'access' ? (argsMatch?.[1] || '') : '', ignored: line.includes('ignoring') || line.includes('WebSecurityCustomizer'), line: i + 1, moduleId }
      rules.push(rule)
      const nodeId = `${filePath}:security_filter:${i}`
      const parentNodes = queries.searchNodes(className, 3).filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const pn of parentNodes) {
        const annValue = JSON.stringify({ urlPatterns, method: am, roles: args, expression: argsMatch?.[1] })
        queries.insertAnnotation(nodeId, `SecurityFilter_${am}`, annValue, i + 1, moduleId)
        queries.insertEdge(pn.id, nodeId, 'security_filter_rule', annValue, i + 1, 0)
      }
      break
    }
    if (line.trim().includes('}') && currentMethod) currentMethod = ''
  }
  return rules
}

export function indexWebSecurityCustomizer(_queries: QueryManager, source: string, _filePath: string, _moduleId: string): string[] {
  const ignored: string[] = []; const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes('ignoring') && line.includes('antMatchers')) {
      const match = line.match(/antMatchers\s*\(\s*["']([^"']+)["']/)
      if (match) ignored.push(match[1])
    }
    if (line.includes('ignoring') && line.includes('requestMatchers')) {
      const match = line.match(/requestMatchers\s*\(\s*["']([^"']+)["']/)
      if (match) ignored.push(match[1])
    }
  }
  return ignored
}

// ── Resilience ────────────────────────────────────────────────

const RESILIENCE_ANNOTATIONS = new Set(['CircuitBreaker', 'Retry', 'Bulkhead', 'RateLimiter', 'TimeLimiter', 'Fallback', 'HystrixCommand', 'HystrixCollapser'])

export function extractResilienceAnnotations(source: string, _filePath: string): { annotationName: string; value: string; line: number; methodName: string }[] {
  const results: { annotationName: string; value: string; line: number; methodName: string }[] = []
  for (const ann of RESILIENCE_ANNOTATIONS) {
    const pattern = new RegExp(`@${ann}\\s*\\(([^)]*)\\)`, 'g')
    let m: RegExpExecArray | null
    while ((m = pattern.exec(source)) !== null) {
      const value = m[1]?.trim() ?? ''; const line = source.substring(0, m.index).split('\n').length
      let methodName = 'unknown'; const lines = source.split('\n')
      for (let j = line - 1; j < Math.min(line + 3, lines.length); j++) {
        const dl = lines[j]?.trim() ?? ''
        const idMatch = dl.match(/(?:public\s+)?(?:\w+\s+)?(\w+)\s*\(/)
        if (idMatch) { methodName = idMatch[1]; break }
      }
      results.push({ annotationName: ann, value, line, methodName })
    }
  }
  return results
}

export function indexResilience(queries: QueryManager, source: string, filePath: string, _moduleId: string): void {
  const annotations = extractResilienceAnnotations(source, filePath)
  for (const a of annotations) {
    const candidates = queries.searchNodes(a.methodName, 10).filter(n => n.filePath === filePath)
    for (const c of candidates) {
      queries.insertEdge(c.id, `resilience:${a.annotationName}:${c.id}`, 'resilience_policy', JSON.stringify({ annotation: a.annotationName, value: a.value, fallbackMethod: a.value.match(/fallbackMethod\s*=\s*"(\w+)"/)?.[1] ?? '' }), a.line, 0)
    }
  }
}

// ── Cache ─────────────────────────────────────────────────────

const CACHE_ANNOTATIONS_LIST: string[] = ['Cacheable', 'CacheEvict', 'CachePut', 'Caching']

export function parseCacheAnnotationValue(annotationName: string, value: string): Partial<CacheAnnotation> {
  const info: Partial<CacheAnnotation> = { type: annotationName as CacheAnnotation['type'], cacheNames: [], key: '', condition: '', unless: '', keyGenerator: '', cacheManager: '' }
  if (!value || value === '') return info
  const cleanValue = value.replace(/^@\w+\(|\)$/g, '')
  const parts = splitCacheArgs(cleanValue)
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed.match(/^(value|cacheNames)\s*=\s*/)) {
      const match = trimmed.match(/(?:value|cacheNames)\s*=\s*\{?([^}]+)\}?/)
      if (match) info.cacheNames = match[1].split(',').map(s => s.trim().replace(/"/g, '').replace(/'/g, '')).filter(Boolean)
    } else if (trimmed.startsWith('key')) { const match = trimmed.match(/key\s*=\s*["']?([^"',)]+)["']?/); if (match) info.key = match[1].trim() }
    else if (trimmed.startsWith('condition')) { const match = trimmed.match(/condition\s*=\s*["']?([^"',)]+)["']?/); if (match) info.condition = match[1].trim() }
    else if (trimmed.startsWith('unless')) { const match = trimmed.match(/unless\s*=\s*["']?([^"',)]+)["']?/); if (match) info.unless = match[1].trim() }
    else if (trimmed.startsWith('keyGenerator')) { const match = trimmed.match(/keyGenerator\s*=\s*["']?(\w+)["']?/); if (match) info.keyGenerator = match[1] }
    else if (trimmed.startsWith('cacheManager')) { const match = trimmed.match(/cacheManager\s*=\s*["']?(\w+)["']?/); if (match) info.cacheManager = match[1] }
  }
  if (info.cacheNames!.length === 0 && !value.includes('cacheNames') && !value.includes('value')) {
    const firstArg = cleanValue.split(',')[0].trim().replace(/"/g, '').replace(/'/g, '')
    if (firstArg && !firstArg.includes('=')) info.cacheNames = [firstArg]
  }
  return info
}

function splitCacheArgs(input: string): string[] {
  const args: string[] = []; let depth = 0; let current = ''; let inString = false; let stringChar = ''
  for (const ch of input) {
    if (inString) { current += ch; if (ch === stringChar) inString = false }
    else if (ch === '"' || ch === "'") { current += ch; inString = true; stringChar = ch }
    else if (ch === '(' || ch === '{') { depth++; current += ch }
    else if (ch === ')' || ch === '}') { depth--; current += ch }
    else if (ch === ',' && depth === 0) { args.push(current.trim()); current = '' }
    else current += ch
  }
  if (current.trim()) args.push(current.trim())
  return args
}

export function extractRedisConfig(projectRoot: string): { host: string; port: number; database: number; cluster: boolean } | undefined {
  const candidates = [join(projectRoot, 'src', 'main', 'resources', 'application.yml'), join(projectRoot, 'src', 'main', 'resources', 'application.yaml'), join(projectRoot, 'src', 'main', 'resources', 'application.properties')]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const content = readFileSync(file, 'utf-8')
      if (file.endsWith('.properties')) {
        const lines = content.split('\n'); let host = 'localhost'; let port = 6379; let database = 0; let cluster = false
        for (const line of lines) {
          const [k, v] = line.split('=').map(s => s.trim())
          if (k === 'spring.redis.host') host = v
          else if (k === 'spring.redis.port') port = parseInt(v)
          else if (k === 'spring.redis.database') database = parseInt(v)
          else if (k === 'spring.redis.cluster.nodes') cluster = true
        }
        return { host, port, database, cluster }
      }
      const hostMatch = content.match(/spring:\s*\n\s+redis:\s*\n(?:\s+.*\n)*/)
      if (hostMatch) {
        const block = hostMatch[0]
        const host = block.match(/host:\s*(\S+)/)?.[1] ?? 'localhost'
        const port = parseInt(block.match(/port:\s*(\d+)/)?.[1] ?? '6379')
        const database = parseInt(block.match(/database:\s*(\d+)/)?.[1] ?? '0')
        const cluster = block.includes('cluster:') || block.includes('sentinel:')
        return { host, port, database, cluster }
      }
    } catch { /* silent */ }
  }
  return undefined
}

export function indexCacheAnnotations(queries: QueryManager, projectRoot: string, moduleId: string): { annotations: CacheAnnotation[]; topologies: CacheTopology[] } {
  const annotations: CacheAnnotation[] = []; const allNodes = queries.getAllNodes(); const nodeAnnCache = queries.getAllAnnotations()
  for (const node of allNodes) {
    const anns = nodeAnnCache.get(node.id) ?? []
    for (const ann of anns) {
      if (CACHE_ANNOTATIONS_LIST.includes(ann.annotationName)) {
        const parsed = parseCacheAnnotationValue(ann.annotationName, ann.value)
        const cacheAnnotation: CacheAnnotation = { type: ann.annotationName as CacheAnnotation['type'], cacheNames: parsed.cacheNames ?? [], key: parsed.key ?? '', condition: parsed.condition ?? '', unless: parsed.unless ?? '', keyGenerator: parsed.keyGenerator ?? '', cacheManager: parsed.cacheManager ?? '', nodeId: node.id, methodName: node.name, className: node.parentId ? queries.getNode(node.parentId)?.name ?? '' : '', filePath: node.filePath, line: node.startLine, moduleId }
        annotations.push(cacheAnnotation)
        queries.insertEdge(node.id, `cache:${moduleId}:${cacheAnnotation.cacheNames.join(',')}:${node.name}`, 'cache_annotation', JSON.stringify(cacheAnnotation), node.startLine, 0)
      }
    }
  }
  const nodeAnnotationsCache = new Map<string, string[]>()
  for (const node of allNodes) {
    const anns = nodeAnnCache.get(node.id) ?? []
    const cacheAnns = anns.filter(a => CACHE_ANNOTATIONS_LIST.includes(a.annotationName)).map(a => a.value)
    if (cacheAnns.length > 0) nodeAnnotationsCache.set(node.id, cacheAnns)
  }
  for (const ann of annotations) {
    for (const cacheName of ann.cacheNames) {
      for (const [otherNodeId, otherAnns] of nodeAnnotationsCache) {
        if (otherNodeId === ann.nodeId) continue
        if (otherAnns.some(v => v.includes(cacheName))) queries.insertEdge(ann.nodeId, otherNodeId, 'cache_related', JSON.stringify({ cacheName }), 0, 0)
      }
    }
  }
  const redisConfig = extractRedisConfig(projectRoot)
  const cacheNameMap = new Map<string, CacheAnnotation[]>()
  for (const ann of annotations) {
    for (const name of ann.cacheNames) {
      if (!cacheNameMap.has(name)) cacheNameMap.set(name, [])
      cacheNameMap.get(name)!.push(ann)
    }
  }
  const topologies: CacheTopology[] = []
  for (const [cacheName, entries] of cacheNameMap) {
    const services = new Set<string>()
    for (const e of entries) { if (e.moduleId) services.add(e.moduleId) }
    topologies.push({ cacheName, entries, redisConfig, relatedServices: Array.from(services) })
  }
  return { annotations, topologies }
}

// ── Profile ───────────────────────────────────────────────────

export function indexProfileAnnotations(queries: QueryManager, source: string, filePath: string, moduleId: string): ProfileAnnotation[] {
  const results: ProfileAnnotation[] = []; const lines = source.split('\n')
  let currentProfiles: string[] | null = null; let currentLine = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('@Profile')) {
      const profiles: string[] = []
      const bracketMatch = line.match(/@Profile\s*\(\s*\{([^}]+)\}/)
      if (bracketMatch) profiles.push(...bracketMatch[1].split(',').map(s => s.trim().replace(/["']/g, '')))
      else { const singleMatch = line.match(/@Profile\s*\(\s*["']([^"']+)["']/); if (singleMatch) profiles.push(singleMatch[1]) }
      if (profiles.length > 0) { currentProfiles = profiles; currentLine = i + 1 }
      continue
    }
    if (!currentProfiles) continue
    let targetName = ''
    const classMatch = line.match(/(?:public\s+)?class\s+(\w+)/)
    if (classMatch) targetName = classMatch[1]
    const configMatch = line.match(/(?:public\s+)?@Configuration\s+(?:class\s+)?(\w+)/)
    if (configMatch) targetName = configMatch[1]
    if (targetName) {
      const pa: ProfileAnnotation = { className: targetName, filePath, profiles: [...currentProfiles], line: currentLine, moduleId }
      results.push(pa)
      const targetNodes = queries.searchNodes(targetName, 10).filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const tn of targetNodes) {
        queries.insertAnnotation(tn.id, 'Profile', JSON.stringify(currentProfiles), currentLine, moduleId)
        queries.insertEdge(tn.id, `profile:${currentProfiles.join(',')}`, 'profile_activated', JSON.stringify({ profiles: currentProfiles }), currentLine, 0)
      }
      currentProfiles = null
    }
  }
  return results
}
