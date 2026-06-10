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
    {
      name: 'mini_cg_summary',
      description: 'Show project/workspace summary with overview of modules, entry points, frameworks, and key metrics',
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
        const allNodes = qm.getAllNodes()
        const entryPoints: unknown[] = []
        const externalSymbols = qm.getAllExternalSymbols()
        const languages = new Set(allNodes.map(n => n.language).filter(Boolean))
        const kindCounts = new Map<string, number>()
        for (const n of allNodes) {
          kindCounts.set(n.kind, (kindCounts.get(n.kind) || 0) + 1)
        }
        return {
          scope,
          projectRoot: graph.getProjectRoot(),
          stats,
          languages: [...languages],
          moduleCount: modules.length,
          modules: modules.map(m => ({ id: m.id, name: m.name, language: m.language, buildSystem: m.buildSystem })),
          symbolBreakdown: Object.fromEntries(kindCounts),
          entryPointCount: entryPoints.length,
          externalSymbolCount: externalSymbols.length,
        }
      },
    },
    {
      name: 'mini_cg_metrics',
      description: 'Compute code metrics including cyclomatic complexity hotspots, circular deps, dead imports, and hot paths',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Metric type: "complexity", "circular-deps", "dead-imports", "hot-paths", "all" (default)' },
          limit: { type: 'number', description: 'Max results (default: 20, max: 100)' },
        },
      },
      handler: async (args, graph) => {
        const metricType = typeof args.type === 'string' ? args.type : 'all'
        const rawLimit = typeof args.limit === 'number' ? args.limit : 20
        const limit = Math.min(rawLimit, 100)
        const result: Record<string, unknown> = {}

        if (metricType === 'all' || metricType === 'complexity') {
          const allNodes = graph.getQueries().getAllNodes()
          const funcNodes = allNodes.filter(n => ['function', 'method', 'constructor'].includes(n.kind))
          const complexities = funcNodes
            .map(n => ({ node: n, result: graph.getCyclomaticComplexity(n) }))
            .filter(x => x.result !== null)
            .sort((a, b) => (b.result?.complexity ?? 0) - (a.result?.complexity ?? 0))
            .slice(0, limit)
            .map(x => x.result)
          result.complexityHotspots = complexities
        }

        if (metricType === 'all' || metricType === 'circular-deps') {
          result.circularDeps = graph.findCircularDeps().slice(0, limit)
        }

        if (metricType === 'all' || metricType === 'dead-imports') {
          result.deadImports = graph.findDeadImports().slice(0, limit)
        }

        if (metricType === 'all' || metricType === 'hot-paths') {
          const allNodes = graph.getQueries().getAllNodes()
          const callerCounts = allNodes
            .map(n => ({ name: n.name, filePath: n.filePath, callers: graph.getCallers(n.id).length }))
            .filter(n => n.callers > 0)
            .sort((a, b) => b.callers - a.callers)
            .slice(0, limit)
          result.hotPaths = callerCounts
        }

        return result
      },
    },
    {
      name: 'mini_cg_search_files',
      description: 'Search files by path pattern, content keyword, or language. Faster than mini_cg_files for filtered queries.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern for file path (e.g. "src/**/*Controller*")' },
          language: { type: 'string', description: 'Filter by language (e.g. "java", "typescript", "python")' },
          limit: { type: 'number', description: 'Max results (default: 50, max: 500)' },
        },
      },
      handler: async (args, graph) => {
        const pattern = typeof args.pattern === 'string' ? args.pattern : undefined
        const language = typeof args.language === 'string' ? args.language : undefined
        const { limit: rawLimit } = args
        const safeLimit = Math.min(Math.max(1, rawLimit ?? 50), 500)
        let files = graph.getFileListing(pattern)
        if (language) {
          files = files.filter(f => f.language?.toLowerCase() === language.toLowerCase())
        }
        const items = files.slice(0, safeLimit)
        return {
          files: items,
          total: files.length,
          truncated: files.length > safeLimit,
        }
      },
    },
    {
      name: 'mini_cg_related_tests',
      description: 'Find test files related to a given source file or symbol. Shows both direct and transitive test relationships.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol name to find related tests for' },
          filePath: { type: 'string', description: 'Alternative: source file path' },
          minConfidence: { type: 'number', description: 'Minimum confidence threshold 0-1 (default: 0)' },
          limit: { type: 'number', description: 'Max results (default: 50, max: 500)' },
        },
      },
      handler: async (args, graph) => {
        const symbol = typeof args.symbol === 'string' ? args.symbol.slice(0, 200) : ''
        const filePath = typeof args.filePath === 'string' ? args.filePath.slice(0, 500) : ''
        const minConfidence = typeof args.minConfidence === 'number' ? Math.max(0, Math.min(1, args.minConfidence)) : 0
        const { limit: rawLimit } = args
        if (!symbol && !filePath) return { error: 'Either symbol or filePath is required' }
        const sourceFiles: string[] = []
        if (filePath) {
          sourceFiles.push(filePath)
        } else {
          const results = graph.search(symbol, 10)
          sourceFiles.push(...results.map(r => r.node.filePath).filter(Boolean))
        }
        if (sourceFiles.length === 0) return { error: 'No source files found' }
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
      name: 'mini_cg_recent_changes',
      description: 'Show recently changed files in the workspace. Lists files modified in recent git commits with author, timestamp, and commit message.',
      inputSchema: {
        type: 'object',
        properties: {
          maxCommits: { type: 'number', description: 'Max commits to scan (default: 30, max: 200)' },
          maxFiles: { type: 'number', description: 'Max changed files to return (default: 50, max: 500)' },
          since: { type: 'string', description: 'Date/ref since when (e.g. "7.days", "2024-01-01")' },
        },
      },
      handler: async (args, graph) => {
        const rawMaxCommits = typeof args.maxCommits === 'number' ? args.maxCommits : 30
        const rawMaxFiles = typeof args.maxFiles === 'number' ? args.maxFiles : 50
        const since = typeof args.since === 'string' ? args.since.slice(0, 50) : ''
        const maxCommits = Math.min(rawMaxCommits, 200)
        const maxFiles = Math.min(rawMaxFiles, 500)
        const projectRoot = graph.getProjectRoot()
        try {
          const sinceArg = since ? [`--since=${since}`] : []
          const output = execFileSync('git', [
            'log', '--name-only', '--pretty=format:%H|%an|%ae|%ai|%s',
            `--max-count=${maxCommits}`, ...sinceArg, '--relative',
          ], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()
          if (!output) return { changes: [], totalCommits: 0, totalFiles: 0 }
          const commits: { hash: string; author: string; email: string; date: string; message: string; files: string[] }[] = []
          const lines = output.split('\n')
          let currentCommit: { hash: string; author: string; email: string; date: string; message: string; files: string[] } | null = null
          for (const line of lines) {
            if (line.includes('|')) {
              if (currentCommit) commits.push(currentCommit)
              const parts = line.split('|')
              currentCommit = { hash: parts[0], author: parts[1], email: parts[2], date: parts[3], message: parts[4] || '', files: [] }
            } else if (line.trim() && currentCommit) {
              currentCommit.files.push(line.trim())
            }
          }
          if (currentCommit) commits.push(currentCommit)
          const allFiles = [...new Set(commits.flatMap(c => c.files))].slice(0, maxFiles)
          return { commits: commits.slice(0, maxCommits), totalCommits: commits.length, files: allFiles, totalFiles: allFiles.length }
        } catch (err) {
          const msg = (err as Error).message
          if (msg.includes('not a git repository')) return { error: 'Not a git repository' }
          return { error: `Git log failed: ${msg}` }
        }
      },
    },
    {
      name: 'mini_cg_unresolved_refs',
      description: 'List unresolved symbols references in the codebase — symbols that are referenced but not defined in any indexed file.',
      inputSchema: {
        type: 'object',
        properties: {
          moduleId: { type: 'string', description: 'Filter by module (optional)' },
          kind: { type: 'string', description: 'Filter by reference kind (optional)' },
          limit: { type: 'number', description: 'Max results (default: 50, max: 500)' },
        },
      },
      handler: async (args, graph) => {
        const qm = graph.getQueries()
        const { moduleId, kind, limit: rawLimit } = args
        const safeLimit = Math.min(Math.max(1, rawLimit ?? 50), 500)
        const allRefs = (qm.getUnresolvedRefs?.() ?? []) as { referenceName: string; kind: string; filePath: string; line: number; moduleId?: string }[]
        let filtered = allRefs as { referenceName: string; kind: string; filePath: string; line: number; moduleId?: string }[]
        if (moduleId) filtered = filtered.filter(r => r.moduleId === moduleId)
        if (kind) filtered = filtered.filter(r => r.kind === kind)
        const items = filtered.slice(0, safeLimit)
        return {
          unresolvedRefs: items.map(r => ({
            name: r.referenceName,
            kind: r.kind,
            filePath: r.filePath,
            line: r.line,
            moduleId: r.moduleId,
          })),
          total: filtered.length,
          truncated: filtered.length > safeLimit,
        }
      },
    },
    {
      name: 'mini_cg_export',
      description: 'Export code graph data in structured format (JSON, CSV, DOT) for external analysis tooling',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', description: 'Export format: "json" (default), "csv", "dot"' },
          scope: { type: 'string', description: 'Scope: "nodes" (default), "edges", "files", "all"' },
          moduleId: { type: 'string', description: 'Filter by module (optional)' },
          limit: { type: 'number', description: 'Max items (default: 1000, max: 10000)' },
        },
      },
      handler: async (args, graph) => {
        const format = typeof args.format === 'string' ? args.format : 'json'
        const scope = typeof args.scope === 'string' ? args.scope : 'nodes'
        const moduleId = typeof args.moduleId === 'string' ? args.moduleId : undefined
        const rawLimit = typeof args.limit === 'number' ? args.limit : 1000
        const limit = Math.min(rawLimit, 10000)
        const qm = graph.getQueries()

        if (format === 'csv') {
          if (scope === 'nodes' || scope === 'all') {
            let nodes = qm.getAllNodes()
            if (moduleId) nodes = nodes.filter(n => n.moduleId === moduleId)
            const items = nodes.slice(0, limit)
            const header = 'id,name,kind,qualifiedName,filePath,language,startLine,endLine,visibility'
            const rows = items.map(n => `${n.id},"${n.name}","${n.kind}","${n.qualifiedName}","${n.filePath}","${n.language}",${n.startLine},${n.endLine},"${n.visibility}"`)
            return { format, scope, data: [header, ...rows].join('\n'), total: items.length, truncated: nodes.length > limit }
          }
          if (scope === 'edges' || scope === 'all') {
            let edges = qm.getAllEdges()
            const items = edges.slice(0, limit)
            const header = 'source,target,kind,line,col'
            const rows = items.map(e => `"${e.sourceId}","${e.targetId}","${e.kind}",${e.line ?? 0},${e.col ?? 0}`)
            return { format, scope, data: [header, ...rows].join('\n'), total: items.length, truncated: edges.length > limit }
          }
        }

        if (format === 'dot') {
          const lines = ['digraph CodeGraph {', '  rankdir=LR;', '  node [shape=box, style=rounded];']
          let nodes = qm.getAllNodes()
          if (moduleId) nodes = nodes.filter(n => n.moduleId === moduleId)
          const nodeSlice = nodes.slice(0, limit)
          for (const n of nodeSlice) {
            const id = n.id.replace(/[^a-zA-Z0-9_]/g, '_')
            lines.push(`  "${id}" [label="${n.name}\\n${n.kind}"];`)
          }
          let edges = qm.getAllEdges()
          if (moduleId) edges = edges.filter(e => nodeSlice.some(n => n.id === e.sourceId))
          for (const e of edges.slice(0, limit * 2)) {
            const src = e.sourceId.replace(/[^a-zA-Z0-9_]/g, '_')
            const tgt = e.targetId.replace(/[^a-zA-Z0-9_]/g, '_')
            lines.push(`  "${src}" -> "${tgt}" [label="${e.kind}"];`)
          }
          lines.push('}')
          return { format, scope, data: lines.join('\n'), totalNodes: nodeSlice.length, totalEdges: edges.length }
        }

        const result: Record<string, unknown> = {}
        if (scope === 'nodes' || scope === 'all') {
          let nodes = qm.getAllNodes()
          if (moduleId) nodes = nodes.filter(n => n.moduleId === moduleId)
          result.nodes = nodes.slice(0, limit).map(n => ({
            id: n.id, name: n.name, kind: n.kind, qualifiedName: n.qualifiedName,
            filePath: n.filePath, language: n.language, startLine: n.startLine,
            endLine: n.endLine, signature: n.signature, visibility: n.visibility,
          }))
          result.nodesTotal = nodes.length
          result.nodesTruncated = nodes.length > limit
        }
        if (scope === 'edges' || scope === 'all') {
          let edges = qm.getAllEdges()
          result.edges = edges.slice(0, limit).map(e => ({
            source: e.sourceId, target: e.targetId, kind: e.kind,
            line: e.line, col: e.col, metadata: e.metadata,
          }))
          result.edgesTotal = edges.length
          result.edgesTruncated = edges.length > limit
        }
        if (scope === 'files' || scope === 'all') {
          let files = qm.getAllFiles()
          result.files = files.slice(0, limit).map(f => ({
            path: f.path, language: f.language, size: f.size, nodeCount: f.nodeCount,
          }))
          result.filesTotal = files.length
          result.filesTruncated = files.length > limit
        }
        return result
      },
    },
    {
      name: 'mini_cg_available_tools',
      description: 'List all available mini_cg_* tools with descriptions and input schemas. Use this to discover what the system can do.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Filter by category: "search", "navigation", "global", "architecture", "enterprise" (optional)' },
        },
      },
      handler: async (args, _graph) => {
        const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : ''
        const { createTools } = await import('../tools.js')
        const allTools = createTools()
        const categoryMap: Record<string, string[]> = {
          search: ['mini_cg_search', 'mini_cg_context', 'mini_cg_explore', 'mini_cg_semantic_search'],
          navigation: ['mini_cg_callers', 'mini_cg_callees', 'mini_cg_impact', 'mini_cg_backtrace', 'mini_cg_node', 'mini_cg_trace'],
          global: ['mini_cg_workspace_status', 'mini_cg_summary', 'mini_cg_metrics', 'mini_cg_module'],
          architecture: ['mini_cg_mermaid', 'mini_cg_architecture', 'mini_cg_dispatch', 'mini_cg_search_files', 'mini_cg_related_tests', 'mini_cg_recent_changes', 'mini_cg_unresolved_refs', 'mini_cg_export', 'mini_cg_available_tools'],
          enterprise: ['mini_cg_processes', 'mini_cg_rules', 'mini_cg_feign', 'mini_cg_mybatis', 'mini_cg_page_trace', 'mini_cg_service_trace'],
        }
        let matched = allTools
        if (filter) {
          const filterNames = categoryMap[filter] ?? []
          matched = allTools.filter(t => filterNames.includes(t.name))
        }
        return {
          toolCount: matched.length,
          totalTools: allTools.length,
          tools: matched.map(t => ({
            name: t.name,
            description: t.description,
            parameters: Object.keys(t.inputSchema.properties ?? {}),
          })),
        }
      },
    },
  ]
}
