import type { QueryManager } from '../../../db/queries.js'
import type { DispatchPattern, IDispatchDetector, InferredTarget } from '../types.js'
import { CONFIDENCE } from '../types.js'

function collectImplementationsOfInterface(
  ifaceName: string,
  queries: QueryManager,
  moduleId: string,
): { id: string; name: string }[] {
  const allNodes = queries.getAllNodes()
  const allEdges = queries.getAllEdges()

  // Find the interface node
  const ifaceNodes = allNodes.filter(n =>
    (n.kind === 'interface' || n.kind === 'class') &&
    n.moduleId === moduleId &&
    (n.name === ifaceName || n.qualifiedName === ifaceName || n.qualifiedName.endsWith(`.${ifaceName}`))
  )

  const results: { id: string; name: string }[] = []
  for (const iface of ifaceNodes) {
    const implEdges = allEdges.filter(e =>
      e.kind === 'implements' && e.targetId === iface.id
    )
    for (const ie of implEdges) {
      const implNode = queries.getNode(ie.sourceId)
      if (implNode && implNode.moduleId === moduleId) {
        results.push({ id: implNode.id, name: implNode.name })
      }
    }

    // Name-based convention impls
    const nameImpls = allNodes.filter(n =>
      n.kind === 'class' &&
      n.moduleId === moduleId &&
      (n.name === `${ifaceName}Impl` || n.name.endsWith(ifaceName))
    )
    for (const ni of nameImpls) {
      if (!results.some(r => r.id === ni.id)) {
        results.push({ id: ni.id, name: ni.name })
      }
    }
  }

  return [...new Map(results.map(r => [r.id, r])).values()]
}

export class FactoryDetector implements IDispatchDetector {
  name = 'factory-detector'

