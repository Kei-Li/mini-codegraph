import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { relative, join } from 'node:path'
import { cpus } from 'node:os'
import type Parser from 'web-tree-sitter'
import type { DatabaseConnection } from '../../db/connection.js'
import type { QueryManager } from '../../db/queries.js'
import { DROP_FTS_TRIGGERS, CREATE_FTS_TRIGGERS, REBUILD_FTS } from '../../db/schema.js'
import { GrammarLoader } from './grammar-loader.js'
import { parseJavaFile } from '../languages/java.js'
import { parseTypeScriptFile } from '../languages/typescript.js'
import { parsePythonFile } from '../languages/python.js'
import { parseVueFile } from '../languages/vue.js'
import { parseKotlinFile } from '../languages/kotlin.js'
import { computeContentHash, languageForFile, validatePathWithinRoot } from '../../utils.js'
import type { MiniCodeGraphNode, ExtractionResult, ModuleInfo } from '../../types.js'
import type { WorkerResponse } from './worker-types.js'
import { extractFileAnnotations, parseAndStoreVueTemplates, runResolutionPipeline } from '../../resolution/index.js'
import { indexPiniaStores } from '../frontend/pinia-extractor.js'
import { indexReactComponents } from '../frontend/react-extractor.js'
import { indexGraphqlSchema } from '../middleware/graphql-schema-extractor.js'
import { indexCssClasses, indexHtmlElements } from '../frontend/frontend-assets-extractor.js'
import { runInlineExtractors } from './inline-extractors.js'
import { runPostProcessing, runMultiModulePostProcessing } from './post-processing.js'
import { indexTraces } from '../../graph/trace-analyzer.js'
import { WorkerPool } from './worker-pool.js'
import { FileScanner } from './file-scanner.js'
import { WriteQueue } from './write-queue.js'
import { logInfo, logWarn, logError } from '../../logger.js'

export class ExtractionOrchestrator {
  private grammarLoader: GrammarLoader
  private db: DatabaseConnection
  private queries: QueryManager
  private workerPool: WorkerPool = new WorkerPool()
  private parseTimeoutMs = 300000

  constructor(db: DatabaseConnection, queries: QueryManager) {
    this.db = db
    this.queries = queries
    this.grammarLoader = new GrammarLoader()
    this.workerPool.start(Math.max(1, cpus().length - 1))
  }

  async init(): Promise<void> {
    await this.grammarLoader.init()
  }

  async indexProject(projectRoot: string, moduleId?: string, excludePatterns?: string[], parallelModule?: boolean, fastMode = false): Promise<ExtractionResult> {
    return this.indexProjectStreaming(projectRoot, moduleId, excludePatterns, parallelModule, fastMode)
  }

