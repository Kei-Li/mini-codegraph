import { MiniCodeGraph } from '../../index.js'
import { logInfo, logError } from '../../logger.js'

export async function handleExclude(action: string, pattern: string): Promise<void> {
  const projectRoot = process.cwd()
  const cg = MiniCodeGraph.open(projectRoot)
  if (!cg) {
    logError('No mini-codegraph database found. Run "mini-codegraph init" first.')
    process.exit(1)
  }

  switch (action) {
    case 'add':
      if (!pattern) { logError('Usage: mini-codegraph exclude add <pattern>'); process.exit(1) }
      cg.addExclude(pattern)
      logError(`Added exclude pattern: ${pattern}`)
      break
    case 'remove':
      if (!pattern) { logError('Usage: mini-codegraph exclude remove <pattern>'); process.exit(1) }
      cg.removeExclude(pattern)
      logError(`Removed exclude pattern: ${pattern}`)
      break
    case 'list':
      const excludes = cg.listExcludes()
      if (excludes.length === 0) {
        logInfo('No exclude patterns configured.')
      } else {
        logInfo('Exclude patterns:')
        for (const e of excludes) logInfo(`  ${e}`)
      }
      break
    default:
      logError('Unknown action. Use: add, remove, or list')
      process.exit(1)
  }

  cg.close()
}
