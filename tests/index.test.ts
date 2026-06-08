import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../src/extraction/core/orchestrator.js', () => {
  class MockExtractionOrchestrator {
    constructor(db: any, queries: any) {}
    async init() {}
    async indexProject() { return { nodes: [], edges: [], errors: [] } }
    async indexFile() { return { nodes: [], edges: [], errors: [] } }
    async indexMultiModule() { return { nodes: [], edges: [], errors: [] } }
    stopWorkers() {}
  }
  return {
    ExtractionOrchestrator: MockExtractionOrchestrator,
    EXTRACTOR_GUARDS: {},
    sourceIncludesAny: (s: string, kw: string[]) => kw.some(k => s.includes(k)),
    shouldRunExtractor: () => true,
  }
})

import { MiniCodeGraph } from '../src/index.js'
import { DatabaseConnection } from '../src/db/connection.js'
import { QueryManager } from '../src/db/queries.js'
import type { ModuleInfo } from '../src/types.js'

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mini-cg-test-'))
}

function createTempProject(root: string): void {
  const dbDir = join(root, '.mini-codegraph')
  mkdirSync(dbDir, { recursive: true })
  writeFileSync(join(dbDir, 'mini-codegraph.db'), '')
}

describe('MiniCodeGraph', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createTempDir()
  })

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* silent */ }
  })

  describe('static methods', () => {
    it('init creates instance and ensures config', () => {
      const cg = MiniCodeGraph.init(tmpDir)
      expect(cg).toBeInstanceOf(MiniCodeGraph)
      expect(cg.getProjectRoot()).toBe(tmpDir)
      expect(existsSync(join(tmpDir, '.mini-codegraph', 'workspace.yml'))).toBe(true)
      cg.close()
    })

    it('open returns null when no DB exists', () => {
      const cg = MiniCodeGraph.open(tmpDir)
      expect(cg).toBeNull()
    })

    it('open returns instance when DB exists', () => {
      const first = MiniCodeGraph.init(tmpDir)
      first.close()
      const cg = MiniCodeGraph.open(tmpDir)
      expect(cg).toBeInstanceOf(MiniCodeGraph)
      cg.close()
    })

    it('findProjectRoot returns null when no .mini-codegraph', () => {
      const result = MiniCodeGraph.findProjectRoot(tmpDir)
      expect(result).toBeNull()
    })

    it('findProjectRoot finds root with .mini-codegraph', () => {
      createTempProject(tmpDir)
      const result = MiniCodeGraph.findProjectRoot(tmpDir)
      expect(result).toBe(tmpDir)
    })

    it('findProjectRoot walks up directories', () => {
      mkdirSync(join(tmpDir, 'sub', 'deep'), { recursive: true })
      createTempProject(tmpDir)
      const result = MiniCodeGraph.findProjectRoot(join(tmpDir, 'sub', 'deep'))
      expect(result).toBe(tmpDir)
    })
  })

  describe('config management', () => {
    it('addExclude adds and persists pattern', () => {
      const cg = MiniCodeGraph.init(tmpDir)
      cg.addExclude('**/test/**')
      expect(cg.listExcludes()).toContain('**/test/**')

      const config = JSON.parse(readFileSync(join(tmpDir, '.mini-codegraph', 'workspace.yml'), 'utf-8'))
      expect(config.exclude).toContain('**/test/**')
      cg.close()
    })

    it('removeExclude removes pattern', () => {
      const cg = MiniCodeGraph.init(tmpDir)
      cg.addExclude('**/test/**')
      cg.addExclude('**/generated/**')
      cg.removeExclude('**/test/**')
      expect(cg.listExcludes()).not.toContain('**/test/**')
      expect(cg.listExcludes()).toContain('**/generated/**')
      cg.close()
    })

    it('addExclude does not duplicate', () => {
      const cg = MiniCodeGraph.init(tmpDir)
      cg.addExclude('pattern')
      cg.addExclude('pattern')
      expect(cg.listExcludes().filter(p => p === 'pattern').length).toBe(1)
      cg.close()
    })
  })

  describe('getters', () => {
    it('getGraph returns GraphQueryManager', () => {
      const cg = MiniCodeGraph.init(tmpDir)
      expect(cg.getGraph()).toBeDefined()
      expect(typeof cg.getGraph().search).toBe('function')
      cg.close()
    })

    it('getProjectRoot returns correct path', () => {
      const cg = MiniCodeGraph.init(tmpDir)
      expect(cg.getProjectRoot()).toBe(tmpDir)
      cg.close()
    })

    it('getModules returns empty list for single module', () => {
      const cg = MiniCodeGraph.init(tmpDir)
      expect(cg.getModules()).toEqual([])
      cg.close()
    })

    it('getWatcher returns null when daemon not enabled', () => {
      const cg = MiniCodeGraph.init(tmpDir)
      expect(cg.getWatcher()).toBeNull()
      cg.close()
    })

    it('getPendingFiles returns empty when no watcher', () => {
      const cg = MiniCodeGraph.init(tmpDir)
      expect(cg.getPendingFiles()).toEqual([])
      cg.close()
    })
  })

  describe('initMultiModule', () => {
    it('returns empty modules when no sub-projects', () => {
      const { cg, modules } = MiniCodeGraph.initMultiModule(tmpDir)
      expect(modules).toEqual([])
      expect(cg).toBeInstanceOf(MiniCodeGraph)
      cg.close()
    })

    it('detects Maven modules declared in parent pom.xml', () => {
      mkdirSync(join(tmpDir, 'module-a'), { recursive: true })
      writeFileSync(join(tmpDir, 'pom.xml'), '<project><modules><module>module-a</module></modules></project>')
      writeFileSync(join(tmpDir, 'module-a', 'pom.xml'), '<project><artifactId>module-a</artifactId></project>')

      const { cg, modules } = MiniCodeGraph.initMultiModule(tmpDir)
      expect(modules.length).toBeGreaterThanOrEqual(1)
      const mod = modules.find(m => m.name === 'module-a')
      expect(mod).toBeDefined()
      expect(mod!.buildSystem).toBe('maven')
      expect(mod!.language).toBe('java')
      cg.close()
    })

    it('detects Gradle modules declared in settings.gradle', () => {
      mkdirSync(join(tmpDir, 'web-app'), { recursive: true })
      writeFileSync(join(tmpDir, 'settings.gradle'), 'include "web-app"')
      writeFileSync(join(tmpDir, 'web-app', 'build.gradle'), '')
      writeFileSync(join(tmpDir, 'web-app', 'package.json'), JSON.stringify({ dependencies: { vue: '^3.0.0' } }))

      const { cg, modules } = MiniCodeGraph.initMultiModule(tmpDir)
      const mod = modules.find(m => m.name === 'web-app')
      expect(mod).toBeDefined()
      expect(mod!.buildSystem).toBe('gradle')
      expect(mod!.language).toBe('vue')
      cg.close()
    })
  })

  describe('getFrameworks', () => {
    it('returns empty array for non-Spring project', () => {
      const cg = MiniCodeGraph.init(tmpDir)
      const frameworks = cg.getFrameworks()
      expect(Array.isArray(frameworks)).toBe(true)
      cg.close()
    })
  })

  describe('close', () => {
    it('can be called multiple times', () => {
      const cg = MiniCodeGraph.init(tmpDir)
      expect(() => cg.close()).not.toThrow()
      expect(() => cg.close()).not.toThrow()
    })
  })
})