  private async indexProjectStreaming(
    projectRoot: string,
    moduleId?: string,
    excludePatterns?: string[],
    parallelModule = false,
    fastMode = false,
  ): Promise<ExtractionResult> {
    const errors: string[] = []
    const startTime = Date.now()
    const mid = moduleId || 'default'
    const barWidth = 20

    // P2: Optimize SQLite for bulk insert
    this.db.optimizeForBulkInsert()

    // P1: Drop FTS triggers before bulk insert to avoid per-row trigger overhead
    this.db.exec(DROP_FTS_TRIGGERS)

    // Setup streaming pipeline
    const scanner = new FileScanner(projectRoot, excludePatterns)
    const knownFiles = this.queries.getAllFiles().map(f => ({ path: f.path, size: f.size, modifiedAt: f.modifiedAt }))
    scanner.setKnownFiles(knownFiles)

    const writeQueue = new WriteQueue(this.db, this.queries)
    scanner.setPressureFn(() => Math.max(this.workerPool.pressure, writeQueue.pressure))

    // Progress timer
    let progressTimer: ReturnType<typeof setInterval> | null = null
    const totalToIndex = scanner.size
    if (!parallelModule) {
      progressTimer = setInterval(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        const target = totalToIndex || 1
        const pct = writeQueue.fileCountSoFar / target
        const rate = writeQueue.fileCountSoFar > 0 ? (writeQueue.fileCountSoFar / ((Date.now() - startTime) / 1000)).toFixed(0) : '?'
        const filled = Math.round(pct * barWidth)
        const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled)
        process.stderr.write(`\r  [${bar}] ${(pct * 100).toFixed(1)}% ${writeQueue.fileCountSoFar}/${totalToIndex} ${elapsed}s ${rate}f/s`)
      }, 1000)
    }

    // Enable batch mode and start transaction (using safe transaction management)
    this.queries.enableBatchMode()
    this.db.beginTransaction()
    writeQueue.startAutoFlush()

    // Streaming pipeline
    try {
      for await (const relPath of scanner.scanWithSkip()) {
        const absPath = join(projectRoot, relPath)
        const lang = languageForFile(relPath)
        if (!lang || !['java', 'kotlin', 'typescript', 'python', 'vue'].includes(lang.name)) continue

        try {
          const msg = await this.workerPool.submit(
            relPath, absPath, lang.grammarName, lang.name, 300000,
          )

          if (msg.type !== 'parse-result') continue
          if (msg.error) {
            errors.push(`Worker error: ${relPath}: ${msg.error}`)
            continue
          }
          if (!msg.result || !msg.stat) {
            errors.push(`Worker returned incomplete result: ${relPath}`)
            continue
          }

          const result = msg.result
          const contentHash = msg.contentHash ?? ''
          const fileStat = msg.stat

          // Write nodes to batch mode
          for (const ni of result.nodes) {
            this.queries.insertNode({
              id: `${relPath}:${ni.name}:${ni.startLine}`,
              kind: ni.kind, name: ni.name,
              qualifiedName: ni.qualifiedName,
              filePath: relPath, language: lang.name,
              startLine: ni.startLine, endLine: ni.endLine,
              startColumn: ni.startColumn, endColumn: ni.endColumn,
              docstring: ni.docstring ?? '', signature: ni.signature ?? '',
              visibility: ni.visibility ?? 'public',
              isExported: ni.isExported ?? false,
              parentId: ni.parentId, moduleId: mid,
            })
          }
          for (const ei of result.edges) {
            this.queries.insertEdge(ei.source, ei.target, ei.kind, ei.metadata ?? '{}', ei.line, ei.col)
          }
          this.queries.upsertFile({
            path: relPath, contentHash, language: lang.name,
            size: fileStat.size, modifiedAt: fileStat.mtimeMs,
            indexedAt: Date.now(), nodeCount: result.nodes.length,
            moduleId: mid,
          })

          // On-demand source read for annotation/inline extractors
          const source = readFileSync(absPath, 'utf-8')
          if (source.includes('@')) {
            extractFileAnnotations(this.queries, source, relPath, mid, result.nodes.map(ni => ({
              id: `${relPath}:${ni.name}:${ni.startLine}`,
              name: ni.name,
              qualifiedName: ni.qualifiedName,
              filePath: relPath,
            })))
          }
          runInlineExtractors(this.queries, source, relPath, mid, projectRoot, lang.name, fastMode)
          if (lang.name === 'vue') {
            parseAndStoreVueTemplates(this.queries, source, relPath, mid)
          }

          writeQueue.push({ nodes: result.nodes.length, edges: result.edges.length })
        } catch (e) {
          errors.push(`${relPath}: ${e}`)
        }
      }

      writeQueue.flushSync()
    } catch (e) {
      this.db.rollbackTransaction()
      errors.push(`Batch transaction error: ${e}`)
    } finally {
      writeQueue.stop()
      if (progressTimer) clearInterval(progressTimer)
    }

    process.stderr.write('\n')

    // P1: Rebuild FTS triggers and rebuild FTS indexes
    this.rebuildFtsNow()

    // P2: Restore SQLite settings
    this.db.restoreAfterBulkInsert()

    const indexedCount = writeQueue.fileCountSoFar
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
    const avgRate = indexedCount > 0 ? (indexedCount / ((Date.now() - startTime) / 1000)).toFixed(0) : '?'
    process.stderr.write(`  Indexed ${indexedCount}/${totalToIndex} files in ${totalTime}s (${avgRate} files/s avg)\n`)

    if (errors.length > 0) {
      for (const err of errors.slice(0, 5)) {
        process.stderr.write(`  ⚠ ${err}\n`)
      }
      if (errors.length > 5) {
        process.stderr.write(`  ⚠ ...and ${errors.length - 5} more errors\n`)
      }
    }

    if (fastMode) {
      return { nodes: [], edges: [], errors }
    }

    await runPostProcessing(this.queries, projectRoot, mid, [])
    await this.runResolution(projectRoot, mid, [mid])

    if (errors.length > 0) {
      for (const err of errors) {
        process.stderr.write(`  ✗ ${err}\n`)
      }
    }
    process.stderr.write(`\n  ✓ Indexing complete: ${writeQueue.nodeCountSoFar} nodes, ${writeQueue.edgeCountSoFar} edges, ${errors.length} errors in ${totalTime}s\n`)
    return { nodes: [], edges: [], errors }
  }

  private async runResolution(projectRoot: string, mid: string, allModuleIds: string[]): Promise<void> {
    const heapLimit = process.memoryUsage().heapTotal
    const heapUsed = process.memoryUsage().heapUsed
    const usagePct = heapLimit > 0 ? heapUsed / heapLimit : 0
    if (usagePct > 0.7) {
      process.stderr.write(`  SKIP: memory usage ${(usagePct * 100).toFixed(0)}% of heap limit, skipping resolution pipeline\n`)
      return
    }

    process.stderr.write('Running resolution pipeline...\n')
    const resolvedRefs = await runResolutionPipeline(this.queries, projectRoot, mid, allModuleIds)
    if (resolvedRefs > 0) {
      process.stderr.write(`  Resolved ${resolvedRefs} cross-module references\n`)
    }

    const heapAfterResolution = process.memoryUsage().heapUsed
    const usageAfterPct = heapLimit > 0 ? heapAfterResolution / heapLimit : 0
    if (usageAfterPct > 0.7) {
      process.stderr.write(`  SKIP: memory usage ${(usageAfterPct * 100).toFixed(0)}% of heap limit, skipping dispatch inference\n`)
      return
    }

    const stats = this.queries.getStats()
    if (stats.nodes > 100000) {
      process.stderr.write(`  SKIP: database has ${stats.nodes} nodes (>100k threshold), skipping dispatch inference to avoid OOM\n`)
      return
    }

    process.stderr.write('Running dispatch inference...\n')
    try {
      const { DispatchInferenceEngine } = await import('../../resolution/dispatch-inference/index.js')
      const engine = new DispatchInferenceEngine(this.queries, projectRoot, mid, allModuleIds)
      const dispatchResult = await engine.run(0.3)
      if (dispatchResult.stats.totalEdges > 0) {
        process.stderr.write(`  Inferred ${dispatchResult.stats.totalEdges} dispatch edges across ${dispatchResult.stats.totalPatterns} patterns\n`)
      }
    } catch (e) {
      process.stderr.write(`  Dispatch inference skipped: ${e}\n`)
    }
  }

  /**
   * Rebuild FTS triggers and index synchronously.
   * Must be called outside of any active transaction.
   */
  private rebuildFtsNow(): void {
    process.stderr.write('  Rebuilding full-text search index...\n')
    try {
      this.db.exec(CREATE_FTS_TRIGGERS)
      this.db.exec(REBUILD_FTS)
      process.stderr.write('  Full-text search index rebuilt\n')
    } catch (e) {
      process.stderr.write(`  Full-text search index rebuild failed: ${e}\n`)
    }
  }

  async indexMultiModule(parentDir: string, excludePatterns?: string[], fastMode = false): Promise<ExtractionResult> {
    const errors: string[] = []
    const modules = await this.discoverModules(parentDir)

    if (modules.length === 0) {
      logInfo('No sub-modules found. Indexing as single project.')
      return this.indexProject(parentDir, 'default', excludePatterns, false, fastMode)
    }

    logInfo(`Found ${modules.length} sub-modules: ${modules.map(m => m.name).join(', ')}`)

    for (const mod of modules) {
      this.queries.insertModule(mod)
    }

    const allModuleIds = modules.map(m => m.id)
    let totalNodes = 0, totalEdges = 0

    // Index each module sequentially — all modules share the same DatabaseConnection,
    // so parallel indexing would cause "database is locked" errors and transaction conflicts.
    // Sequential indexing ensures each module's transaction cycle completes before the next starts.
    for (const mod of modules) {
      const r = await this.indexProject(mod.rootPath, mod.id, excludePatterns, true, fastMode)
      totalNodes += r.nodes.length
      totalEdges += r.edges.length
      errors.push(...r.errors)
    }

    // Multi-module post-processing runs after all modules are indexed
    logInfo('Running multi-module post-processing...')
    await runMultiModulePostProcessing(this.queries, parentDir, modules, allModuleIds)

    logInfo('Running cross-module resolution pipeline...')
    let totalCrossResolved = 0
    for (const mod of modules) {
      const resolved = await runResolutionPipeline(this.queries, parentDir, mod.id, allModuleIds)
      totalCrossResolved += resolved
    }
    if (totalCrossResolved > 0) {
      logInfo(`Resolved ${totalCrossResolved} cross-module references`)
    }

    logInfo('Running cross-module dispatch inference...')
    try {
      const { DispatchInferenceEngine } = await import('../../resolution/dispatch-inference/index.js')
      for (const mod of modules) {
        const engine = new DispatchInferenceEngine(this.queries, parentDir, mod.id, allModuleIds)
        const dispatchResult = await engine.run(0.3)
        if (dispatchResult.stats.totalEdges > 0) {
          logInfo(`  ${mod.name}: ${dispatchResult.stats.totalEdges} dispatch edges (${dispatchResult.stats.totalPatterns} patterns)`)
        }
      }
    } catch (e) {
      process.stderr.write(`  Dispatch inference skipped: ${e}\n`)
    }

    process.stderr.write('Building full traces (Vue→Gateway→Service→DB)...\n')
    const traces = indexTraces(this.queries, 'multi')
    if (traces.length > 0) {
      process.stderr.write(`  Built ${traces.length} full request traces\n`)
    }

    if (errors.length > 0) {
      for (const err of errors) {
        process.stderr.write(`  ✗ ${err}\n`)
      }
    }
    process.stderr.write(`\n  ✓ Multi-module indexing complete: ${totalNodes} nodes, ${totalEdges} edges, ${errors.length} errors\n`)
    return { nodes: [], edges: [], errors }
  }

  async indexFile(filePath: string, projectRoot: string, moduleId?: string, fastMode = false, skipDelete = false): Promise<ExtractionResult> {
    const validated = validatePathWithinRoot(projectRoot, filePath)
    if (!validated) return { nodes: [], edges: [], errors: [`Path rejected: ${filePath} is outside project root ${projectRoot}`] }
    filePath = validated

    const lang = languageForFile(filePath)
    if (!lang) return { nodes: [], edges: [], errors: [`Unsupported language: ${filePath}`] }

    if (lang.name === 'xml') {
      return { nodes: [], edges: [], errors: [] }
    }
    if (lang.name === 'yaml' || lang.name === 'properties') {
      return { nodes: [], edges: [], errors: [] }
    }
    if (lang.name === 'css') {
      const source = readFileSync(filePath, 'utf-8')
      const mid = moduleId || 'default'
      const relPath = relative(projectRoot, filePath).replace(/\\/g, '/')
      indexCssClasses(this.queries, source, relPath, mid)
      return { nodes: [], edges: [], errors: [] }
    }
    if (lang.name === 'html') {
      const source = readFileSync(filePath, 'utf-8')
      const mid = moduleId || 'default'
      const relPath = relative(projectRoot, filePath).replace(/\\/g, '/')
      indexHtmlElements(this.queries, source, relPath, mid)
      return { nodes: [], edges: [], errors: [] }
    }
    if (lang.name === 'graphql') {
      const source = readFileSync(filePath, 'utf-8')
      const mid = moduleId || 'default'
      const relPath = relative(projectRoot, filePath).replace(/\\/g, '/')
      indexGraphqlSchema(this.queries, source, relPath, mid)
      return { nodes: [], edges: [], errors: [] }
    }

    const mid = moduleId || 'default'

    let source!: string
    let parser!: Parser
    let tree!: Parser.Tree
    let stat!: import('node:fs').Stats
    let contentHash!: string
    let relPath!: string
    let useStrippedSource = false
    let strippedSource: string | undefined

    const parseWithRetry = async (attempt: number): Promise<{ parser: Parser; tree: Parser.Tree; source: string; stat: import('node:fs').Stats; contentHash: string; relPath: string }> => {
      if (!useStrippedSource) {
        source = readFileSync(filePath, 'utf-8')
      } else {
        source = strippedSource!
      }
      stat = statSync(filePath)
      relPath = relative(projectRoot, filePath).replace(/\\/g, '/')
      contentHash = computeContentHash(source)

      if (source.length > 5_242_880) {
        logWarn(`  File exceeds size limit: ${relPath} (${(source.length / 1024 / 1024).toFixed(1)}MB, limit 5MB)`)
        throw new Error(`File exceeds 5MB size limit (${(source.length / 1024 / 1024).toFixed(1)}MB)`)
      }

      if (attempt > 0) {
        this.grammarLoader.resetParser(lang.grammarName)
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      parser = await this.grammarLoader.loadGrammar(lang.grammarName)
      tree = parser.parse(source)

      if (!tree || !tree.rootNode) {
        throw new Error('Parse returned null tree')
      }

      return { parser, tree, source, stat, contentHash, relPath }
    }

    let parseAttempt = 0
    let useRegexFallback = false
    let parseError = ''
    while (true) {
      try {
        await parseWithRetry(parseAttempt)
        break
      } catch (e) {
        const errMsg = String(e)
        parseError = errMsg
        const isOom = errMsg.includes('out of memory') || errMsg.includes('OOM') || errMsg.includes('abort') || errMsg.includes('RuntimeError') || errMsg.includes('memory access out of bounds')

        // Tier 1: retry with fresh grammar (WASM heap reset)
        if (isOom && parseAttempt < 1) {
          parseAttempt++
          logError(`OOM on ${filePath}, retrying with fresh grammar (attempt ${parseAttempt})`)
          this.grammarLoader.resetParser(lang.grammarName)
          await new Promise(resolve => setTimeout(resolve, 200))
          continue
        }

        // Tier 2: retry with comments stripped (reduces WASM memory pressure)
        if (isOom && parseAttempt < 2 && !useStrippedSource) {
          parseAttempt++
          useStrippedSource = true
          strippedSource = source
            .split('\n')
            .map(line => /^\s*\/\//.test(line) ? '' : line)
            .join('\n')
          logError(`OOM on ${filePath}, retrying with comments stripped (attempt ${parseAttempt})`)
          this.grammarLoader.resetParser(lang.grammarName)
          await new Promise(resolve => setTimeout(resolve, 200))
          continue
        }

        // Tier 3: general retry for non-OOM errors
        if (parseAttempt < 2) {
          parseAttempt++
          logError(`Retry ${parseAttempt} for ${filePath}: ${errMsg.slice(0, 100)}`)
          await new Promise(resolve => setTimeout(resolve, 100))
          continue
        }

        // Exhausted retries — fall back to regex for supported languages
        if (lang.name === 'java') {
          logError(`Falling back to regex parser for ${filePath}`)
          useRegexFallback = true
          break
        }

        return { nodes: [], edges: [], errors: [`Error processing ${filePath}: ${errMsg}`] }
      }
    }

    let parseResult: { nodes: { id: string; kind: string; name: string; qualifiedName: string; startLine: number; endLine: number; startColumn: number; endColumn: number; parentId: string | null; visibility: string; isExported: boolean; docstring: string; signature: string; filePath: string; language: string; annotations?: { name: string; value: string }[] }[]; edges: { source: string; target: string; kind: string; line: number; col: number; metadata: string }[]; errors?: string[] }

    if (useRegexFallback) {
      const { parseJavaFileWithRegex } = await import('../languages/java.js')
      try {
        const fallbackSource = source || readFileSync(filePath, 'utf-8')
        const fbRelPath = relPath || relative(projectRoot, filePath).replace(/\\/g, '/')
        parseResult = parseJavaFileWithRegex(fallbackSource, fbRelPath, lang.name)
        parseResult.errors = [`Regex fallback used for ${filePath}: ${parseError}`]
      } catch (fbErr) {
        return { nodes: [], edges: [], errors: [`Error processing ${filePath}: ${parseError}; fallback also failed: ${fbErr}`] }
      }
    } else {
      parseResult = lang.name === 'java'
        ? parseJavaFile(tree, source, relPath, lang.name)
        : lang.name === 'python'
          ? parsePythonFile(tree, source, relPath, lang.name)
          : lang.name === 'vue'
            ? parseVueFile(parser, source, relPath, lang.name)
            : lang.name === 'kotlin'
              ? parseKotlinFile(source, relPath, parser, { language: 'kotlin', languageName: 'kotlin', namespaceDelimiter: '.', supportFullText: true })
              : parseTypeScriptFile(tree, source, relPath, lang.name)
    }

    // Ensure relPath is available for the rest of the function
    if (!relPath) {
      relPath = relative(projectRoot, filePath).replace(/\\/g, '/')
    }

    try {
      if (!skipDelete) this.queries.deleteNodesForFile(relPath)

      const nodeMap = new Map<string, MiniCodeGraphNode>()
      for (const ni of parseResult.nodes) {
        const node: MiniCodeGraphNode = {
          id: `${relPath}:${ni.name}:${ni.startLine}`,
          kind: ni.kind,
          name: ni.name,
          qualifiedName: ni.qualifiedName,
          filePath: relPath,
          language: lang.name,
          startLine: ni.startLine,
          endLine: ni.endLine,
          startColumn: ni.startColumn,
          endColumn: ni.endColumn,
          docstring: ni.docstring,
          signature: ni.signature,
          visibility: ni.visibility,
          isExported: ni.isExported,
          parentId: ni.parentId,
          moduleId: mid,
        }
        nodeMap.set(node.id, node)
        this.queries.insertNode(node)
      }

      for (const ei of parseResult.edges) {
        this.queries.insertEdge(ei.source, ei.target, ei.kind, ei.metadata, ei.line, ei.col)
      }

      this.queries.upsertFile({
        path: relPath,
        contentHash,
        language: lang.name,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        indexedAt: Date.now(),
        nodeCount: parseResult.nodes.length,
        moduleId: mid,
      })

      if (source.includes('@')) {
        extractFileAnnotations(this.queries, source, relPath, mid, parseResult.nodes.map(ni => ({
          id: `${relPath}:${ni.name}:${ni.startLine}`,
          name: ni.name,
          qualifiedName: ni.qualifiedName,
          filePath: relPath,
        })))
      }

      runInlineExtractors(this.queries, source, relPath, mid, projectRoot, lang.name, fastMode)

      if (lang.name === 'vue') {
        parseAndStoreVueTemplates(this.queries, source, relPath, mid)
        indexPiniaStores(this.queries, source, relPath, mid, projectRoot)
      }

      if (lang.name === 'typescript') {
        indexReactComponents(this.queries, source, relPath, mid)
      }

      return {
        nodes: parseResult.nodes.map(ni => ({
          id: `${relPath}:${ni.name}:${ni.startLine}`,
          kind: ni.kind,
          name: ni.name,
          qualifiedName: ni.qualifiedName,
          filePath: relPath,
          language: lang.name,
          startLine: ni.startLine,
          endLine: ni.endLine,
          startColumn: ni.startColumn,
          endColumn: ni.endColumn,
          docstring: ni.docstring,
          signature: ni.signature,
          visibility: ni.visibility,
          isExported: ni.isExported,
          parentId: ni.parentId,
          moduleId: mid,
        })),
        edges: parseResult.edges.map(e => ({ sourceId: e.source, targetId: e.target, kind: e.kind, metadata: e.metadata, line: e.line, col: e.col })),
        errors: [],
      }
    } catch (e) {
      return { nodes: [], edges: [], errors: [`Error processing ${filePath}: ${e}`] }
    }
  }

  async indexFileWorker(
    filePath: string,
    projectRoot: string,
    moduleId: string,
    storeToDb = true,
    fastMode = false,
    skipDelete = false,
  ): Promise<ExtractionResult> {
    const validated = validatePathWithinRoot(projectRoot, filePath)
    if (!validated) return { nodes: [], edges: [], errors: [`Path rejected: ${filePath} is outside project root ${projectRoot}`] }
    const absPath = validated
    const lang = languageForFile(absPath)
    if (!lang || !['java', 'kotlin', 'typescript', 'python', 'vue'].includes(lang.name)) {
      return { nodes: [], edges: [], errors: [] }
    }

    const handle = this.workerPool.acquireWorker()
    if (!handle) {
      return this.indexFile(absPath, projectRoot, moduleId, fastMode, skipDelete)
    }

    return new Promise((resolvePromise) => {
      const relPath = relative(projectRoot, absPath).replace(/\\/g, '/')
      const id = Math.random()
      const done = (result: ExtractionResult) => {
        this.workerPool.releaseWorker(handle.index)
        resolvePromise(result)
      }

      const timeoutId = setTimeout(async () => {
        handle.worker.off('message', handler)
        logWarn(`Worker timed out after ${this.parseTimeoutMs / 1000}s, falling back to main thread: ${relPath}`)
        done(await this.indexFile(absPath, projectRoot, moduleId, fastMode, skipDelete))
      }, this.parseTimeoutMs)

      const handler = (msg: WorkerResponse) => {
        if (msg.type !== 'parse-result' || msg.id !== id) return
        clearTimeout(timeoutId)
        if (msg.error) {
          done({ nodes: [], edges: [], errors: [`Worker error: ${msg.error}`] })
          return
        }

        const result = msg.result
        const fileStat = msg.stat
        const contentHash = msg.contentHash ?? ''

        if (!result || !fileStat) {
          done({ nodes: [], edges: [], errors: ['Worker returned incomplete result'] })
          return
        }

        try {
          if (storeToDb) {
            if (!skipDelete) this.queries.deleteNodesForFile(relPath)
            for (const ni of result.nodes) {
              this.queries.insertNode({
                id: `${relPath}:${ni.name}:${ni.startLine}`,
                kind: ni.kind, name: ni.name,
                qualifiedName: ni.qualifiedName,
                filePath: relPath, language: lang.name,
                startLine: ni.startLine, endLine: ni.endLine,
                startColumn: ni.startColumn, endColumn: ni.endColumn,
                docstring: ni.docstring ?? '', signature: ni.signature ?? '',
                visibility: ni.visibility ?? 'public',
                isExported: ni.isExported ?? false,
                parentId: ni.parentId, moduleId,
              })
            }
            for (const ei of result.edges) {
              this.queries.insertEdge(ei.source, ei.target, ei.kind, ei.metadata ?? '{}', ei.line, ei.col)
            }
            this.queries.upsertFile({
              path: relPath, contentHash, language: lang.name,
              size: fileStat.size, modifiedAt: fileStat.mtimeMs,
              indexedAt: Date.now(), nodeCount: result.nodes.length,
              moduleId,
            })
          }

          if (storeToDb) {
            let src = ''
            try { src = readFileSync(absPath, 'utf-8') } catch { /* best-effort */ }
            if (src.includes('@')) {
              extractFileAnnotations(this.queries, src, relPath, moduleId, result.nodes.map(ni => ({
                id: `${relPath}:${ni.name}:${ni.startLine}`,
                name: ni.name,
                qualifiedName: ni.qualifiedName,
                filePath: relPath,
              })))
            }
            runInlineExtractors(this.queries, src, relPath, moduleId, projectRoot, lang.name, fastMode)
            if (lang.name === 'vue') {
              parseAndStoreVueTemplates(this.queries, src, relPath, moduleId)
            }
          }

          done({
            nodes: result.nodes.map(ni => ({
              ...ni, id: `${relPath}:${ni.name}:${ni.startLine}`, filePath: relPath, language: lang.name, moduleId,
            })),
            edges: result.edges.map(e => ({ sourceId: e.source, targetId: e.target, kind: e.kind, metadata: e.metadata, line: e.line, col: e.col })),
            errors: [],
          })
        } catch (e) {
          done({ nodes: [], edges: [], errors: [`DB error: ${e}`] })
        }
      }

      handle.worker.on('message', handler)
      handle.worker.postMessage({
        type: 'parse',
        id,
        filePath: relPath,
        absolutePath: absPath,
        grammarName: lang.grammarName,
        language: lang.name,
      })
    })
  }

  stopWorkers(): void {
    this.workerPool.stop()
  }

  private async discoverModules(parentDir: string): Promise<ModuleInfo[]> {
    const modules: ModuleInfo[] = []
    const seen = new Set<string>()

    const tryAddModule = (dirPath: string, buildSystem: string) => {
      if (seen.has(dirPath)) return
      seen.add(dirPath)

      const name = dirPath.split(/[/\\]/).pop() || 'unknown'
      let language = 'java'

      if (existsSync(join(dirPath, 'package.json'))) {
        try {
          const pkg = JSON.parse(readFileSync(join(dirPath, 'package.json'), 'utf-8'))
          const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>
          if (deps.vue || deps.nuxt) language = 'vue'
          else if (deps.react || deps.next) language = 'typescript'
          else language = 'typescript'
        } catch (e) { logError(`Failed to parse package.json`, e) }
      }

      modules.push({
        id: name,
        name,
        rootPath: dirPath,
        buildSystem,
        language,
        indexedAt: Date.now(),
      })
    }

    const pomPath = join(parentDir, 'pom.xml')
    if (existsSync(pomPath)) {
      try {
        const content = readFileSync(pomPath, 'utf-8')
        const moduleRegex = /<module>([^<]+)<\/module>/g
        let m: RegExpExecArray | null
        while ((m = moduleRegex.exec(content)) !== null) {
          const modulePath = join(parentDir, m[1].trim())
          if (existsSync(modulePath)) {
            tryAddModule(modulePath, 'maven')
          }
        }
      } catch (e) { logError(`Failed to read pom.xml`, e) }
    }

    const settingsGradle = join(parentDir, 'settings.gradle')
    if (existsSync(settingsGradle)) {
      try {
        const content = readFileSync(settingsGradle, 'utf-8')
        const includeRegex = /include\s+['"]([^'"]+)['"]/g
        let m: RegExpExecArray | null
        while ((m = includeRegex.exec(content)) !== null) {
          const moduleName = m[1].trim().replace(/:/g, '/')
          const modulePath = join(parentDir, moduleName)
          if (existsSync(modulePath)) {
            tryAddModule(modulePath, 'gradle')
          }
        }
      } catch (e) { logError(`Failed to read settings.gradle`, e) }
    }

    const entries = readdirSync(parentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.mini-codegraph') continue
      const subPath = join(parentDir, entry.name)

      if (seen.has(subPath)) continue

      if (existsSync(join(subPath, 'pom.xml'))) {
        tryAddModule(subPath, 'maven')
      } else if (existsSync(join(subPath, 'build.gradle')) || existsSync(join(subPath, 'build.gradle.kts'))) {
        tryAddModule(subPath, 'gradle')
      } else if (existsSync(join(subPath, 'package.json'))) {
        tryAddModule(subPath, 'npm')
      }
    }

    return modules
  }
}
