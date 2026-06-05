import type { QueryManager } from '../../../db/queries.js'
import type { DispatchPattern, IDispatchDetector, InferredTarget } from '../types.js'
import { CONFIDENCE } from '../types.js'

const AOP_TRIGGER_ANNOTATIONS = [
  'Transactional', 'Cacheable', 'CacheEvict', 'CachePut',
  'Async', 'Scheduled',
]

interface ResolvedPointcut {
  matchedNodeIds: string[]
  expression: string
  adviceType: string
  aspectClass: string
}

function parseExecutionPointcut(expr: string): { classPattern: string; methodPattern: string; argsPattern: string } | null {
  const execMatch = expr.match(/execution\(\s*(.*)\)/)
  if (!execMatch) return null
  let inner = execMatch[1].trim()
  inner = inner.replace(/^(?:public|private|protected)\s+/, '')
  const parenIdx = inner.lastIndexOf('(')
  if (parenIdx === -1) return null
  const beforeMethod = inner.substring(0, parenIdx).trim()
  const argsPattern = inner.substring(parenIdx).replace(/[()]/g, '')
  const dotIdx = beforeMethod.lastIndexOf('.')
  if (dotIdx === -1) return null
  const beforeDot = beforeMethod.substring(0, dotIdx).trim()
  const parts = beforeDot.split(/\s+/)
  const classPattern = parts[parts.length - 1]
  const methodPattern = beforeMethod.substring(dotIdx + 1).trim()
  return { classPattern, methodPattern, argsPattern }
}

function parseWithinPointcut(expr: string): string | null {
  const withinMatch = expr.match(/within\(\s*(\*?[A-Za-z_][\w.*]*)\s*\)/)
  return withinMatch ? withinMatch[1] : null
}

function parseAnnotationPointcut(expr: string): string | null {
  const annMatch = expr.match(/@annotation\(\s*(\w+)\s*\)/)
  return annMatch ? annMatch[1] : null
}

function patternToRegex(pattern: string): RegExp {
  let rx = ''
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] === '.' && pattern[i + 1] === '.') {
      // `..` in AspectJ means any subpackages, including the separating dots
      // Match: optional `.subpackage` segments + optional final dot before class
      rx += '(?:\\.[^.]+)*\\.?'
      i += 2
    } else if (pattern[i] === '*') {
      rx += '[^.]+'
      i++
    } else if (pattern[i] === '.') {
      rx += '\\.'
      i++
    } else if (pattern[i] === '?') {
      rx += '.'
      i++
    } else {
      // Word char or other literal
      rx += pattern[i]
      i++
    }
  }
  return new RegExp(`^${rx}$`)
}

function resolvePointcutExpression(
  expr: string,
  queries: QueryManager,
  aspectClass: string,
  moduleId: string,
): ResolvedPointcut | null {
  const allNodes = queries.getAllNodes().filter(n => n.moduleId === moduleId)

  const executionMatch = parseExecutionPointcut(expr)
  if (executionMatch) {
    const { classPattern, methodPattern } = executionMatch
    const classRx = patternToRegex(classPattern)
    const methodRx = patternToRegex(methodPattern)

    const matched: string[] = []
    for (const node of allNodes) {
      if (node.kind !== 'method') continue
      if (!node.name.match(methodRx)) continue

      const parent = node.parentId ? queries.getNode(node.parentId) : null
      if (!parent) continue

      const parentName = parent.qualifiedName || parent.name
      if (classRx.test(parentName)) {
        matched.push(node.id)
      }
    }

    if (matched.length > 0) {
      return {
        matchedNodeIds: matched,
        expression: expr,
        adviceType: 'execution',
        aspectClass,
      }
    }
  }

  const withinPattern = parseWithinPointcut(expr)
  if (withinPattern) {
    const rx = patternToRegex(withinPattern)
    const matched: string[] = []
    for (const node of allNodes) {
      if (node.kind !== 'class') continue
      const qn = node.qualifiedName || node.name
      if (rx.test(qn)) {
        matched.push(node.id)
        const children = queries.getChildren(node.id)
        for (const child of children) {
          if (child.kind === 'method') matched.push(child.id)
        }
      }
    }
    if (matched.length > 0) {
      return { matchedNodeIds: matched, expression: expr, adviceType: 'within', aspectClass }
    }
  }

  const annName = parseAnnotationPointcut(expr)
  if (annName) {
    const annNodes = queries.getNodesByAnnotation(annName)
    const matched = annNodes
      .filter(n => n.moduleId === moduleId)
      .map(n => n.id)
    if (matched.length > 0) {
      return { matchedNodeIds: matched, expression: expr, adviceType: 'annotation', aspectClass }
    }
  }

  return null
}

export class AopDetector implements IDispatchDetector {
  name = 'aop-detector'