  async detect(queries: QueryManager, moduleId: string, _allModuleIds: string[]): Promise<DispatchPattern[]> {
    const patterns: DispatchPattern[] = []
    const allNodes = queries.getAllNodes()
    const methods = allNodes.filter(n =>
      (n.kind === 'method' || n.kind === 'function') &&
      n.moduleId === moduleId
    )

    for (const method of methods) {
      const annotations = queries.getAnnotationsByNode(method.id)
      const isBean = annotations.some(a => a.annotationName === 'Bean')
      if (!isBean && method.name !== 'create' && !method.name.startsWith('create') &&
          !method.name.startsWith('build') && !method.name.startsWith('get') &&
          !method.name.startsWith('new')) continue

      const returnType = method.signature || ''
      const returnTypeMatch = returnType.match(/:\s*(\w+)/)
      const returnTypeName = returnTypeMatch ? returnTypeMatch[1] : ''

      const callees = queries.getCallees(method.id)
      const instantiations = callees.filter(c =>
        c.kind === 'class' &&
        c.moduleId === moduleId
      )

      // Find all implementations of the return type interface
      const returnTypeImpls = returnTypeName
        ? collectImplementationsOfInterface(returnTypeName, queries, moduleId)
        : []

      const targets: InferredTarget[] = []
      const seenNames = new Set<string>()

      // Direct instantiations (e.g., new FooImpl())
      for (const inst of instantiations) {
        if (seenNames.has(inst.name)) continue
        seenNames.add(inst.name)
        targets.push({
          targetId: inst.id,
          targetName: inst.name,
          confidence: isBean ? CONFIDENCE.FACTORY_PRODUCT : CONFIDENCE.FACTORY_PRODUCT * 0.8,
          provenance: 'factory_product',
          provenanceDetail: `${isBean ? '@Bean' : 'Factory'} method ${method.name} can produce ${inst.name}`,
          condition: returnTypeName ? {
            source: 'return_type',
            value: returnTypeName,
            expression: `factory produces: ${returnTypeName}`,
          } : undefined,
          alternatives: instantiations
            .filter(i => i.id !== inst.id && !seenNames.has(i.name))
            .map(i => i.id),
        })
      }

      // Return-type-based candidates (runtime-determined dispatch)
      for (const impl of returnTypeImpls) {
        if (seenNames.has(impl.name)) continue
        seenNames.add(impl.name)
        targets.push({
          targetId: impl.id,
          targetName: impl.name,
          confidence: isBean
            ? CONFIDENCE.FACTORY_PRODUCT * 0.7
            : CONFIDENCE.FACTORY_PRODUCT * 0.5,
          provenance: 'factory_product',
          provenanceDetail: `${method.name} returns ${returnTypeName} — ${impl.name} is a candidate implementation`,
          condition: {
            source: 'return_type_mapping',
            value: returnTypeName,
            expression: `${returnTypeName} → ${impl.name}`,
          },
          alternatives: returnTypeImpls
            .filter(a => a.id !== impl.id)
            .map(a => a.id),
        })
      }

      if (targets.length > 0) {
        patterns.push({
          type: 'factory_product' as const,
          sourceId: method.id,
          sourceName: method.name,
          interfaceName: returnTypeName || undefined,
          possibleTargets: targets,
        })
      }
    }

    // @Configuration classes with @Bean methods
    const classAll = allNodes.filter(n =>
      n.kind === 'class' && n.moduleId === moduleId
    )

    for (const cls of classAll) {
      const annotations = queries.getAnnotationsByNode(cls.id)
      const isConfiguration = annotations.some(a =>
        a.annotationName === 'Configuration' || a.annotationName === 'AutoConfiguration'
      )
      if (!isConfiguration) continue

      const children = queries.getChildren(cls.id).filter(c =>
        c.kind === 'method'
      )

      for (const child of children) {
        const childAnns = queries.getAnnotationsByNode(child.id)
        const hasBean = childAnns.some(a => a.annotationName === 'Bean')
        if (!hasBean) continue

        const callees = queries.getCallees(child.id)
        const products = callees.filter(c => c.kind === 'class')

        // Also find return-type-based candidates
        const returnType = child.signature || ''
        const returnTypeMatch = returnType.match(/:\s*(\w+)/)
        const returnTypeName = returnTypeMatch ? returnTypeMatch[1] : ''
        const returnTypeCandidates = returnTypeName
          ? collectImplementationsOfInterface(returnTypeName, queries, moduleId)
          : []

        const targets: InferredTarget[] = []
        const seenIds = new Set<string>()

        for (const p of products) {
          if (seenIds.has(p.id)) continue
          seenIds.add(p.id)
          targets.push({
            targetId: p.id,
            targetName: p.name,
            confidence: CONFIDENCE.FACTORY_PRODUCT,
            provenance: 'factory_product',
            provenanceDetail: `@Configuration ${cls.name}.@Bean ${child.name} → ${p.name}`,
            condition: {
              source: 'config_class',
              value: cls.name,
              expression: `@Configuration ${cls.name}.@Bean ${child.name}`,
            },
          })
        }

        for (const rc of returnTypeCandidates) {
          if (seenIds.has(rc.id)) continue
          seenIds.add(rc.id)
          targets.push({
            targetId: rc.id,
            targetName: rc.name,
            confidence: CONFIDENCE.FACTORY_PRODUCT * 0.7,
            provenance: 'factory_product',
            provenanceDetail: `@Configuration ${cls.name}.@Bean ${child.name} returns ${returnTypeName} — ${rc.name} candidate`,
            condition: {
              source: 'return_type_mapping',
              value: returnTypeName,
              expression: `${returnTypeName} → ${rc.name}`,
            },
          })
        }

        if (targets.length > 0) {
          patterns.push({
            type: 'factory_product' as const,
            sourceId: child.id,
            sourceName: child.name,
            interfaceName: returnTypeName || undefined,
            possibleTargets: targets,
          })
        }
      }
    }

    return patterns
  }
}
