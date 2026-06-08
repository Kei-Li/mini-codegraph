import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import type { ToolDefinition } from './shared.js'
import { createWorkspaceStatusHandler } from '../handlers/workspace-status.js'

export function createWorkspaceTools(): ToolDefinition[] {
  return [
    {
      name: 'mini_cg_files',
      description: 'List indexed files (supports glob)',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. "src/**/*.ts")' },
          includeMetadata: { type: 'boolean', description: 'Include node count (default: false)' },
          limit: { type: 'number', description: 'Max results (default: 50, max: 500)' },
        },
      },
      handler: async (args, graph) => {
        const pattern = typeof args.pattern === 'string' ? args.pattern.slice(0, 200) : undefined
        const includeMetadata = args.includeMetadata === true
        const { limit: rawLimit } = args
        const all = graph.getFileListing(pattern, rawLimit)
        const safeLimit = Math.min(Math.max(1, rawLimit ?? 50), 500)
        const items = all.slice(0, safeLimit)
        return {
          files: includeMetadata ? items : items.map(f => ({ path: f.path, language: f.language })),
          total: all.length, truncated: all.length > safeLimit,
        }
      },
    },
    {
      name: 'mini_cg_file_content',
      description: 'Read file contents (prefer knowledge graph tools over this)',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          maxLines: { type: 'number', description: 'Max lines to read (default: 200, max: 2000)' },
        },
        required: ['path'],
      },
      handler: async (args) => {
        const filePath = typeof args.path === 'string' ? args.path.slice(0, 500) : ''
        const maxLines = Math.min(typeof args.maxLines === 'number' ? args.maxLines : 200, 2000)
        if (!filePath) return { error: 'path required' }
        try {
          if (!existsSync(filePath)) return { error: `File not found: ${filePath}` }
          const content = readFileSync(filePath, 'utf-8')
          const lines = content.split('\n')
          const truncated = lines.length > maxLines
          return {
            path: filePath,
            lineCount: lines.length,
            content: lines.slice(0, maxLines).join('\n'),
            truncated,
            linesTruncated: truncated ? lines.length - maxLines : 0,
          }
        } catch (err) {
          return { error: `Failed to read file: ${(err as Error).message}` }
        }
      },
    },
    {
      name: 'mini_cg_status',
      description: 'Show index health, stats, and symbol breakdown',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: '"project" (default) or "workspace"' },
        },
      },
      handler: async (args, graph) => {
        const scope = typeof args.scope === 'string' ? args.scope : 'project'
        const qm = graph.getQueries()
        const stats = qm.getStats()
        const modules = qm.getAllModules()
        const nodes = qm.getAllNodes()
        const kinds = new Map<string, number>()
        for (const n of nodes) {
          kinds.set(n.kind, (kinds.get(n.kind) || 0) + 1)
        }
        const externalSymbols = qm.getAllExternalSymbols()
        return {
          scope,
          stats,
          modules: modules.map(m => ({ id: m.id, name: m.name, language: m.language, buildSystem: m.buildSystem })),
          symbolBreakdown: Object.fromEntries(kinds),
          workspaceExternalSymbols: externalSymbols.length,
          lastIndexed: stats.files > 0 ? new Date().toISOString() : 'Not indexed yet',
        }
      },
    },
    {
      name: 'mini_cg_module',
      description: 'List modules with file/node counts',
      inputSchema: {
        type: 'object',
        properties: {
          detail: { type: 'boolean', description: 'Include file/node counts (default: true)' },
        },
      },
      handler: async (args, graph) => {
        const detail = args.detail !== false
        const qm = graph.getQueries()
        const modules = qm.getAllModules()
        const stats = qm.getStats()
        if (!detail) {
          return { moduleCount: modules.length, modules: modules.map(m => ({ id: m.id, name: m.name, language: m.language })) }
        }
        const modulesWithStats = modules.map(m => {
          const files = qm.getFilesByModule(m.id)
          const nodes = qm.getAllNodes().filter(n => n.moduleId === m.id)
          return {
            id: m.id,
            name: m.name,
            language: m.language,
            buildSystem: m.buildSystem,
            rootPath: m.rootPath,
            fileCount: files.length,
            nodeCount: nodes.length,
          }
        })
        return {
          moduleCount: stats.modules ?? 0,
          totalFiles: stats.files ?? 0,
          totalNodes: stats.nodes ?? 0,
          totalEdges: stats.edges ?? 0,
          modules: modulesWithStats,
        }
      },
    },
    {
      name: 'mini_cg_processes',
      description: 'List Flowable BPMN processes with node/flow details',
      inputSchema: {
        type: 'object',
        properties: {
          moduleId: { type: 'string', description: 'Filter by module ID (optional)' },
          limit: { type: 'number', description: 'Max results (default: 50, max: 500)' },
        },
      },
      handler: async (args, graph) => {
        const qm = graph.getQueries()
        const { moduleId, limit: rawLimit } = args
        const safeLimit = Math.min(Math.max(1, rawLimit ?? 50), 500)
        const processes = moduleId
          ? qm.getFlowableProcessesByModule(moduleId)
          : qm.getAllFlowableProcesses()
        const items = processes.slice(0, safeLimit)
        return {
          processes: items.map(proc => {
            const pr = proc as { id: string; processId: string; name: string; isExecutable: number; version: string; filePath: string; moduleId: string }
            const nodes = qm.getFlowableNodesByProcess(pr.id) as { id: string; name: string; type: string; implementation: string; async: number }[]
            const flows = qm.getFlowableFlowsByProcess(pr.id) as { id: string; fromNode: string; toNode: string; conditionExpression: string }[]
            return {
              id: pr.id,
              processId: pr.processId,
              name: pr.name,
              isExecutable: !!pr.isExecutable,
              version: pr.version,
              filePath: pr.filePath,
              moduleId: pr.moduleId,
              nodeCount: nodes.length,
              flowCount: flows.length,
              nodes: nodes.map(n => ({
                id: n.id, name: n.name, type: n.type,
                implementation: n.implementation, async: n.async,
              })),
              flows: flows.map(f => ({
                from: f.fromNode, to: f.toNode,
                condition: f.conditionExpression,
              })),
            }
          }),
          total: processes.length, truncated: processes.length > safeLimit,
        }
      },
    },
    {
      name: 'mini_cg_rules',
      description: 'List Drools DRL rules with conditions and actions',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text search in rule name/condition/action' },
          moduleId: { type: 'string', description: 'Filter by module ID (optional)' },
          limit: { type: 'number', description: 'Max results (default: 50, max: 500)' },
          includeDetails: { type: 'boolean', description: 'Include when/then content (default: false)' },
        },
      },
      handler: async (args, graph) => {
        const qm = graph.getQueries()
        const { query: rawQuery, moduleId, limit: rawLimit, includeDetails } = args
        const safeLimit = Math.min(Math.max(1, rawLimit ?? 50), 500)
        const asRule = (r: unknown) => r as { id: string; ruleName: string; packageName: string; whenCondition: string; thenAction: string; salience?: string; activationGroup?: string; agendaGroup?: string }
        if (rawQuery) {
          const rules = qm.searchDroolsRules(rawQuery, moduleId)
          const items = rules.slice(0, safeLimit)
          return {
            rules: items.map(r => {
              const rr = asRule(r)
              return {
                id: rr.id, ruleName: rr.ruleName,
                whenCondition: includeDetails ? rr.whenCondition : rr.whenCondition.slice(0, 200),
                thenAction: includeDetails ? rr.thenAction : rr.thenAction.slice(0, 200),
              }
            }),
            total: rules.length, truncated: rules.length > safeLimit,
          }
        }
        const rules = moduleId
          ? qm.getDroolsRulesByModule(moduleId)
          : qm.getAllDroolsRules()
        const items = rules.slice(0, safeLimit)
        return {
          rules: items.map(r => {
            const rr = asRule(r)
            return {
              id: rr.id, ruleName: rr.ruleName, packageName: rr.packageName,
              whenCondition: includeDetails ? rr.whenCondition : rr.whenCondition.slice(0, 200),
              thenAction: includeDetails ? rr.thenAction : rr.thenAction.slice(0, 200),
              salience: rr.salience,
              activationGroup: rr.activationGroup,
              agendaGroup: rr.agendaGroup,
            }
          }),
          total: rules.length, truncated: rules.length > safeLimit,
        }
      },
    },
    {
      name: 'mini_cg_history',
      description: 'Analyze git history for a symbol or file — shows commit-by-commit changes, authors, and timestamps',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol name to trace (resolves to file path)' },
          filePath: { type: 'string', description: 'Explicit file path (alternative to symbol)' },
          maxCommits: { type: 'number', description: 'Max commits to return (default: 30, max: 200)' },
        },
      },
      handler: async (args, graph) => {
        const symbol = typeof args.symbol === 'string' ? args.symbol.slice(0, 200) : ''
        const filePath = typeof args.filePath === 'string' ? args.filePath.slice(0, 500) : ''
        const rawMax = typeof args.maxCommits === 'number' ? args.maxCommits : 30
        const maxCommits = Math.min(rawMax, 200)
        let resolvedPath = filePath
        if (!resolvedPath && symbol) {
          const results = graph.search(symbol, 5)
          if (results.length > 0 && results[0].node.filePath) {
            resolvedPath = results[0].node.filePath
          }
        }
        if (!resolvedPath) return { error: 'Either symbol or filePath is required' }
        if (!existsSync(resolvedPath)) return { error: `File not found: ${resolvedPath}` }
        try {
          const output = execFileSync('git', [
            'log', '--follow', `--format=%H|%an|%ae|%ai|%s`,
            `--max-count=${maxCommits}`, '--', resolvedPath,
          ], { cwd: dirname(resolvedPath), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()
          if (!output) {
            return { filePath: resolvedPath, symbol: symbol || undefined, commits: [], totalCommits: 0 }
          }
          const commits = output.split('\n').map(line => {
            const sep = line.indexOf('|')
            const sep2 = line.indexOf('|', sep + 1)
            const sep3 = line.indexOf('|', sep2 + 1)
            return {
              hash: line.slice(0, sep),
              author: line.slice(sep + 1, sep2),
              email: line.slice(sep2 + 1, sep3),
              date: line.slice(sep3 + 1, line.indexOf('|', sep3 + 1)),
              message: line.slice(line.indexOf('|', sep3 + 1) + 1) || '',
            }
          })
          return { filePath: resolvedPath, symbol: symbol || undefined, commits, totalCommits: commits.length }
        } catch (err) {
          const msg = (err as Error).message
          if (msg.includes('not a git repository')) return { error: 'Not a git repository', filePath: resolvedPath }
          return { error: `Git log failed: ${msg}`, filePath: resolvedPath }
        }
      },
    },
    {
      name: 'mini_cg_affected_tests',
      description: 'Find test files affected by changes to given source files, with confidence scoring',
      inputSchema: {
        type: 'object',
        properties: {
          sourceFiles: { type: 'array', items: { type: 'string' }, description: 'Source file paths that have changed' },
          minConfidence: { type: 'number', description: 'Minimum confidence threshold 0-1 (default: 0)' },
          limit: { type: 'number', description: 'Max results (default: 50, max: 500)' },
        },
        required: ['sourceFiles'],
      },
      handler: async (args, graph) => {
        const sourceFiles = Array.isArray(args.sourceFiles) ? args.sourceFiles.map((s: string) => s.slice(0, 500)) : []
        const minConfidence = typeof args.minConfidence === 'number' ? Math.max(0, Math.min(1, args.minConfidence)) : 0
        const { limit: rawLimit } = args
        if (sourceFiles.length === 0) return { error: 'sourceFiles is required', results: [], total: 0 }
        const all = graph.findAffectedTestFiles(sourceFiles)
        const filtered = minConfidence > 0 ? all.filter(r => r.confidence >= minConfidence) : all
        const safeLimit = Math.min(Math.max(1, rawLimit ?? 50), 500)
        const items = filtered.slice(0, safeLimit)
        return {
          sourceFiles,
          results: items.map(r => ({
            testFile: r.testFile,
            matchedSymbols: r.matchedSymbols,
            confidence: Math.round(r.confidence * 100) / 100,
          })),
          total: filtered.length,
          truncated: filtered.length > safeLimit,
        }
      },
    },
    {
      name: 'mini_cg_lint',
      description: 'Check architecture rules and layer violations. Enforces dependency rules defined in workspace config. (Feature coming in future release)',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Lint scope: "all" or module name' },
        },
      },
      handler: async () => {
        return { supported: false, note: 'Architecture lint checks can be configured via workspace.yml' }
      },
    },
    createWorkspaceStatusHandler(),
  ]
}
