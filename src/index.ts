import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { DatabaseConnection } from './db/connection.js'
import { QueryManager } from './db/queries.js'
import { ExtractionOrchestrator } from './extraction/core/orchestrator.js'
import { GraphQueryManager } from './graph/queries.js'
import { FileWatcher } from './sync/watcher.js'
import type { PendingFile } from './sync/watcher.js'
import type { ExtractionResult, ModuleInfo } from './types.js'
import { syncProject } from './sync/sync-service.js'
import { detectRoutes } from './extraction/core/routes.js'
import { detectSpring } from './resolution/frameworks/java.js'
import { detectVue } from './resolution/frameworks/vue.js'
import { findMultiModuleProjects } from './resolution/frameworks/java.js'
import { FileLock } from './utils.js'

export interface ProjectConfig {
  exclude: string[]
  workspace?: string
}

const DEFAULT_CONFIG: ProjectConfig = { exclude: [] }

export class MiniCodeGraph {
  private db: DatabaseConnection
  private queries: QueryManager
  private orchestrator: ExtractionOrchestrator
  private graphManager: GraphQueryManager
  private watcher: FileWatcher | null = null
  private projectRoot: string
  private dataDir: string
  private config: ProjectConfig
  private static signalRegistered = false
  private static instances = new Set<MiniCodeGraph>()
  private lock: FileLock

