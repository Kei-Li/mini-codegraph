import type { QueryManager } from '../../../db/queries.js'
import type { DispatchPattern, IDispatchDetector, InferredTarget } from '../types.js'
import { CONFIDENCE } from '../types.js'

function collectCandidatesForReflectiveLoad(
  queries: QueryManager,
  moduleId: string,
): { id: string; name: string; qualifiedName: string }[] {
  const allNodes = queries.getAllNodes()

  // Collect all classes that could be loaded reflectively
  const candidates = allNodes
    .filter(n => n.kind === 'class' && n.moduleId === moduleId)
    .map(n => ({
      id: n.id,
      name: n.name,
      qualifiedName: n.qualifiedName || n.name,
    }))

  return candidates
}

function matchCandidatesByString(
  classNameFragment: string,
  candidates: { id: string; name: string; qualifiedName: string }[],
): { id: string; name: string; qualifiedName: string }[] {
  if (!classNameFragment) return []

  const lower = classNameFragment.toLowerCase()

  // Direct match
  const direct = candidates.filter(c =>
    c.name.toLowerCase() === lower || c.qualifiedName.toLowerCase() === lower
  )
  if (direct.length > 0) return direct

  // Substring match
  return candidates.filter(c =>
    c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase())
  )
}

export class ReflectionDetector implements IDispatchDetector {
  name = 'reflection-detector'

