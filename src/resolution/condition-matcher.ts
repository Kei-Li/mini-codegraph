import type { QueryManager } from '../db/queries.js'
import type { FlatConfig } from './config-reader.js'
import { getConfigProperty, hasActiveProfile } from './config-reader.js'

export interface ConditionEvaluation {
  matched: boolean
  reason: string
  confidence: number
}

export interface ConditionalAnnotation {
  type: string
  name: string
  value: string
  matchIfMissing: boolean
  havingValue?: string
}

export function parseConditionalAnnotation(
  annotationName: string,
  annotationValue: string,
): ConditionalAnnotation | null {
  switch (annotationName) {
    case 'ConditionalOnProperty': {
      const nameMatch = annotationValue.match(/name\s*=\s*"([^"]+)"/)
      const havingMatch = annotationValue.match(/havingValue\s*=\s*"([^"]+)"/)
      const matchIfMissing = annotationValue.includes('matchIfMissing = true')
      if (!nameMatch) return null
      return {
        type: 'property',
        name: nameMatch[1],
        value: '',
        matchIfMissing,
        havingValue: havingMatch?.[1],
      }
    }
    case 'Profile': {
      const profiles = annotationValue
        .replace(/[{}()]/g, '')
        .split(',')
        .map(s => s.trim().replace(/["']/g, ''))
        .filter(Boolean)
      return {
        type: 'profile',
        name: profiles[0] || '',
        value: profiles.join(','),
        matchIfMissing: false,
        havingValue: undefined,
      }
    }
    case 'ConditionalOnClass':
      return {
        type: 'class',
        name: annotationValue.replace(/["']/g, '').trim(),
        value: annotationValue,
        matchIfMissing: false,
      }
    case 'ConditionalOnMissingBean':
      return {
        type: 'missingBean',
        name: annotationValue.replace(/["']/g, '').trim(),
        value: annotationValue,
        matchIfMissing: true,
      }
    case 'ConditionalOnBean':
      return {
        type: 'bean',
        name: annotationValue.replace(/["']/g, '').trim(),
        value: annotationValue,
        matchIfMissing: false,
      }
    case 'ConditionalOnExpression':
      return {
        type: 'expression',
        name: 'expression',
        value: annotationValue,
        matchIfMissing: false,
      }
    default:
      return null
  }
}

function evaluateSpelExpression(expression: string, config: FlatConfig): ConditionEvaluation {
  const cleaned = expression.replace(/^@ConditionalOnExpression\(/i, '').replace(/\)$/g, '').trim()
  const inner = cleaned.replace(/^["'](.+)["']$/, '$1').trim()

  // Replace ${property:default} placeholders with actual config values
  const resolved = inner.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (_match, key: string, defVal?: string) => {
    const val = getConfigProperty(config, key.trim())
    if (val !== undefined) return val
    return defVal ?? `\${${key}}`
  })

  // If the expression resolved to a literal 'true' or 'false'
  if (resolved === 'true') {
    return { matched: true, reason: `Expression evaluates to true: ${resolved}`, confidence: 0.35 }
  }
  if (resolved === 'false') {
    return { matched: false, reason: `Expression evaluates to false: ${resolved}`, confidence: 0.35 }
  }

  // Simple comparison: left == right or left === right
  const eqMatch = resolved.match(/^\s*['"]?([^'"=]+)['"]?\s*=={2,3}\s*['"]?([^'"=]+)['"]?\s*$/)
  if (eqMatch) {
    const [, left, right] = eqMatch
    const match = left.trim() === right.trim()
    return {
      matched: match,
      reason: match
        ? `Expression '${resolved}' matches (${left.trim()} == ${right.trim()})`
        : `Expression '${resolved}' does NOT match (${left.trim()} != ${right.trim()})`,
      confidence: 0.6,
    }
  }

  return { matched: true, reason: `Unresolved expression '${expression}', assuming true`, confidence: 0.2 }
}

export function evaluateCondition(
  condition: ConditionalAnnotation,
  config: FlatConfig,
): ConditionEvaluation {
  switch (condition.type) {
    case 'property': {
      const actualValue = getConfigProperty(config, condition.name)
      if (actualValue === undefined) {
        if (condition.matchIfMissing) {
          return { matched: true, reason: `Property '${condition.name}' missing, matchIfMissing=true`, confidence: 0.7 }
        }
        return { matched: false, reason: `Property '${condition.name}' not found in config`, confidence: 0.8 }
      }
      if (condition.havingValue !== undefined) {
        const match = actualValue === condition.havingValue
        return {
          matched: match,
          reason: match
            ? `Property '${condition.name}' = '${actualValue}' matches havingValue '${condition.havingValue}'`
            : `Property '${condition.name}' = '${actualValue}' does NOT match havingValue '${condition.havingValue}'`,
          confidence: 0.9,
        }
      }
      return { matched: true, reason: `Property '${condition.name}' = '${actualValue}' is present`, confidence: 0.9 }
    }

    case 'profile': {
      const profiles = condition.value.split(',')
      for (const profile of profiles) {
        if (hasActiveProfile(config, profile.trim())) {
          return { matched: true, reason: `Active profile matches '${profile}'`, confidence: 0.9 }
        }
      }
      return {
        matched: false,
        reason: `None of profiles [${condition.value}] are active. Active: [${config.activeProfiles.join(', ')}]`,
        confidence: 0.9,
      }
    }

    case 'class':
      return { matched: true, reason: `Assuming class '${condition.name}' is on classpath`, confidence: 0.5 }
    case 'missingBean':
      return { matched: true, reason: `Assuming bean '${condition.name}' is missing`, confidence: 0.4 }
    case 'bean':
      return { matched: true, reason: `Assuming bean '${condition.name}' is present`, confidence: 0.4 }
    case 'expression':
      return evaluateSpelExpression(condition.value, config)

    default:
      return { matched: true, reason: `Unknown condition type '${condition.type}', assuming true`, confidence: 0.2 }
  }
}

export function evaluateConditionsOnNode(
  queries: QueryManager,
  nodeId: string,
  config: FlatConfig,
): ConditionEvaluation[] {
  const results: ConditionEvaluation[] = []
  const annotations = queries.getAnnotationsByNode(nodeId)

  for (const ann of annotations) {
    if (ann.annotationName === 'Profile' || ann.annotationName.startsWith('Conditional')) {
      const parsed = parseConditionalAnnotation(ann.annotationName, ann.value)
      if (parsed) {
        results.push(evaluateCondition(parsed, config))
      }
    }
  }

  return results
}

export function isNodeActiveUnderConfig(
  queries: QueryManager,
  nodeId: string,
  config: FlatConfig,
): { active: boolean; evaluations: ConditionEvaluation[] } {
  const evaluations = evaluateConditionsOnNode(queries, nodeId, config)
  if (evaluations.length === 0) {
    return { active: true, evaluations: [] }
  }
  const allMatched = evaluations.every(e => e.matched)
  return { active: allMatched, evaluations }
}

export function filterActiveImplementations(
  queries: QueryManager,
  interfaceNodeId: string,
  config: FlatConfig,
): { nodeId: string; confidence: number; evaluations: ConditionEvaluation[] }[] {
  const allEdges = queries.getAllEdges()
  const implementors = allEdges
    .filter(e => (e.kind === 'implements' || e.kind === 'conditional_impl') && e.targetId === interfaceNodeId)
    .map(e => e.sourceId)

  const ownChildren = queries.getChildren(interfaceNodeId)
    .filter(c => c.kind === 'class')
    .map(c => c.id)

  const candidates = [...new Set([...implementors, ...ownChildren])]
  const results: { nodeId: string; confidence: number; evaluations: ConditionEvaluation[] }[] = []

  for (const candidateId of candidates) {
    const result = isNodeActiveUnderConfig(queries, candidateId, config)
    const avgConfidence = result.evaluations.length > 0
      ? result.evaluations.reduce((sum, e) => sum + e.confidence, 0) / result.evaluations.length
      : 0.8

    results.push({
      nodeId: candidateId,
      confidence: result.active ? avgConfidence : avgConfidence * 0.3,
      evaluations: result.evaluations,
    })
  }

  return results
}