  constructor(projectRoot: string, dbPath?: string, readonly = false) {
    this.projectRoot = projectRoot
    this.dataDir = join(projectRoot, '.mini-codegraph')
    const resolvedDbPath = dbPath ?? join(this.dataDir, 'mini-codegraph.db')

    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true })
    }
    this.lock = new FileLock(join(this.dataDir, 'mini-codegraph.lock'))
    if (!readonly) this.lock.acquire()

    try {
      this.db = new DatabaseConnection(resolvedDbPath)
      this.db.open()
      this.queries = new QueryManager(this.db)
      this.orchestrator = new ExtractionOrchestrator(this.db, this.queries)
      this.graphManager = new GraphQueryManager(this.queries, projectRoot)
      this.config = this.loadConfig()

      MiniCodeGraph.instances.add(this)
      MiniCodeGraph.registerSignalHandlers()
    } catch (e) {
      if (!readonly) this.lock.release()
      throw e
    }
  }

  private static registerSignalHandlers(): void {
    if (MiniCodeGraph.signalRegistered) return
    MiniCodeGraph.signalRegistered = true
    const handleSignal = () => {
      for (const instance of MiniCodeGraph.instances) {
        instance.close()
      }
      process.exit(0)
    }
    process.on('SIGINT', handleSignal)
    process.on('SIGTERM', handleSignal)
  }

  static init(projectRoot: string, _indexNow = false, workspace?: string): MiniCodeGraph {
    const cg = new MiniCodeGraph(projectRoot)
    cg.ensureConfig()
    if (workspace) {
      cg.config.workspace = workspace
      cg.saveConfig()
    }
    return cg
  }

  private configPath(): string {
    return join(this.dataDir, 'workspace.yml')
  }

  private ensureConfig(): void {
    if (!existsSync(this.configPath())) {
      this.config = { ...DEFAULT_CONFIG }
      this.saveConfig()
    }
  }

  private loadConfig(): ProjectConfig {
    try {
      const cp = this.configPath()
      if (!existsSync(cp)) return { ...DEFAULT_CONFIG }
      return JSON.parse(readFileSync(cp, 'utf-8'))
    } catch { return { ...DEFAULT_CONFIG } }
  }

  private saveConfig(): void {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true })
    writeFileSync(this.configPath(), JSON.stringify(this.config, null, 2))
  }

  addExclude(pattern: string): void {
    if (!this.config.exclude.includes(pattern)) {
      this.config.exclude.push(pattern)
      this.saveConfig()
    }
  }

  removeExclude(pattern: string): void {
    this.config.exclude = this.config.exclude.filter(p => p !== pattern)
    this.saveConfig()
  }

  listExcludes(): string[] {
    return [...this.config.exclude]
  }

  static initMultiModule(parentDir: string): { cg: MiniCodeGraph; modules: ModuleInfo[] } {
    const cg = new MiniCodeGraph(parentDir)
    const moduleDirs = findMultiModuleProjects(parentDir)

    const modules: ModuleInfo[] = moduleDirs.map((dir: string) => {
      const name = dir.split(/[/\\]/).pop() || 'unknown'
      let language = 'java'
      let buildSystem = 'unknown'

      if (existsSync(join(dir, 'pom.xml'))) buildSystem = 'maven'
      else if (existsSync(join(dir, 'build.gradle'))) buildSystem = 'gradle'
      else if (existsSync(join(dir, 'package.json'))) buildSystem = 'npm'

      // Detect language from package.json regardless of build system
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
          const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>
          if (deps.vue || deps.nuxt) language = 'vue'
          else if (deps.react || deps['react-dom'] || deps.next) language = 'typescript'
          else if (buildSystem === 'npm') language = 'typescript'
        } catch { /* silent */ }
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

    return { cg, modules }
  }

  static open(projectRoot: string, readonly = false): MiniCodeGraph | null {
    const dbPath = join(projectRoot, '.mini-codegraph', 'mini-codegraph.db')
    if (!existsSync(dbPath)) return null
    return new MiniCodeGraph(projectRoot, dbPath, readonly)
  }

  static findProjectRoot(startPath: string): string | null {
    let current = startPath
    while (true) {
      if (existsSync(join(current, '.mini-codegraph', 'mini-codegraph.db'))) return current
      const parent = join(current, '..')
      if (parent === current) return null
      current = parent
    }
  }

  async index(excludePatterns?: string[], fastMode = false): Promise<ExtractionResult> {
    await this.orchestrator.init()
    const patterns = [...(this.config.exclude ?? []), ...(excludePatterns ?? [])]
    return this.orchestrator.indexProject(this.projectRoot, undefined, patterns, false, fastMode)
  }

  async indexMultiModule(excludePatterns?: string[], fastMode = false): Promise<ExtractionResult> {
    await this.orchestrator.init()
    const patterns = [...(this.config.exclude ?? []), ...(excludePatterns ?? [])]
    return this.orchestrator.indexMultiModule(this.projectRoot, patterns, fastMode)
  }

  async sync(): Promise<ExtractionResult> {
    return syncProject(this.queries, this.orchestrator, this.projectRoot, this.dataDir)
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
    return detectRoutes(this.projectRoot, this.queries)
  }

  getFrameworks(): string[] {
    const frameworks: string[] = []
    const spring = detectSpring(this.projectRoot)
    if (spring) frameworks.push(spring.name)

    const parentDir = this.projectRoot
    const moduleDirs = findMultiModuleProjects(parentDir)
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

  async initWorkspace(workspaceRoot: string): Promise<{ symbolsAdded: number; refsAdded: number }> {
    const { WorkspaceSync } = await import('./workspace/sync.js')
    const serviceName = this.projectRoot.split(/[/\\]/).filter(Boolean).pop() || 'default'
    const sync = new WorkspaceSync(this.queries, workspaceRoot, serviceName)
    return sync.refresh()
  }

  getServiceConsumers(serviceName: string): { service: string; refs: { symbolId: string; referenceType: string; sourceLocation: string }[] }[] {
    return this.graphManager.getServiceConsumers(serviceName)
  }

  getServiceDependencies(serviceName: string): { service: string; refs: { symbolId: string; referenceType: string }[] }[] {
    return this.graphManager.getServiceDependencies(serviceName)
  }

  getServiceDependencyGraph(): { nodes: { name: string; provides: number }[]; edges: { from: string; to: string; types: string[] }[] } {
    return this.graphManager.getServiceDependencyGraph()
  }

  findWorkspaceCircularDeps(): { cycle: string[] }[] {
    return this.graphManager.findWorkspaceCircularDeps()
  }

  close(): void {
    this.orchestrator.stopWorkers()
    this.watcher?.stop()
    this.db.close()
    this.lock.release()
  }
}
