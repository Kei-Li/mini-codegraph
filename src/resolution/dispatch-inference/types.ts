import type { MiniCodeGraphNode } from '../../types.js'

export type DispatchProvenance =
  | 'static_direct'
  | 'autowired_unique'
  | 'autowired_multi_first'
  | 'conditional_bean'
  | 'aop_proxy'
  | 'strategy_registered'
  | 'factory_product'
  | 'proxy_handler'
  | 'spi_loaded'
  | 'reflective_match'
  | 'data_driven'
  | 'unknown'

export interface InferredTarget {
  targetId: string
  targetName: string
  interfaceId?: string
  interfaceName?: string
  confidence: number
  provenance: DispatchProvenance
  provenanceDetail: string
  condition?: {
    source: string
    value: string
    expression: string
  }
  alternatives?: string[]
}

export interface InferredEdge {
  source: string
  target: string
  kind: string
  metadata: string
  line: number
  col: number
}

export interface DispatchPattern {
  type: DispatchProvenance
  sourceId: string
  sourceName: string
  interfaceId?: string
  interfaceName?: string
  possibleTargets: InferredTarget[]
}

export interface DispatchResult {
  edges: InferredEdge[]
  patterns: DispatchPattern[]
  stats: {
    totalEdges: number
    totalPatterns: number
    byProvenance: Record<string, number>
  }
}

export const INFERRED_EDGE_KINDS = [
  'dispatch_registration',
  'dispatch_call',
  'proxy_wraps',
  'aop_advises',
  'conditional_impl',
] as const

export type InferredEdgeKind = (typeof INFERRED_EDGE_KINDS)[number]

export const CONFIDENCE = {
  STATIC_DIRECT_CALL: 1.0,
  AUTOWIRED_UNIQUE_IMPL: 0.9,
  CONDITIONAL_BEAN_RESOLVED: 0.8,
  AOP_PROXY: 0.7,
  STRATEGY_MAP_ENUMERATED: 0.6,
  FACTORY_PRODUCT: 0.5,
  AUTOWIRED_MULTI_IMPL_FIRST: 0.3,
  PROXY_HANDLER: 0.3,
  DATA_DRIVEN_DISPATCH: 0.15,
  REFLECTIVE_PATTERN: 0.1,
  UNKNOWN: 0,
} as const

export interface IDispatchDetector {
  name: string
  detect(queries: import('../../db/queries.js').QueryManager, moduleId: string, allModuleIds: string[]): Promise<DispatchPattern[]>
}
