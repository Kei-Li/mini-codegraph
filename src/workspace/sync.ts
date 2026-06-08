import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { QueryManager } from '../db/queries.js'
import { WorkspaceGraphBuilder } from './graph-builder.js'
import { WorkspaceScanner, type ScannedProject } from './scanner.js'
import { frameworkExtractor, type ExtractionOutput } from './extractors/frameworks.js'
import { SpringCloudExtractor } from './extractors/spring-cloud.js'
import { GatewayExtractor } from './extractors/gateway.js'
import { RabbitMQExtractor } from './extractors/rabbitmq.js'
import { RedisExtractor } from './extractors/redis.js'
import { DatabaseExtractor } from './extractors/database.js'
import { FrontendExtractor } from './extractors/frontend.js'
import { DatabaseMigrationExtractor } from './extractors/database-migration.js'
import { OpenApiExtractor } from './extractors/openapi.js'
import { FlowableExtractor } from './extractors/flowable.js'
import { DroolsExtractor } from './extractors/drools.js'
import { EnterpriseFrameworksExtractor } from './extractors/enterprise-frameworks.js'
import { JibExtractor } from './extractors/jib.js'
import { AzureDevOpsExtractor } from './extractors/azure-devops.js'
import { LiquibaseExtractor } from './extractors/liquibase.js'
import { CoverageExtractor } from './extractors/coverage.js'
import { extractDependencies } from './extractors/dependencies.js'
import { getGitChangedFiles } from '../utils.js'

export class WorkspaceSync {
  private scanner: WorkspaceScanner
  private graphBuilder: WorkspaceGraphBuilder
  private queries: QueryManager
  private currentService: string
  private projects: ScannedProject[] = []
  private hashCache = new Map<string, string>()

  constructor(queries: QueryManager, workspaceRoot: string, currentService: string) {
    this.scanner = new WorkspaceScanner(workspaceRoot)
    this.graphBuilder = new WorkspaceGraphBuilder(queries, currentService)
    this.queries = queries
    this.currentService = currentService

    frameworkExtractor.register(new SpringCloudExtractor())
    frameworkExtractor.register(new GatewayExtractor())
    frameworkExtractor.register(new RabbitMQExtractor())
    frameworkExtractor.register(new RedisExtractor())
    frameworkExtractor.register(new DatabaseExtractor())
    frameworkExtractor.register(new FrontendExtractor())
    frameworkExtractor.register(new DatabaseMigrationExtractor())
    frameworkExtractor.register(new OpenApiExtractor())
    frameworkExtractor.register(new FlowableExtractor())
    frameworkExtractor.register(new DroolsExtractor())
    frameworkExtractor.register(new EnterpriseFrameworksExtractor())
    frameworkExtractor.register(new JibExtractor())
    frameworkExtractor.register(new AzureDevOpsExtractor())
    frameworkExtractor.register(new LiquibaseExtractor())
    frameworkExtractor.register(new CoverageExtractor())

    // PluginExtractorLoader is available at ./extractors/plugin-loader.js for future use
    // Integration point: instantiate with dataDir, call scan() + runAll() in refresh()
  }

  private computeFileHash(filePath: string): string {
    try {
      const content = readFileSync(filePath, 'utf-8')
      return createHash('md5').update(content).digest('hex')
    } catch {
      return ''
    }
  }

  private hasProjectChanged(project: ScannedProject): boolean {
    // 1. Check git changes (fast path for source-level changes)
    const gitChanges = getGitChangedFiles(project.rootPath)
    if (gitChanges && (gitChanges.modified.length > 0 || gitChanges.added.length > 0 || gitChanges.deleted.length > 0)) {
      return true
    }

    // 2. Check config file hashes (pom.xml, build.gradle, etc.)
    const configFiles = ['pom.xml', 'build.gradle', 'package.json', 'application.yml', 'application.yaml', 'bootstrap.yml']
    for (const cf of configFiles) {
      const fp = join(project.rootPath, cf)
      if (existsSync(fp)) {
        const h = this.computeFileHash(fp)
        const key = `${project.name}:${cf}`
        const cached = this.hashCache.get(key)
        if (h && h !== cached) {
          this.hashCache.set(key, h)
          return true
        }
      }
    }

    return false
  }

  async refresh(onProgress?: (msg: string) => void): Promise<{ symbolsAdded: number; refsAdded: number }> {
    this.projects = this.scanner.scan()
    onProgress?.(`Found ${this.projects.length} projects`)

    const allProvides = new Map<string, ExtractionOutput['provides']>()
    const allConsumes = new Map<string, ExtractionOutput['consumes']>()

    for (const project of this.projects) {
      if (!this.hasProjectChanged(project)) {
        onProgress?.(`Skipping unchanged: ${project.name}`)
        continue
      }

      onProgress?.(`Extracting interfaces from ${project.name}`)
      const results = await frameworkExtractor.extractAll(project.rootPath, this.queries)

      const projectConsumes: ExtractionOutput['consumes'] = []
      for (const [, output] of results) {
        projectConsumes.push(...output.consumes)
        const existing = allProvides.get(project.name) || []
        allProvides.set(project.name, [...existing, ...output.provides])
      }
      allConsumes.set(project.name, projectConsumes)
    }

    onProgress?.('Building global graph...')
    this.graphBuilder.setCurrentService(this.currentService)
    const servicesToBuild = allConsumes.has(this.currentService)
      ? [this.currentService]
      : [...allConsumes.keys()]
    for (const svc of servicesToBuild) {
      this.graphBuilder.setCurrentService(svc)
      await this.graphBuilder.refreshExternalTables(allProvides, allConsumes.get(svc) || [])
    }

    // Extract and record inter-project dependencies from build files
    const projectNames = this.projects.map(p => p.name)
    for (const project of this.projects) {
      const deps = extractDependencies(project.rootPath, projectNames)
      for (const dep of deps) {
        this.queries.insertServiceDependency(
          project.name,
          dep.targetService,
          dep.dependencyType,
          0,
          'pom_gradle_parse',
          project.name
        )
      }
    }

    const stats = this.queries['db'].prepare('SELECT COUNT(*) as count FROM external_symbols').get() as { count: number }
    const refStats = this.queries['db'].prepare('SELECT COUNT(*) as count FROM external_references').get() as { count: number }

    return { symbolsAdded: stats?.count ?? 0, refsAdded: refStats?.count ?? 0 }
  }

  getProjects(): ScannedProject[] {
    return this.projects
  }

  getScanner(): WorkspaceScanner {
    return this.scanner
  }

  getGraphBuilder(): WorkspaceGraphBuilder {
    return this.graphBuilder
  }
}
