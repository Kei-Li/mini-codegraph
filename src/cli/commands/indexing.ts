import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import { MiniCodeGraph } from '../../index.js'
import { logInfo, logError } from '../../logger.js'

export async function handleIndex(path: string, options: { force?: boolean; changed?: boolean; multiModule?: boolean; exclude?: string; json?: boolean; progress?: boolean; fast?: boolean }): Promise<void> {
  const resolvedPath = resolve(path)
  const excludePatterns = options.exclude?.split(',').map(s => s.trim()).filter(Boolean)
  const fastMode = options.fast === true

  if (options.changed) {
    if (!MiniCodeGraph.findProjectRoot(resolvedPath)) {
      logError(`Error: no .mini-codegraph/ database found in ${resolvedPath}. Run 'mini-codegraph init <path>' first.`)
      process.exit(1)
    }
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      logError(`No index found at ${resolvedPath}. Run 'mini-codegraph init <path> --index' first.`)
      process.exit(1)
    }
    const result = await cg.sync()
    if (options.json) {
      logInfo(JSON.stringify({
        new_nodes: result.nodes.length,
        new_edges: result.edges.length,
        errors: result.errors.length,
      }, null, 2))
    } else {
      logError(`Synced ${result.nodes.length} new nodes, ${result.edges.length} new edges`)
    }
    cg.close()
    return
  }

  if (options.multiModule) {
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      const { cg: newCg, modules } = MiniCodeGraph.initMultiModule(resolvedPath)
      if (modules.length === 0) {
        logError('No sub-modules found.')
        process.exit(1)
      }
      const result = await newCg.indexMultiModule(excludePatterns, fastMode)
      const stats = newCg.getGraph().getStats()
      logInfo(JSON.stringify({
        modules: stats.modules,
        files_indexed: stats.files,
        nodes: stats.nodes,
        edges: stats.edges,
        errors: result.errors.length,
      }, null, 2))
      newCg.close()
      return
    }

    const result = await cg.indexMultiModule(excludePatterns, fastMode)
    const stats = cg.getGraph().getStats()
    console.log(JSON.stringify({
      modules: stats.modules,
      files_indexed: stats.files,
      nodes: stats.nodes,
      edges: stats.edges,
      errors: result.errors.length,
    }, null, 2))
    cg.close()
    return
  }

  const projectRoot = MiniCodeGraph.findProjectRoot(resolvedPath)
  if (!projectRoot) {
    if (!['pom.xml', 'build.gradle', 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'CMakeLists.txt'].some(f => existsSync(join(resolvedPath, f)))) {
      logError(`Error: ${resolvedPath} does not appear to be a valid project root (no .mini-codegraph/ or known build file found).`)
      logError('Run `mini-codegraph init <path>` first, or specify the correct project root.')
      process.exit(1)
    }
  }

  const cg = projectRoot ? MiniCodeGraph.open(projectRoot)! : MiniCodeGraph.init(resolvedPath)
  const result = await cg.index(excludePatterns, fastMode)

  const stats = cg.getGraph().getStats()
    logInfo(JSON.stringify({
      files_indexed: stats.files,
      nodes: stats.nodes,
      edges: stats.edges,
      errors: result.errors.length,
    }, null, 2))

  if (result.errors.length > 0) {
    logError('Errors:')
    for (const err of result.errors.slice(0, 10)) {
      logError(`  ${err}`)
    }
  }

  cg.close()
}
