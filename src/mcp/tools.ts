import type { ToolDefinition } from './tools/shared.js'
import { createSearchTools } from './tools/search.js'
import { createGraphTools } from './tools/graph.js'
import { createWorkspaceTools } from './tools/workspace.js'
import { createFrameworkTools } from './tools/framework.js'

export type { ToolDefinition }

export function createTools(): ToolDefinition[] {
  return [
    ...createSearchTools(),
    ...createGraphTools(),
    ...createWorkspaceTools(),
    ...createFrameworkTools(),
  ]
}
