import { readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { computeContentHash } from '../../utils.js'
import type { QueryManager } from '../../db/queries.js'
import type { ExtractionOrchestrator } from '../../extraction/orchestrator.js'
import type { ExtractionResult } from '../../types.js'
import { getGitChangedFiles } from '../../utils.js'

export class IncrementalIndexer {
  private queries: QueryManager
  private orchestrator: ExtractionOrchestrator
  private projectRoot: string

  constructor(queries: QueryManager, orchestrator: ExtractionOrchestrator, projectRoot: string) {
    this.queries = queries
    this.orchestrator = orchestrator
    this.projectRoot = projectRoot
  }

  async sync(): Promise<ExtractionResult> {
    const result: ExtractionResult = { nodes: [], edges: [], errors: [] }
    const gitChanges = getGitChangedFiles(this.projectRoot)

    if (gitChanges) {
      const trackedFiles = new Map(this.queries.getAllFiles().map(f => [f.path, f]))

      for (const filePath of gitChanges.deleted) {
        if (trackedFiles.has(filePath)) {
          this.queries.deleteNodesForFile(filePath)
        }
      }

      for (const filePath of [...gitChanges.modified, ...gitChanges.added]) {
        const fullPath = join(this.projectRoot, filePath)
        let content: string
        try {
          content = readFileSync(fullPath, 'utf-8')
        } catch { continue }

        const contentHash = computeContentHash(content)
        const tracked = trackedFiles.get(filePath)

        if (tracked && tracked.contentHash === contentHash) continue

        try {
          const fileResult = await this.orchestrator.indexFile(fullPath, this.projectRoot)
          result.nodes.push(...fileResult.nodes)
          result.edges.push(...fileResult.edges)
        } catch (e) {
          result.errors.push(`Error indexing ${filePath}: ${e}`)
        }
      }
      return result
    }

    const { scanDirectory } = await import('../../utils.js')
    const currentFiles = scanDirectory(this.projectRoot)
    const currentSet = new Set(currentFiles)
    const indexedFiles = this.queries.getAllFiles()
    const indexedMap = new Map(indexedFiles.map(f => [f.path, f]))

    for (const tracked of indexedFiles) {
      if (!currentSet.has(tracked.path) || !existsSync(join(this.projectRoot, tracked.path))) {
        this.queries.deleteNodesForFile(tracked.path)
      }
    }

    for (const filePath of currentFiles) {
      const fullPath = join(this.projectRoot, filePath)
      const tracked = indexedMap.get(filePath)

      if (tracked) {
        try {
          const stat = statSync(fullPath)
          if (stat.size === tracked.size && Math.floor(stat.mtimeMs) === Math.floor(tracked.modifiedAt)) continue
        } catch { continue }
      }

      let content: string
      try { content = readFileSync(fullPath, 'utf-8') } catch { continue }
      if (tracked && tracked.contentHash === computeContentHash(content)) continue

      try {
        const fileResult = await this.orchestrator.indexFile(fullPath, this.projectRoot)
        result.nodes.push(...fileResult.nodes)
        result.edges.push(...fileResult.edges)
      } catch (e) {
        result.errors.push(`Error indexing ${filePath}: ${e}`)
      }
    }

    return result
  }
}
