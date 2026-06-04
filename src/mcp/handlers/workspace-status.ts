import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDefinition } from '../tools.js'
import type { QueryManager } from '../../db/queries.js'

interface WorkspaceStatusHandlerOptions {
  queries?: QueryManager
  workspaceRoot?: string
}

export function createWorkspaceStatusHandler(opts?: WorkspaceStatusHandlerOptions): ToolDefinition {
  return {
    name: 'mini_cg_workspace_status',
    description: 'View all projects in the workspace and their detected frameworks and interface usage.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (args, graph) => {
      const queries = opts?.queries ?? graph.getQueries()
      const workspaceRoot = opts?.workspaceRoot

      const externalSymbols = queries.getAllExternalSymbols()
      const externalRefs = queries.getAllExternalReferences()

      let projects: { name: string; rootPath?: string; providesCount: number; consumesCount: number }[] = []

      if (workspaceRoot && existsSync(workspaceRoot)) {
        const { WorkspaceScanner } = await import('../../workspace/scanner.js')
        const scanner = new WorkspaceScanner(workspaceRoot)
        const scanned = scanner.scan()
        projects = scanned.map(p => ({
          name: p.name,
          rootPath: p.rootPath,
          providesCount: externalSymbols.filter(s => s.serviceName === p.name).length,
          consumesCount: externalRefs.filter(r => {
            const sc = r.serviceName ?? ''
            return sc === p.name || r.sourceSymbol.includes(p.name)
          }).length,
        }))
      } else {
        const serviceMap = new Map<string, { provides: number; consumes: number }>()
        for (const s of externalSymbols) {
          const key = s.serviceName ?? 'unknown'
          if (!serviceMap.has(key)) serviceMap.set(key, { provides: 0, consumes: 0 })
          serviceMap.get(key)!.provides++
        }
        for (const r of externalRefs) {
          const key = r.serviceName ?? 'unknown'
          if (!serviceMap.has(key)) serviceMap.set(key, { provides: 0, consumes: 0 })
          serviceMap.get(key)!.consumes++
        }
        projects = [...serviceMap.entries()].map(([name, counts]) => ({
          name,
          providesCount: counts.provides,
          consumesCount: counts.consumes,
        }))
      }

      return {
        totalProjects: projects.length,
        totalExternalSymbols: externalSymbols.length,
        totalExternalReferences: externalRefs.length,
        projects,
      }
    },
  }
}
