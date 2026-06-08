import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { MiniCodeGraph } from '../../index.js'
import { logInfo, logError } from '../../logger.js'

export async function handleInit(path: string, options: { index?: boolean; yes?: boolean; multiModule?: boolean; exclude?: string; workspace?: string; fast?: boolean }): Promise<void> {
  const resolvedPath = resolve(path)
  const excludePatterns = options.exclude?.split(',').map(s => s.trim()).filter(Boolean)
  const fastMode = options.fast === true

  if (options.multiModule) {
    const { cg, modules } = MiniCodeGraph.initMultiModule(resolvedPath)
    if (modules.length === 0) {
      logError(`No sub-modules found in ${resolvedPath}`)
      process.exit(1)
    }

    logInfo(`Initialized multi-module mini-codegraph for ${resolvedPath}`)
    logInfo(`Found ${modules.length} sub-modules:`)
    for (const mod of modules) {
      logInfo(`  [${mod.language}] ${mod.name} (${mod.buildSystem}) — ${mod.rootPath}`)
    }

    if (options.index) {
      logInfo('Indexing all modules...')
      const result = await cg.indexMultiModule(excludePatterns, fastMode)
      const stats = cg.getGraph().getStats()
      logInfo(`Indexed ${stats.modules} modules, ${stats.files} files, ${stats.nodes} nodes, ${stats.edges} edges`)
      if (result.errors.length > 0) {
        logError(`Errors: ${result.errors.length}`)
        for (const err of result.errors.slice(0, 5)) {
          logError(`  ${err}`)
        }
      }

      const workspaceRoot = options.workspace ? resolve(options.workspace) : undefined
      if (workspaceRoot) {
        logInfo('Running cross-module resolution pipeline...')
        const wsResult = await cg.initWorkspace(workspaceRoot)
        logInfo(`Workspace: ${wsResult.symbolsAdded} external symbols, ${wsResult.refsAdded} references`)
      }
    }

    cg.close()
    return
  }

  const workspaceRoot = options.workspace ? resolve(options.workspace) : undefined
  const cg = MiniCodeGraph.init(resolvedPath, false, workspaceRoot)
  logInfo(`Initialized mini-codegraph for ${resolvedPath}`)
  if (workspaceRoot) {
    logInfo(`Workspace root: ${workspaceRoot}`)
  }

  if (options.index) {
    logInfo('Indexing...')
    await cg.index(excludePatterns, fastMode)
    const stats = cg.getGraph().getStats()
    logInfo(`Indexed ${stats.files} files, ${stats.nodes} nodes, ${stats.edges} edges`)

    if (workspaceRoot) {
      logInfo('Scanning workspace projects and extracting interfaces...')
      const wsResult = await cg.initWorkspace(workspaceRoot)
      logInfo(`Workspace: ${wsResult.symbolsAdded} external symbols, ${wsResult.refsAdded} references`)
    }
  }

  cg.close()
}

export async function handleSync(path: string, options: { gitHooks?: boolean }): Promise<void> {
  const resolvedPath = resolve(path)

  if (options.gitHooks) {
    const { installGitSyncHook } = await import('../../sync/git-hooks.js')
    const result = installGitSyncHook(resolvedPath)
    if (result.installed.length > 0) {
      logInfo(`Git sync hooks installed: ${result.installed.join(', ')}`)
    } else {
      logError(result.skipped ?? 'No git repository found or hooks already installed.')
    }
    return
  }

  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) {
    logError('No index found. Run init + index first.')
    process.exit(1)
  }

  const syncResult = await cg.sync()
  logInfo(JSON.stringify({
    new_nodes: syncResult.nodes.length,
    new_edges: syncResult.edges.length,
    errors: syncResult.errors.length,
  }, null, 2))

  cg.close()
}

export function handleModules(path: string): void {
  const resolvedPath = resolve(path)
  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) {
    logError('No index found.')
    process.exit(1)
  }

  const modules = cg.getModules()
  logInfo(JSON.stringify({ modules, count: modules.length }, null, 2))
  cg.close()
}

export function handleExport(path: string, options: { output?: string; pretty?: boolean }): void {
  const resolvedPath = resolve(path)
  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) {
    console.error('No index found.')
    process.exit(1)
  }

  const graph = cg.getGraph()
  const qm = graph.getQueries()
  const nodes = qm.getAllNodes()
  const edges = qm.getAllEdges()
  const exportData = { nodes, edges, exportedAt: new Date().toISOString() }
  const json = options.pretty ? JSON.stringify(exportData, null, 2) : JSON.stringify(exportData)

  if (options.output) {
    const outPath = resolve(options.output)
    writeFileSync(outPath, json, 'utf-8')
    logInfo(`Exported ${nodes.length} nodes, ${edges.length} edges to ${outPath}`)
  } else {
    logInfo(json)
  }

  cg.close()
}
