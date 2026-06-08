import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { ExtractionOrchestrator } from '../extraction/core/orchestrator.js'
import type { QueryManager } from '../db/queries.js'
import type { ExtractionResult } from '../types.js'
import { computeContentHash, scanDirectory, getGitChangedFiles, FileLock } from '../utils.js'
import { logWarn } from '../logger.js'

export async function syncProject(
  queries: QueryManager,
  orchestrator: ExtractionOrchestrator,
  projectRoot: string,
  dataDir: string,
): Promise<ExtractionResult> {
  await orchestrator.init()
  const lock = new FileLock(join(dataDir, '.lock'))
  return lock.withLockAsync(async () => {
    const result: ExtractionResult = { nodes: [], edges: [], errors: [] }

    const gitChanges = getGitChangedFiles(projectRoot)

    if (gitChanges) {
      const trackedFiles = new Map(queries.getAllFiles().map(f => [f.path, f]))

      for (const filePath of gitChanges.deleted) {
        const tracked = trackedFiles.get(filePath)
        if (tracked) {
          queries.deleteNodesForFile(filePath)
          result.edges.push()
        }
      }

      for (const filePath of [...gitChanges.modified, ...gitChanges.added]) {
        const fullPath = join(projectRoot, filePath)
        let content: string
        try {
          content = readFileSync(fullPath, 'utf-8')
        } catch { continue }

        const contentHash = computeContentHash(content)
        const tracked = trackedFiles.get(filePath)

        if (tracked && tracked.contentHash === contentHash) continue

        try {
          const fileResult = await orchestrator.indexFile(fullPath, projectRoot)
          result.nodes.push(...fileResult.nodes)
          result.edges.push(...fileResult.edges)
        } catch (e) {
          result.errors.push(`Error indexing ${filePath}: ${e}`)
        }
      }

      return result
    }

    const currentFiles = scanDirectory(projectRoot)
    const currentSet = new Set(currentFiles)
    const indexedFiles = queries.getAllFiles()
    const indexedMap = new Map(indexedFiles.map(f => [f.path, f]))

    for (const tracked of indexedFiles) {
      if (!currentSet.has(tracked.path) || !existsSync(join(projectRoot, tracked.path))) {
        queries.deleteNodesForFile(tracked.path)
      }
    }

    for (const filePath of currentFiles) {
      const fullPath = join(projectRoot, filePath)
      const tracked = indexedMap.get(filePath)

      if (tracked) {
        try {
          const stat = statSync(fullPath)
          if (stat.size === tracked.size && Math.floor(stat.mtimeMs) === Math.floor(tracked.modifiedAt)) {
            continue
          }
        } catch { continue }
      }

      let content: string
      try {
        content = readFileSync(fullPath, 'utf-8')
      } catch { continue }

      const contentHash = computeContentHash(content)

      if (tracked && tracked.contentHash === contentHash) continue

      if (content.length > 5_242_880) {
        logWarn(`File exceeds size limit: ${filePath} (${(content.length / 1024 / 1024).toFixed(1)}MB, limit 5MB)`)
        result.errors.push(`Skipped large file: ${filePath} (${(content.length / 1024 / 1024).toFixed(1)}MB)`)
        continue
      }

      try {
        const fileResult = await orchestrator.indexFile(fullPath, projectRoot)
        result.nodes.push(...fileResult.nodes)
        result.edges.push(...fileResult.edges)
      } catch (e) {
        result.errors.push(`Error indexing ${filePath}: ${e}`)
      }
    }

    return result
  })
}
