import type { QueryManager } from '../db/queries.js'

export interface InterceptorInfo {
  className: string
  filePath: string
  type: 'HandlerInterceptor' | 'OncePerRequestFilter' | 'Filter' | 'WebFilter'
  methodName: string
  urlPatterns: string[]
  order: number
  line: number
  moduleId: string
}

export function indexInterceptors(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): InterceptorInfo[] {
  const results: InterceptorInfo[] = []
  const lines = source.split('\n')

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
        if (line.trim().startsWith(`public`) && line.includes(mo) && line.includes('(')) {
          results.push({
            className, filePath, type,
            methodName: mo,
            urlPatterns: ['/*'],
            order: 0,
            line: i + 1, moduleId,
          })
          queries.insertAnnotation(`${filePath}:${className}:${mo}`, 'Interceptor',
            JSON.stringify({ type, urlPatterns: ['/*'] }), i + 1, moduleId)
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
        if (interceptorRef) {
          queries.insertAnnotation(`${filePath}:WebMvcConfigurer`,
            'InterceptorRegistration',
            JSON.stringify({ interceptorRef, urlPatterns: patterns, excludePatterns: excludeMatch?.[1] || '' }),
            i + 1, moduleId)
        }
      }
    }
  }

  return results
}
