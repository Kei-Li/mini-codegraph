import { join } from 'node:path'
import { existsSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { DatabaseConnection } from './db/connection.js'
import { QueryManager } from './db/queries.js'
import { ExtractionOrchestrator } from './extraction/orchestrator.js'
import { GraphQueryManager } from './graph/queries.js'
import { FileWatcher } from './sync/watcher.js'
import type { PendingFile } from './sync/watcher.js'
import type { ExtractionResult, ModuleInfo, FileRecord } from './types.js'
import { findFiles, loadGitignore, computeContentHash, scanDirectory, getGitChangedFiles, FileLock } from './utils.js'
import { detectRoutes } from './extraction/routes.js'
import { detectSpring } from './resolution/frameworks/java.js'
import { detectVue } from './resolution/frameworks/vue.js'
import { findMulitModuleProjects } from './resolution/frameworks/java.js'

export class MiniCodeGraph {
  private db: DatabaseConnection
  private queries: QueryManager
  private orchestrator: ExtractionOrchestrator
  private graphManager: GraphQueryManager
  private watcher: FileWatcher | null = null
  private projectRoot: string
  private dataDir: string
  private daemonMode = false
  private multiModule = false
  private moduleIds: string[] = []

  constructor(projectRoot: string, dbPath?: string) {
    this.projectRoot = projectRoot
    this.dataDir = join(projectRoot, '.mini-codegraph')
    const resolvedDbPath = dbPath ?? join(this.dataDir, 'mini-cg.db')

    this.db = new DatabaseConnection(resolvedDbPath)
    this.db.open()
    this.queries = new QueryManager(this.db)
    this.orchestrator = new ExtractionOrchestrator(this.db, this.queries)
    this.graphManager = new GraphQueryManager(this.queries, projectRoot)
  }

  static init(projectRoot: string, indexNow = false): MiniCodeGraph {
    const cg = new MiniCodeGraph(projectRoot)
    return cg
  }

  static initMultiModule(parentDir: string): { cg: MiniCodeGraph; modules: ModuleInfo[] } {
    const cg = new MiniCodeGraph(parentDir)
    const moduleDirs = findMulitModuleProjects(parentDir)

    const modules: ModuleInfo[] = moduleDirs.map((dir: string) => {
      const name = dir.split(/[/\\]/).pop() || 'unknown'
      let language = 'java'
      let buildSystem = 'unknown'

      if (existsSync(join(dir, 'pom.xml'))) buildSystem = 'maven'
      else if (existsSync(join(dir, 'build.gradle'))) buildSystem = 'gradle'
      else if (existsSync(join(dir, 'package.json'))) {
        buildSystem = 'npm'
        try {
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
          const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>
          if (deps.vue || deps.nuxt) language = 'vue'
          else language = 'typescript'
        } catch {}
      }

      return { id: name, name, rootPath: dir, buildSystem, language, indexedAt: 0 }
    })

    if (modules.length === 0) {
      console.error('No sub-projects found. Use init() for single project.')
      return { cg, modules: [] }
    }

    for (const mod of modules) {
      cg.queries.insertModule(mod)
    }

    cg.multiModule = true
    cg.moduleIds = modules.map(m => m.id)

    return { cg, modules }
  }

  static open(projectRoot: string): MiniCodeGraph | null {
    const dbPath = join(projectRoot, '.mini-codegraph', 'mini-cg.db')
    if (!existsSync(dbPath)) return null
    return new MiniCodeGraph(projectRoot, dbPath)
  }

  static findProjectRoot(startPath: string): string | null {
    let current = startPath
    while (true) {
      if (existsSync(join(current, '.mini-codegraph', 'mini-cg.db'))) return current
      const parent = join(current, '..')
      if (parent === current) return null
      current = parent
    }
  }

  async index(): Promise<ExtractionResult> {
    await this.orchestrator.init()
    return this.orchestrator.indexProject(this.projectRoot)
  }

  async indexMultiModule(): Promise<ExtractionResult> {
    await this.orchestrator.init()
    return this.orchestrator.indexMultiModule(this.projectRoot)
  }

  async sync(): Promise<ExtractionResult> {
    await this.orchestrator.init()
    const lock = new FileLock(join(this.dataDir, 'sync.lock'))
    return lock.withLockAsync(async () => {
    const result: ExtractionResult = { nodes: [], edges: [], errors: [] }

    const gitChanges = getGitChangedFiles(this.projectRoot)

    if (gitChanges) {
      // Fast path: git status --porcelain
      const trackedFiles = new Map(this.queries.getAllFiles().map(f => [f.path, f]))

      for (const filePath of gitChanges.deleted) {
        const tracked = trackedFiles.get(filePath)
        if (tracked) {
          this.queries.deleteNodesForFile(filePath)
          result.edges.push() // placeholder for counting
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

    // Fallback: full filesystem scan (non-git project or git failure)
    const currentFiles = scanDirectory(this.projectRoot)
    const currentSet = new Set(currentFiles)
    const indexedFiles = this.queries.getAllFiles()
    const indexedMap = new Map(indexedFiles.map(f => [f.path, f]))

    // Removals
    for (const tracked of indexedFiles) {
      if (!currentSet.has(tracked.path) || !existsSync(join(this.projectRoot, tracked.path))) {
        this.queries.deleteNodesForFile(tracked.path)
      }
    }

    // Adds / modifications
    for (const filePath of currentFiles) {
      const fullPath = join(this.projectRoot, filePath)
      const tracked = indexedMap.get(filePath)

      // Stat pre-filter (size + mtime)
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

      try {
        const fileResult = await this.orchestrator.indexFile(fullPath, this.projectRoot)
        result.nodes.push(...fileResult.nodes)
        result.edges.push(...fileResult.edges)
      } catch (e) {
        result.errors.push(`Error indexing ${filePath}: ${e}`)
      }
    }

    return result
    })
  }

  async indexFile(filePath: string): Promise<ExtractionResult> {
    await this.orchestrator.init()
    return this.orchestrator.indexFile(filePath, this.projectRoot)
  }

  getGraph(): GraphQueryManager {
    return this.graphManager
  }

  getWatcher(): FileWatcher | null {
    return this.watcher
  }

  getPendingFiles(): PendingFile[] {
    return this.watcher?.getPendingFiles() ?? []
  }

  getProjectRoot(): string {
    return this.projectRoot
  }

  getModules(): ModuleInfo[] {
    return this.queries.getAllModules()
  }

  getRoutes() {
    return detectRoutes(this.projectRoot, this.queries, this.graphManager)
  }

  getFrameworks(): string[] {
    const frameworks: string[] = []
    const spring = detectSpring(this.projectRoot)
    if (spring) frameworks.push(spring.name)

    const parentDir = this.projectRoot
    const moduleDirs = findMulitModuleProjects(parentDir)
    for (const dir of moduleDirs) {
      const subSpring = detectSpring(dir)
      if (subSpring && !frameworks.includes(subSpring.name)) frameworks.push(subSpring.name)
      const subVue = detectVue(dir)
      if (subVue && !frameworks.includes(subVue.name)) frameworks.push(subVue.name)
    }

    const vue = detectVue(this.projectRoot)
    if (vue) frameworks.push(vue.name)

    return frameworks
  }

  enableDaemon(): void {
    this.daemonMode = true

    this.watcher = new FileWatcher(
      this.projectRoot,
      async () => {
        const startTime = Date.now()
        const result = await this.sync()
        return {
          filesChanged: result.nodes.length + (result.errors.length > 0 ? 1 : 0),
          durationMs: Date.now() - startTime,
        }
      }
    )

    this.watcher.start()
  }

  close(): void {
    this.watcher?.stop()
    this.db.close()
  }
}
