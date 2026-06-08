import type { GraphQueryManager } from '../../graph/queries.js'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, any>
  handler: (args: Record<string, any>, graph: GraphQueryManager) => Promise<any>
}

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 500
export const DESCR_WITH_LIMIT = ' (default: 50, max: 500)'
export const DESCR_WITH_OFFSET = 'Number of results to skip (default: 0)'

export function paginate<T>(items: T[], limit: number = DEFAULT_LIMIT, offset: number = 0): { items: T[]; total: number; truncated: boolean } {
  const safeLimit = Math.min(Math.max(1, limit), MAX_LIMIT)
  const safeOffset = Math.max(0, offset)
  return {
    items: items.slice(safeOffset, safeOffset + safeLimit),
    total: items.length,
    truncated: items.length > safeOffset + safeLimit,
  }
}