  async detect(queries: QueryManager, moduleId: string, _allModuleIds: string[]): Promise<DispatchPattern[]> {
    const patterns: DispatchPattern[] = []
    const allNodes = queries.getAllNodes()
    const allEdges = queries.getAllEdges()

    const classNodes = allNodes.filter(n =>
      n.kind === 'class' && n.moduleId === moduleId
    )

    for (const cls of classNodes) {
      const annotations = queries.getAnnotationsByNode(cls.id)
      const aopAnns = annotations.filter(a => AOP_TRIGGER_ANNOTATIONS.includes(a.annotationName))
      if (aopAnns.length === 0) continue

      const implEdges = allEdges.filter(e =>
        e.kind === 'implements' && e.sourceId === cls.id
      )
      const interfaceNames: string[] = []
      for (const ie of implEdges) {
        const ifaceNode = queries.getNode(ie.targetId)
        if (ifaceNode) interfaceNames.push(ifaceNode.name)
      }

      const children = queries.getChildren(cls.id).filter(c => c.kind === 'method')
      const childTargets: InferredTarget[] = children.map(child => ({
        targetId: child.id,
        targetName: child.name,
        confidence: CONFIDENCE.AOP_PROXY,
        provenance: 'aop_proxy',
        provenanceDetail: `AOP proxied method: ${cls.name}.${child.name} via ${aopAnns.map(a => a.annotationName).join(', ')}`,
        condition: {
          source: 'annotation',
          value: aopAnns[0].annotationName,
          expression: `@${aopAnns[0].annotationName}`,
        },
      }))

      patterns.push({
        type: 'aop_proxy',
        sourceId: cls.id,
        sourceName: cls.name,
        interfaceName: interfaceNames[0] || undefined,
        possibleTargets: childTargets.length > 0 ? childTargets : [{
          targetId: cls.id,
          targetName: cls.name,
          confidence: CONFIDENCE.AOP_PROXY,
          provenance: 'aop_proxy',
          provenanceDetail: `AOP proxied via: ${aopAnns.map(a => a.annotationName).join(', ')}`,
          condition: {
            source: 'annotation',
            value: aopAnns[0].annotationName,
            expression: `@${aopAnns[0].annotationName}`,
          },
        }],
      })
    }

    const aspectNodes = allNodes.filter(n => {
      if (n.kind !== 'class' || n.moduleId !== moduleId) return false
      const anns = queries.getAnnotationsByNode(n.id)
      return anns.some(a => a.annotationName === 'Aspect')
    })

    for (const aspect of aspectNodes) {
      const allAspectTargets: InferredTarget[] = []

      const pointcutAnnotations = queries.getAnnotationsByNode(aspect.id)
        .filter(a => a.annotationName === 'Pointcut')
      for (const pc of pointcutAnnotations) {
        const resolved = resolvePointcutExpression(pc.value, queries, aspect.name, moduleId)
        if (!resolved || resolved.matchedNodeIds.length === 0) continue

        const targets: InferredTarget[] = resolved.matchedNodeIds.map(targetId => {
          const targetNode = queries.getNode(targetId)
          return {
            targetId,
            targetName: targetNode?.name ?? targetId,
            confidence: CONFIDENCE.AOP_PROXY,
            provenance: 'aop_proxy',
            provenanceDetail: `@Aspect ${aspect.name} pointcut '${pc.value}' matches ${targetNode?.name ?? targetId}`,
            condition: {
              source: 'pointcut',
              value: pc.value,
              expression: `@Pointcut("${pc.value}")`,
            },
          }
        })

        allAspectTargets.push(...targets)

        patterns.push({
          type: 'aop_proxy',
          sourceId: aspect.id,
          sourceName: aspect.name,
          possibleTargets: targets,
        })
      }

      const aspectAdviceEdges = allEdges.filter(e =>
        (e.kind.startsWith('aspect_') || e.kind === 'aspect_weave') && e.sourceId === aspect.id
      )

      const weaveTargets: InferredTarget[] = []
      for (const edge of aspectAdviceEdges) {
        const existing = [...allAspectTargets, ...weaveTargets].some(t => t.targetId === edge.targetId)
        if (existing) continue

        const targetNode = queries.getNode(edge.targetId)
        weaveTargets.push({
          targetId: edge.targetId,
          targetName: targetNode?.name ?? edge.targetId,
          confidence: CONFIDENCE.AOP_PROXY,
          provenance: 'aop_proxy',
          provenanceDetail: `Aspect: ${aspect.name} → ${edge.kind} weaving on ${targetNode?.name ?? edge.targetId}`,
          condition: {
            source: 'aspect_weave',
            value: edge.kind,
            expression: `@Aspect ${aspect.name} ${edge.kind}`,
          },
        })
      }

      if (weaveTargets.length > 0) {
        patterns.push({
          type: 'aop_proxy',
          sourceId: aspect.id,
          sourceName: aspect.name,
          possibleTargets: weaveTargets,
        })
      }
    }

    return patterns
  }
}
