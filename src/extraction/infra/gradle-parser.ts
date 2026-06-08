import type { QueryManager } from '../../db/queries.js'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface GradleModule {
  name: string
  dirPath: string
  dependencies: GradleDependency[]
  isRoot: boolean
}

export interface GradleDependency {
  group: string
  artifact: string
  version: string
  configuration: string
  isProject: boolean
}

export function parseSettingsGradle(content: string): string[] {
  const modules: string[] = []
  const incRe = /include(?:\(\s*)?\n?([^)]*?)\)?/gs
  let m: RegExpExecArray | null
  while ((m = incRe.exec(content)) !== null) {
    const block = m[1]
    const quoteRe = /["']([^"']+)["']/g
    let qm: RegExpExecArray | null
    while ((qm = quoteRe.exec(block)) !== null) {
      modules.push(qm[1].replace(/:/g, '/'))
    }
  }
  return modules
}

export function parseBuildGradleKts(content: string, _moduleDir: string): GradleDependency[] {
  const deps: GradleDependency[] = []
  const depBlockMatch = content.match(/dependencies\s*\{([^}]*)\}/s)
  if (!depBlockMatch) return deps

  const depBlock = depBlockMatch[1]
  const depRe = /(\w+)\s*\(\s*["']([^:]+):([^:]+):([^"']*)["']\s*\)/g
  let dm: RegExpExecArray | null
  while ((dm = depRe.exec(depBlock)) !== null) {
    const config = dm[1]
    const group = dm[2]
    const artifact = dm[3]
    const version = dm[4] || ''
    deps.push({
      group,
      artifact,
      version,
      configuration: config,
      isProject: config === 'project' || group === 'project',
    })
  }

  const projRe = /(\w+)\s*\(\s*project\(["']:?([^"']+)["']\)\)/g
  let pm: RegExpExecArray | null
  while ((pm = projRe.exec(depBlock)) !== null) {
    deps.push({
      group: 'project',
      artifact: pm[2].replace(/:/g, '-'),
      version: '',
      configuration: pm[1],
      isProject: true,
    })
  }

  return deps
}

export function parseBuildGradle(content: string): GradleDependency[] {
  const deps: GradleDependency[] = []
  const depBlockMatch = content.match(/dependencies\s*\{([^}]*)\}/s)
  if (!depBlockMatch) return deps

  const depBlock = depBlockMatch[1]
  const depRe = /(\w+)\s+['"]([^:]+):([^:]+):([^"']*)['"]/g
  let dm: RegExpExecArray | null
  while ((dm = depRe.exec(depBlock)) !== null) {
    const config = dm[1]
    const group = dm[2]
    const artifact = dm[3]
    const version = dm[4] || ''
    deps.push({ group, artifact, version, configuration: config, isProject: false })
  }

  const projRe = /(\w+)\s+project\(['"]:?([^'"]+)['"]\)/g
  let pm: RegExpExecArray | null
  while ((pm = projRe.exec(depBlock)) !== null) {
    deps.push({ group: 'project', artifact: pm[2].replace(/:/g, '-'), version: '', configuration: pm[1], isProject: true })
  }

  return deps
}

