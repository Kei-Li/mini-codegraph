import type { QueryManager } from '../../db/queries.js'

export interface ControllerAdvice {
  className: string
  filePath: string
  basePackages: string[]
  assignableTypes: string[]
  annotations: string[]
  exceptionHandlers: { exceptionType: string; methodName: string; returnType: string; responseStatus?: number }[]
  initBinders: { methodName: string; parameterNames: string[] }[]
  modelAttributes: { methodName: string; attributeName: string }[]
  line: number
  moduleId: string
}

export function indexControllerAdvice(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): ControllerAdvice[] {
  const results: ControllerAdvice[] = []
  const lines = source.split('\n')

  let currentAdvice: {
    className: string; basePackages: string[]; assignableTypes: string[]; annotations: string[]
    exceptionHandlers: ControllerAdvice['exceptionHandlers']
    initBinders: ControllerAdvice['initBinders']
    modelAttributes: ControllerAdvice['modelAttributes']
  } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    if (line.startsWith('@ControllerAdvice') || line.startsWith('@RestControllerAdvice')) {
      const fullAnn = line
      const basePackages: string[] = []
      const assignableTypes: string[] = []
      const annotations: string[] = []

      const bpMatch = fullAnn.match(/basePackages\s*=\s*\{([^}]+)\}/)
      if (bpMatch) basePackages.push(...bpMatch[1].split(',').map(s => s.trim().replace(/["']/g, '')))
      const bpSingle = fullAnn.match(/basePackages\s*=\s*["']([^"']+)["']/)
      if (bpSingle) basePackages.push(bpSingle[1])

      const atMatch = fullAnn.match(/assignableTypes\s*=\s*\{([^}]+)\}/)
      if (atMatch) assignableTypes.push(...atMatch[1].split(',').map(s => s.trim().replace(/["']/g, '')))

      const annMatch = fullAnn.match(/annotations\s*=\s*\{([^}]+)\}/)
      if (annMatch) annotations.push(...annMatch[1].split(',').map(s => s.trim().replace(/["']/g, '')))

      currentAdvice = {
        className: '',
        basePackages, assignableTypes, annotations,
        exceptionHandlers: [], initBinders: [], modelAttributes: [],
      }
      continue
    }

    if (!currentAdvice) continue

    const classMatch = line.match(/(?:public\s+)?class\s+(\w+)/)
    if (classMatch) {
      currentAdvice.className = classMatch[1]
    }

    if (line.startsWith('@ExceptionHandler')) {
      const excMatch = line.match(/@ExceptionHandler\s*\(\s*\{?\s*([^)}]+)\s*\}?\s*\)/)
      const exceptionTypes: string[] = []
      if (excMatch) {
        for (const et of excMatch[1].split(',')) {
          exceptionTypes.push(et.trim().replace(/\.class/g, ''))
        }
      } else {
        exceptionTypes.push('Exception')
      }

      let j = i + 1
      while (j < lines.length && !lines[j].trim().includes('(') && !lines[j].trim().startsWith('public')) j++
      const methodLine = (lines[j] || lines[i] || '').trim()
      const methodMatch = methodLine.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)

      if (methodMatch) {
        const returnType = methodMatch[1]
        const methodName = methodMatch[2]
        let responseStatus: number | undefined
        const isProblemDetail = returnType.includes('ProblemDetail') || returnType.includes('ErrorResponse') || source.includes('spring.mvc.problemdetails.enabled=true') || source.includes('spring.webflux.problemdetails.enabled=true')

        for (let k = i - 3; k <= i + 3; k++) {
          if (k >= 0 && k < lines.length && lines[k].includes('@ResponseStatus')) {
            const rsMatch = lines[k].match(/@ResponseStatus\s*\(\s*(?:value\s*=\s*)?(?:HttpStatus\.)?(\w+)\s*\)/)
            if (rsMatch) {
              const statusMap: Record<string, number> = { OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, INTERNAL_SERVER_ERROR: 500, SERVICE_UNAVAILABLE: 503 }
              responseStatus = statusMap[rsMatch[1]] || 500
            }
          }
        }

        for (const et of exceptionTypes) {
          currentAdvice.exceptionHandlers.push({
            exceptionType: et, methodName, returnType, responseStatus,
          })

          const caNodes = queries.searchNodes(currentAdvice.className, 10)
            .filter(n => n.moduleId === moduleId && n.filePath === filePath && n.kind === 'class')
          for (const cn of caNodes) {
            const meta: Record<string, any> = { exceptionType: et, methodName, responseStatus }
            if (isProblemDetail) meta.problemDetail = true
            queries.insertAnnotation(cn.id, 'ExceptionHandler', JSON.stringify(meta), i + 1, moduleId)
            const excNodes = queries.searchNodes(et, 5).filter(n => n.moduleId === moduleId && n.kind === 'class')
            for (const en of excNodes) {
              queries.insertEdge(cn.id, en.id,
                'exception_handler', JSON.stringify(meta), i + 1, 0)
            }
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
      if (methodMatch) {
        currentAdvice.initBinders.push({ methodName: methodMatch[1], parameterNames: binderName ? [binderName] : [] })
      }
    }

    if (line.startsWith('@ModelAttribute')) {
      const nameMatch = line.match(/@ModelAttribute\s*\(\s*["']([^"']+)["']/)
      const attrName = nameMatch?.[1] || ''
      let j = i + 1
      while (j < lines.length && !lines[j].trim().includes('(')) j++
      const methodLine = lines[j] || ''
      const methodMatch = methodLine.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
      if (methodMatch) {
        currentAdvice.modelAttributes.push({ methodName: methodMatch[2], attributeName: attrName })
      }
    }

    if (line.trim() === '}' && currentAdvice.className) {
      const ca: ControllerAdvice = {
        className: currentAdvice.className, filePath,
        basePackages: [...currentAdvice.basePackages],
        assignableTypes: [...currentAdvice.assignableTypes],
        annotations: [...currentAdvice.annotations],
        exceptionHandlers: [...currentAdvice.exceptionHandlers],
        initBinders: [...currentAdvice.initBinders],
        modelAttributes: [...currentAdvice.modelAttributes],
        line: i + 1, moduleId,
      }
      results.push(ca)

      const caNodes = queries.searchNodes(ca.className, 10)
        .filter(n => n.moduleId === moduleId && n.filePath === filePath && n.kind === 'class')
      for (const cn of caNodes) {
        queries.insertAnnotation(cn.id, 'ControllerAdvice',
          JSON.stringify({ basePackages: ca.basePackages, assignableTypes: ca.assignableTypes, annotations: ca.annotations }),
          i + 1, moduleId)
      }

      currentAdvice = null
    }
  }

  return results
}