  async detect(queries: QueryManager, moduleId: string, _allModuleIds: string[]): Promise<DispatchPattern[]> {
    const patterns: DispatchPattern[] = []
    const allNodes = queries.getAllNodes()
    const allEdges = queries.getAllEdges()

    const reflectiveMethods = [
      'forName', 'newInstance', 'invoke', 'getMethod',
      'getDeclaredMethod', 'getField', 'getDeclaredField',
    ]

    const classNodes = allNodes.filter(n =>
      n.kind === 'class' && n.moduleId === moduleId
    )

    // Pre-compute candidates
    const allCandidates = collectCandidatesForReflectiveLoad(queries, moduleId)

    // 1. Class.forName() — list all candidate classes
    const forNameNodes = allNodes.filter(n =>
      n.name === 'forName' && n.language === 'java'
    )

    for (const fn of forNameNodes) {
      const callers = queries.getCallers(fn.id)
      for (const caller of callers) {
        if (caller.moduleId !== moduleId) continue

        const callerChildren = allNodes.filter(n => n.parentId === caller.id)
        const literalArgs = callerChildren.filter(n =>
          n.kind === 'string_literal' ||
          (n.kind !== 'method' && (
            (n as any).kind === 'literal' ||
            n.name.startsWith('"') || n.name.startsWith("'")
          ))
        )

        const explicitClassName = literalArgs.length > 0
          ? literalArgs[0].name.replace(/['"]/g, '')
          : ''

        const matchedCandidates = explicitClassName
          ? matchCandidatesByString(explicitClassName, allCandidates)
          : allCandidates

        const targets: InferredTarget[] = matchedCandidates.map((c, idx) => ({
          targetId: c.id,
          targetName: c.name,
          confidence: idx === 0 && explicitClassName
            ? CONFIDENCE.REFLECTIVE_PATTERN * 2  // exact match gets slightly higher
            : CONFIDENCE.REFLECTIVE_PATTERN,
          provenance: 'reflective_match' as const,
          provenanceDetail: explicitClassName
            ? `Class.forName("${explicitClassName}") → likely loads ${c.qualifiedName} (${c.name})`
            : `Class.forName() in ${caller.name} — ${c.name} is a candidate`,
          condition: {
            source: 'Class.forName',
            value: explicitClassName || 'runtime',
            expression: `Class.forName("${explicitClassName || '<runtime>'}"): ${c.name}`,
          },
          alternatives: matchedCandidates
            .filter(a => a.id !== c.id)
            .map(a => a.id),
        }))

        if (targets.length > 0) {
          patterns.push({
            type: 'reflective_match',
            sourceId: fn.id,
            sourceName: `${caller.name}.forName`,
            interfaceName: explicitClassName || undefined,
            possibleTargets: targets,
          })
        }
      }
    }

    // 2. invoke() / newInstance() — list candidates
    const invokeNodes = allNodes.filter(n =>
      (n.name === 'invoke' || n.name === 'newInstance') &&
      n.language === 'java'
    )

    for (const invoke of invokeNodes) {
      const callers = queries.getCallers(invoke.id)
      for (const caller of callers) {
        if (caller.moduleId !== moduleId) continue

        const existing = patterns.some(p =>
          p.sourceId === caller.id && p.type === 'reflective_match'
        )
        if (existing) continue

        const rawName = invoke.name
        const targets: InferredTarget[] = allCandidates.map(c => ({
          targetId: c.id,
          targetName: c.name,
          confidence: CONFIDENCE.REFLECTIVE_PATTERN,
          provenance: 'reflective_match' as const,
          provenanceDetail: `Reflective ${rawName} call in ${caller.name} — ${c.name} is a potential target`,
          condition: {
            source: 'reflection',
            value: rawName,
            expression: `reflective:${rawName} → ${c.name}`,
          },
        }))

        if (targets.length > 0) {
          patterns.push({
            type: 'reflective_match',
            sourceId: invoke.id,
            sourceName: `${caller.name}.${rawName}`,
            possibleTargets: targets,
          })
        }
      }
    }

    // 3. SPI-style ServiceLoader.load() — cross-integrate with spi-detector
    const serviceLoaderNodes = allNodes.filter(n =>
      n.name === 'load' && n.language === 'java'
    )
    for (const sl of serviceLoaderNodes) {
      const callers = queries.getCallers(sl.id)
      for (const caller of callers) {
        if (caller.moduleId !== moduleId) continue

        const callerChildren = allNodes.filter(n => n.parentId === caller.id)
        const typeRefs = callerChildren.filter(n =>
          n.kind === 'type_reference' || n.kind === 'class'
        )

        for (const typeRef of typeRefs) {
          const spiCandidates = allNodes.filter(n =>
            (n.kind === 'class' && n.moduleId === moduleId) &&
            (n.name === typeRef.name || n.qualifiedName === typeRef.name ||
             n.qualifiedName.endsWith(`.${typeRef.name}`))
          )

          const targets: InferredTarget[] = spiCandidates.map(c => ({
            targetId: c.id,
            targetName: c.name,
            confidence: CONFIDENCE.REFLECTIVE_PATTERN,
            provenance: 'reflective_match' as const,
            provenanceDetail: `ServiceLoader<${typeRef.name}> in ${caller.name} — ${c.name} may be loaded`,
            condition: {
              source: 'ServiceLoader',
              value: typeRef.name,
              expression: `ServiceLoader<${typeRef.name}> → ${c.name}`,
            },
          }))

          if (targets.length > 0) {
            patterns.push({
              type: 'reflective_match',
              sourceId: sl.id,
              sourceName: `${caller.name}.ServiceLoader.load`,
              interfaceName: typeRef.name,
              possibleTargets: targets,
            })
          }
        }
      }
    }

    // 4. Edges marked as reflective
    const reflectiveEdgeNodes = new Set<string>()
    for (const edge of allEdges) {
      if (edge.kind === 'references' && edge.metadata?.includes('reflective')) {
        reflectiveEdgeNodes.add(edge.sourceId)
      }
    }

    for (const nodeId of reflectiveEdgeNodes) {
      const node = queries.getNode(nodeId)
      if (!node || node.moduleId !== moduleId) continue

      const targets: InferredTarget[] = [{
        targetId: node.id,
        targetName: node.name,
        confidence: CONFIDENCE.REFLECTIVE_PATTERN,
        provenance: 'reflective_match' as const,
        provenanceDetail: `Marked as @reflective in ${node.filePath}`,
      }]

      patterns.push({
        type: 'reflective_match',
        sourceId: node.id,
        sourceName: node.name,
        possibleTargets: targets,
      })
    }

    return patterns
  }
}