export function indexGradleModules(
  queries: QueryManager,
  projectRoot: string,
  moduleId: string,
): GradleModule[] {
  const modules: GradleModule[] = []

  const settingsGradle = join(projectRoot, 'settings.gradle')
  const settingsGradleKts = join(projectRoot, 'settings.gradle.kts')
  let settingsContent: string | null = null
  let usesKts = false

  if (existsSync(settingsGradleKts)) {
    settingsContent = readFileSync(settingsGradleKts, 'utf-8')
    usesKts = true
  } else if (existsSync(settingsGradle)) {
    settingsContent = readFileSync(settingsGradle, 'utf-8')
  }

  const rootDeps: GradleDependency[] = []
  const rootBuildFile = usesKts
    ? join(projectRoot, 'build.gradle.kts')
    : join(projectRoot, 'build.gradle')
  if (existsSync(rootBuildFile)) {
    const rootBuildContent = readFileSync(rootBuildFile, 'utf-8')
    const rootParsed = usesKts
      ? parseBuildGradleKts(rootBuildContent, projectRoot)
      : parseBuildGradle(rootBuildContent)
    rootDeps.push(...rootParsed)
  }

  modules.push({
    name: projectRoot.split(/[/\\]/).pop() || 'root',
    dirPath: projectRoot,
    dependencies: rootDeps,
    isRoot: true,
  })

  const rootId = `gradle:${projectRoot.replace(/[/\\]/g, '-')}:root`
  queries.insertNode({
    id: rootId,
    kind: 'module',
    name: modules[0].name,
    qualifiedName: `gradle:root:${modules[0].name}`,
    filePath: usesKts ? settingsGradleKts : settingsGradle,
    language: 'gradle',
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
    docstring: 'Gradle root project',
    signature: `project ${modules[0].name}`,
    visibility: 'public', isExported: true, parentId: null, moduleId,
  })

  for (const dep of rootDeps) {
    if (dep.isProject) continue
    const depId = `gradle:${dep.group}:${dep.artifact}`
    queries.insertNode({
      id: depId, kind: 'package', name: dep.artifact,
      qualifiedName: `${dep.group}:${dep.artifact}`,
      filePath: rootBuildFile, language: 'gradle',
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
      docstring: `Gradle dependency ${dep.group}:${dep.artifact}:${dep.version}`,
      signature: `${dep.configuration}("${dep.group}:${dep.artifact}:${dep.version}")`,
      visibility: 'public', isExported: false, parentId: null, moduleId,
    })
    queries.insertEdge(rootId, depId, 'gradle_depends_on',
      JSON.stringify({ group: dep.group, artifact: dep.artifact, version: dep.version, configuration: dep.configuration }),
      1, 0)
  }

  if (settingsContent) {
    const subModules = parseSettingsGradle(settingsContent)
    for (const sub of subModules) {
      const subPath = join(projectRoot, sub)
      if (!existsSync(subPath)) continue
      const subBuild = usesKts ? join(subPath, 'build.gradle.kts') : join(subPath, 'build.gradle')
      const subDeps: GradleDependency[] = []
      if (existsSync(subBuild)) {
        const subContent = readFileSync(subBuild, 'utf-8')
        subDeps.push(...(usesKts ? parseBuildGradleKts(subContent, subPath) : parseBuildGradle(subContent)))
      }

      const subName = sub.split('/').pop() || sub
      modules.push({ name: subName, dirPath: subPath, dependencies: subDeps, isRoot: false })
      const subId = `gradle:${subName}`
      queries.insertNode({
        id: subId, kind: 'module', name: subName,
        qualifiedName: `gradle:sub:${subName}`,
        filePath: subBuild, language: 'gradle',
        startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
        docstring: `Gradle sub-module ${subName}`,
        signature: `project(":${subName}")`,
        visibility: 'public', isExported: true, parentId: null, moduleId,
      })
      queries.insertEdge(rootId, subId, 'gradle_submodule', JSON.stringify({ path: sub }), 1, 0)

      for (const dep of subDeps) {
        if (dep.isProject) {
          const targetModule = modules.find(m => m.name === dep.artifact)
          if (targetModule) {
            const targetId = `gradle:${targetModule.name}`
            const depId = `gradle:project:${dep.artifact}`
            queries.insertNode({
              id: depId, kind: 'package', name: dep.artifact,
              qualifiedName: `project:${dep.artifact}`,
              filePath: subBuild, language: 'gradle',
              startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
              docstring: `Project reference :${dep.artifact}`,
              signature: `project(":${dep.artifact}")`,
              visibility: 'public', isExported: false, parentId: null, moduleId,
            })
            queries.insertEdge(subId, depId, 'gradle_depends_on',
              JSON.stringify({ group: 'project', artifact: dep.artifact, isProject: true }), 1, 0)
            queries.insertEdge(depId, targetId, 'gradle_project_ref', '{}', 1, 0)
          }
        } else {
          const depId = `gradle:${dep.group}:${dep.artifact}`
          queries.insertNode({
            id: depId, kind: 'package', name: dep.artifact,
            qualifiedName: `${dep.group}:${dep.artifact}`,
            filePath: subBuild, language: 'gradle',
            startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
            docstring: `Gradle dependency ${dep.group}:${dep.artifact}:${dep.version}`,
            signature: `${dep.configuration}("${dep.group}:${dep.artifact}:${dep.version}")`,
            visibility: 'public', isExported: false, parentId: null, moduleId,
          })
          queries.insertEdge(subId, depId, 'gradle_depends_on',
            JSON.stringify({ group: dep.group, artifact: dep.artifact, version: dep.version, configuration: dep.configuration }),
            1, 0)
        }
      }
    }
  }

  return modules
}
