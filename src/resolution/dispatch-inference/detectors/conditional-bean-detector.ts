import type { QueryManager } from '../../../db/queries.js'
import type { DispatchPattern, IDispatchDetector, InferredTarget } from '../types.js'
import { CONFIDENCE } from '../types.js'
import { readProjectConfig } from '../../config-reader.js'
import { isNodeActiveUnderConfig, parseConditionalAnnotation, evaluateCondition } from '../../condition-matcher.js'

export class ConditionalBeanDetector implements IDispatchDetector {
  name = 'conditional-bean-detector'

  async detect(queries: QueryManager, moduleId: string, _allModuleIds: string[]): Promise<DispatchPattern[]> {
    const patterns: DispatchPattern[] = []
    const allNodes = queries.getAllNodes()
    const allEdges = queries.getAllEdges()

    const projectNode = allNodes.find(n => n.moduleId === moduleId && n.filePath)
    if (!projectNode) return patterns

    let projectRoot = ''
    if (projectNode.filePath) {
      const parts = projectNode.filePath.replace(/\\/g, '/').split('/')
      const srcIdx = parts.indexOf('src')
      if (srcIdx > 0) {
        projectRoot = parts.slice(0, srcIdx).join('/')
      }
    }

    let config = readProjectConfig(projectRoot || '.')

    const interfaceNodes = allNodes.filter(n =>
      n.kind === 'interface' && n.moduleId === moduleId
    )

    for (const iface of interfaceNodes) {
      const implementsEdges = allEdges.filter(e =>
        e.kind === 'implements' && e.targetId === iface.id
      )

      const implNodes = implementsEdges
        .map(e => queries.getNode(e.sourceId))
        .filter((n): n is Exclude<typeof n, undefined> & { kind: string } => n != null && n.kind === 'class')

      const nameBasedImpls = allNodes.filter(n =>
        n.kind === 'class' &&
        n.moduleId === moduleId &&
        (n.name === iface.name || n.name === `${iface.name}Impl` ||
         n.name.endsWith(iface.name))
      )

      const allImpls = [...implNodes, ...nameBasedImpls].filter(
        (n, idx, self) => self.findIndex(x => x.id === n.id) === idx
      )

      if (allImpls.length === 0) continue

      const annotationChecks: { nodeId: string; nodeName: string }[] = []
      for (const impl of allImpls) {
        const anns = queries.getAnnotationsByNode(impl.id)
        const hasConditional = anns.some(a =>
          a.annotationName === 'Profile' || a.annotationName.startsWith('Conditional')
        )
        if (hasConditional) annotationChecks.push({ nodeId: impl.id, nodeName: impl.name })
      }

      const allHaveAnnotations = annotationChecks.length === allImpls.length && allImpls.length > 1

      const targets: InferredTarget[] = allImpls.map(impl => {
        const activeResult = isNodeActiveUnderConfig(queries, impl.id, config)
        const hasConditions = activeResult.evaluations.length > 0

        const conditionExprs = activeResult.evaluations.map(e => e.reason).join('; ')

        const profileAnns = queries.getAnnotationsByNode(impl.id)
          .filter(a => a.annotationName === 'Profile')
        const conditionalAnns = queries.getAnnotationsByNode(impl.id)
          .filter(a => a.annotationName.startsWith('Conditional'))

        let condition: { source: string; value: string; expression: string } | undefined

        if (profileAnns.length > 0) {
          condition = {
            source: 'profile',
            value: profileAnns[0].value,
            expression: `@Profile(${profileAnns[0].value})`,
          }
        } else if (conditionalAnns.length > 0) {
          condition = {
            source: conditionalAnns[0].annotationName,
            value: conditionalAnns[0].value,
            expression: `@${conditionalAnns[0].annotationName}(${conditionalAnns[0].value})`,
          }
        }

        const allConditions = [...profileAnns, ...conditionalAnns]
        const hasMeaningfulConditions = allConditions.length > 0

        let confidence: number
        let provenance: 'conditional_bean' | 'strategy_registered' | 'autowired_unique'
        let provenanceDetail: string

        if (allImpls.length === 1) {
          confidence = CONFIDENCE.AUTOWIRED_UNIQUE_IMPL
          provenance = 'autowired_unique'
          provenanceDetail = `Unique implementation of ${iface.name}: ${impl.name}`
        } else if (hasMeaningfulConditions && activeResult.active) {
          confidence = CONFIDENCE.CONDITIONAL_BEAN_RESOLVED
          provenance = 'conditional_bean'
          provenanceDetail = `Condition active: ${conditionExprs || 'no condition evaluated'}`
        } else if (allHaveAnnotations && !activeResult.active) {
          confidence = CONFIDENCE.STRATEGY_MAP_ENUMERATED
          provenance = 'strategy_registered'
          provenanceDetail = `Inactive under current config${
            conditionExprs ? `: ${conditionExprs}` : ''
          }`
        } else {
          confidence = CONFIDENCE.STRATEGY_MAP_ENUMERATED
          provenance = 'strategy_registered'
          provenanceDetail = `Possible strategy implementation ${
            hasConditions ? activeResult.active ? '(active)' : '(inactive)' : ''
          }`
        }

        return {
          targetId: impl.id,
          targetName: impl.name,
          interfaceId: iface.id,
          interfaceName: iface.name,
          confidence,
          provenance,
          provenanceDetail,
          condition,
          alternatives: allImpls.filter(a => a.id !== impl.id).map(a => a.id),
        }
      })

      if (targets.length > 0) {
        patterns.push({
          type: targets[0].provenance as any,
          sourceId: iface.id,
          sourceName: iface.name,
          interfaceId: iface.id,
          interfaceName: iface.name,
          possibleTargets: targets,
        })
      }
    }

    const autowiredNodes = allNodes.filter(n => {
      if (n.moduleId !== moduleId) return false
      const anns = queries.getAnnotationsByNode(n.id)
      return anns.some(a => ['Autowired', 'Resource', 'Inject'].includes(a.annotationName))
    })

    for (const autowired of autowiredNodes) {
      const anns = queries.getAnnotationsByNode(autowired.id)
      const autowiredAnn = anns.find(a => ['Autowired', 'Resource', 'Inject'].includes(a.annotationName))
      if (!autowiredAnn) continue

      const fieldType = autowiredAnn.value.replace(/["']/g, '').trim()
      if (!fieldType) continue

      const ifaceNode = allNodes.find(n =>
        (n.name === fieldType || n.qualifiedName === fieldType || n.qualifiedName.endsWith(`.${fieldType}`)) &&
        (n.kind === 'interface' || n.kind === 'class') &&
        n.moduleId === moduleId
      )

      if (!ifaceNode) continue

      const impls = allNodes.filter(n => {
        if (n.kind !== 'class' || n.moduleId !== moduleId) return false
        const anns2 = queries.getAnnotationsByNode(n.id)
        return anns2.some(a => ['Service', 'Component', 'Repository'].includes(a.annotationName))
      })

      const compatibleImpls = impls.filter(impl => {
        const edges = allEdges.filter(e =>
          e.kind === 'implements' && e.sourceId === impl.id
        )
        return edges.some(e => e.targetId === ifaceNode.id) ||
          impl.name === ifaceNode.name ||
          impl.name === `${ifaceNode.name}Impl` ||
          impl.name.endsWith(ifaceNode.name)
      })

      if (compatibleImpls.length === 0) continue

      const existingInjectionTargets = allEdges
        .filter(e => e.sourceId === autowired.id && e.kind === 'calls')
        .map(e => e.targetId)

      const newImpls = compatibleImpls.filter(impl => !existingInjectionTargets.includes(impl.id))
      if (newImpls.length === 0) continue

      const targets: InferredTarget[] = newImpls.map(impl => {
        const activeResult = isNodeActiveUnderConfig(queries, impl.id, config)
        const hasConditions = activeResult.evaluations.length > 0

        return {
          targetId: impl.id,
          targetName: impl.name,
          interfaceId: ifaceNode.id,
          interfaceName: ifaceNode.name,
          confidence: hasConditions
            ? (activeResult.active ? CONFIDENCE.CONDITIONAL_BEAN_RESOLVED : CONFIDENCE.STRATEGY_MAP_ENUMERATED)
            : CONFIDENCE.AUTOWIRED_UNIQUE_IMPL,
          provenance: hasConditions
            ? (activeResult.active ? 'conditional_bean' : 'strategy_registered')
            : 'autowired_unique',
          provenanceDetail: `@Autowired ${ifaceNode.name} → ${impl.name}${
            activeResult.evaluations.length > 0
              ? activeResult.active ? ' [ACTIVE]' : ' [INACTIVE]'
              : ''
          }`,
          alternatives: compatibleImpls.filter(a => a.id !== impl.id).map(a => a.id),
        }
      })

      if (targets.length > 0) {
        patterns.push({
          type: 'conditional_bean' as any,
          sourceId: autowired.id,
          sourceName: autowired.name,
          interfaceId: ifaceNode.id,
          interfaceName: ifaceNode.name,
          possibleTargets: targets,
        })
      }
    }

    return patterns
  }
}
