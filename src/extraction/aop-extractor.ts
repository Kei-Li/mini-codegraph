import type { QueryManager } from '../db/queries.js'

export interface AspectAdvice {
  aspectClass: string
  filePath: string
  adviceType: 'Before' | 'After' | 'Around' | 'AfterReturning' | 'AfterThrowing'
  pointcutExpression: string
  methodName: string
  line: number
  moduleId: string
}

export interface PointcutDef {
  aspectClass: string
  pointcutName: string
  expression: string
  line: number
}

function findAnnotationEnd(lines: string[], start: number): number {
  let j = start
  let depth = 0
  let found = false
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
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): { advices: AspectAdvice[]; pointcuts: PointcutDef[] } {
  const advices: AspectAdvice[] = []
  const pointcuts: PointcutDef[] = []
  const lines = source.split('\n')

  const hasAspect = source.includes('@Aspect')
  if (!hasAspect) return { advices, pointcuts }

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
        pointcuts.push({
          aspectClass: currentAspect,
          pointcutName: nameMatch[1],
          expression: exprMatch[1],
          line: i + 1,
        })
        queries.insertAnnotation(`${filePath}:${nameMatch[1]}`, 'Pointcut',
          exprMatch[1], i + 1, moduleId)
      }
      continue
    }

    for (const at of adviceTypes) {
      if (!line.trim().startsWith(`@${at}`)) continue

      let j = findAnnotationEnd(lines, i)
      if (j >= lines.length) continue
      const fullSrc = lines.slice(i, j + 1).join(' ')

      const valueMatch = fullSrc.match(/@${at}\s*\((?:value\s*=\s*)?["']([^"']+)["']/)
      const pointcutRef = fullSrc.match(/@${at}\s*\(\s*(\w+)/)
      const expression = valueMatch?.[1] || pointcutRef?.[1] || ''

      const methodLine = findMethodLine(lines, j)
      const methodMatch = methodLine?.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
      const methodName = methodMatch?.[2] || `advice_${at}_${i + 1}`

      const advice: AspectAdvice = {
        aspectClass: currentAspect,
        filePath,
        adviceType: at,
        pointcutExpression: expression,
        methodName,
        line: i + 1,
        moduleId,
      }
      advices.push(advice)

      const nodeId = `${filePath}:${methodName}`
      const parentNodes = queries.searchNodes(currentAspect, 3)
        .filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const pn of parentNodes) {
        queries.insertAnnotation(nodeId, `Aspect_${at}`,
          JSON.stringify({ pointcut: expression, method: methodName }), i + 1, moduleId)
        queries.insertEdge(pn.id, nodeId, `aspect_${at.toLowerCase()}`,
          JSON.stringify({ pointcut: expression }), i + 1, 0)
      }
    }
  }

  for (const pc of pointcuts) {
    for (const ad of advices) {
      if (ad.pointcutExpression === pc.pointcutName) {
        ad.pointcutExpression = pc.expression
      }
    }
  }

  return { advices, pointcuts }
}

export function resolvePointcutMatches(
  queries: QueryManager,
  advices: AspectAdvice[],
  moduleId: string
): { advice: AspectAdvice; matchedNodes: string[] }[] {
  const results: { advice: AspectAdvice; matchedNodes: string[] }[] = []
  const allNodes = queries.getAllNodes().filter(n => n.moduleId === moduleId)

  for (const ad of advices) {
    const expr = ad.pointcutExpression
    const matched: string[] = []

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
            queries.insertEdge(ad.filePath, node.id, 'aspect_weave',
              JSON.stringify({ adviceType: ad.adviceType, pointcut: expr }), ad.line, 0)
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
          queries.insertEdge(ad.filePath, an.id, 'aspect_weave',
            JSON.stringify({ adviceType: ad.adviceType, pointcut: expr }), ad.line, 0)
        }
      }
    }

    const withinMatch = expr.match(/within\(\s*(\w+(?:\.\w+)*)\s*\)/)
    if (withinMatch) {
      const pattern = withinMatch[1].replace(/\*/g, '.*')
      for (const node of allNodes) {
        if (node.kind === 'class' && node.qualifiedName.match(new RegExp(pattern))) {
          matched.push(node.id)
          queries.insertEdge(ad.filePath, node.id, 'aspect_weave',
            JSON.stringify({ adviceType: ad.adviceType, pointcut: expr }), ad.line, 0)
        }
      }
    }

    if (matched.length > 0) {
      results.push({ advice: ad, matchedNodes: matched })
    }
  }

  return results
}
