import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { QueryManager } from '../../db/queries.js'

export interface MavenModule {
  groupId: string
  artifactId: string
  version: string
  packaging: string
  modules: string[]
}

export interface MavenDependency {
  groupId: string
  artifactId: string
  version: string
  scope: string
  optional: boolean
  isManaged: boolean
}

export interface MavenProjectConfig {
  moduleDir: string
  pomPath: string
  module: MavenModule
  dependencies: MavenDependency[]
  managedDependencies: MavenDependency[]
  parent: { groupId: string; artifactId: string; version: string; pomPath?: string } | null
  properties: Record<string, string>
  resolvedProperties: Record<string, string>
}

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`)
  const m = re.exec(xml)
  return m ? m[1].trim() : ''
}

function extractAllTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g')
  const results: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].trim())
  }
  return results
}

function extractBlock(xml: string, tag: string, startIdx = 0): string | null {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = xml.indexOf(open, startIdx)
  if (start === -1) return null
  const end = xml.indexOf(close, start + open.length)
  if (end === -1) return null
  return xml.substring(start + open.length, end)
}

function resolveMavenProperty(value: string, inheritedProps: Record<string, string>, depth = 0): string {
  if (depth > 10) return value
  const propRe = /\$\{([^}]+)\}/g
  return value.replace(propRe, (_, name) => {
    if (name === 'project.groupId') return inheritedProps['project.groupId'] ?? inheritedProps['groupId'] ?? value
    if (name === 'project.artifactId') return inheritedProps['project.artifactId'] ?? inheritedProps['artifactId'] ?? value
    if (name === 'project.version') return inheritedProps['project.version'] ?? inheritedProps['version'] ?? value
    const resolved = inheritedProps[name]
    if (resolved !== undefined) return resolveMavenProperty(resolved, inheritedProps, depth + 1)
    return `\${${name}}`
  })
}

function findMavenLocalRepo(): string {
  const home = process.env['HOME'] || process.env['USERPROFILE'] || ''
  return home ? join(home, '.m2', 'repository') : ''
}

function findParentPom(parent: { groupId: string; artifactId: string; version: string }, searchDirs: string[]): string | null {
  const localRepo = findMavenLocalRepo()
  if (localRepo) {
    const jarPath = join(localRepo, ...parent.groupId.split('.'), parent.artifactId, parent.version, `${parent.artifactId}-${parent.version}.pom`)
    if (existsSync(jarPath)) return jarPath
  }
  for (const dir of searchDirs) {
    const candidate = join(dir, 'pom.xml')
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, 'utf-8')
        const gId = extractTag(content, 'groupId') || extractTag(extractBlock(content, 'parent') ?? '', 'groupId') || ''
        const aId = extractTag(content, 'artifactId')
        const ver = extractTag(content, 'version') || extractTag(extractBlock(content, 'parent') ?? '', 'version') || ''
        if (aId === parent.artifactId && (gId === parent.groupId || ver === parent.version)) {
          return candidate
        }
      } catch { /* silent */ }
    }
  }
  return null
}

export function resolveMavenPropertiesWithParent(
  pomPath: string,
  inheritedProps: Record<string, string> = {},
  searchDirs: string[] = [],
  depth = 0,
  visited = new Set<string>()
): { properties: Record<string, string>; parentChain: string[] } {
  if (depth > 10 || visited.has(pomPath)) return { properties: inheritedProps, parentChain: [] }
  visited.add(pomPath)
  const parentChain: string[] = [pomPath]

  try {
    const content = readFileSync(pomPath, 'utf-8')
    const parentBlock = extractBlock(content, 'parent')
    let parentPomPath: string | null = null

    if (parentBlock) {
      const pGroupId = extractTag(parentBlock, 'groupId')
      const pArtifactId = extractTag(parentBlock, 'artifactId')
      const pVersion = extractTag(parentBlock, 'version') || ''

      const resolvedGroupId = resolveMavenProperty(pGroupId, inheritedProps)
      const resolvedVersion = resolveMavenProperty(pVersion, inheritedProps)

      parentPomPath = findParentPom(
        { groupId: resolvedGroupId, artifactId: pArtifactId, version: resolvedVersion },
        [dirname(pomPath), ...searchDirs]
      )
    }

    const mergedProps = { ...inheritedProps }
    const propsBlock = extractBlock(content, 'properties')
    if (propsBlock) {
      const propRe = /<(\w+(?:\.\w+)*)>([^<]*)<\/\1>/g
      let pm: RegExpExecArray | null
      while ((pm = propRe.exec(propsBlock)) !== null) {
        mergedProps[pm[1]] = pm[2].trim()
      }
    }

    const artifactId = extractTag(content, 'artifactId')
    const groupId = extractTag(content, 'groupId') || ''
    const version = extractTag(content, 'version') || ''

    if (artifactId) mergedProps['project.artifactId'] = artifactId
    if (groupId) mergedProps['project.groupId'] = groupId
    if (version) mergedProps['project.version'] = version

    if (parentPomPath) {
      const parentResult = resolveMavenPropertiesWithParent(parentPomPath, mergedProps, searchDirs, depth + 1, visited)
      mergedProps['parentChain'] = JSON.stringify(parentResult.parentChain)
      parentChain.push(...parentResult.parentChain)
    }

    return { properties: mergedProps, parentChain }
  } catch {
    return { properties: inheritedProps, parentChain }
  }
}

export function parsePomXml(xml: string, moduleDir: string, pomPath: string, inheritedProperties: Record<string, string> = {}): MavenProjectConfig {
  const groupId = extractTag(xml, 'groupId')
  const artifactId = extractTag(xml, 'artifactId')
  const version = extractTag(xml, 'version')
  const packaging = extractTag(xml, 'packaging') || 'jar'

  const subModules = extractAllTags(extractBlock(xml, 'modules') ?? '', 'module')

  const parentBlock = extractBlock(xml, 'parent')
  let parent: MavenProjectConfig['parent'] | null = null
  if (parentBlock) {
    parent = {
      groupId: extractTag(parentBlock, 'groupId'),
      artifactId: extractTag(parentBlock, 'artifactId'),
      version: extractTag(parentBlock, 'version'),
    }
  }

  const properties: Record<string, string> = {}
  const propsBlock = extractBlock(xml, 'properties')
  if (propsBlock) {
    const propRe = /<(\w+(?:\.\w+)*)>([^<]*)<\/\1>/g
    let pm: RegExpExecArray | null
    while ((pm = propRe.exec(propsBlock)) !== null) {
      properties[pm[1]] = pm[2].trim()
    }
  }

  const resolvedProperties = { ...inheritedProperties }
  for (const [k, v] of Object.entries(properties)) {
    resolvedProperties[k] = v
  }
  if (artifactId) resolvedProperties['project.artifactId'] = artifactId
  if (groupId) resolvedProperties['project.groupId'] = groupId
  if (version) resolvedProperties['project.version'] = version

  const depsBlock = extractBlock(xml, 'dependencies')
  const dependencies: MavenDependency[] = []
  if (depsBlock) {
    const depRe = /<dependency>([\s\S]*?)<\/dependency>/g
    let dm: RegExpExecArray | null
    while ((dm = depRe.exec(depsBlock)) !== null) {
      const depXml = dm[1]
      let depVersion = extractTag(depXml, 'version')
      if (depVersion) {
        depVersion = resolveMavenProperty(depVersion, resolvedProperties)
      }
      dependencies.push({
        groupId: resolveMavenProperty(extractTag(depXml, 'groupId'), resolvedProperties),
        artifactId: extractTag(depXml, 'artifactId'),
        version: depVersion,
        scope: extractTag(depXml, 'scope') || 'compile',
        optional: extractTag(depXml, 'optional') === 'true',
        isManaged: false,
      })
    }
  }

  const mgdBlock = extractBlock(xml, 'dependencyManagement')
  const managedDependencies: MavenDependency[] = []
  if (mgdBlock) {
    const depsInMgd = extractBlock(mgdBlock, 'dependencies')
    if (depsInMgd) {
      const depRe = /<dependency>([\s\S]*?)<\/dependency>/g
      let dm: RegExpExecArray | null
      while ((dm = depRe.exec(depsInMgd)) !== null) {
        const depXml = dm[1]
        let depVersion = extractTag(depXml, 'version')
        if (depVersion) {
          depVersion = resolveMavenProperty(depVersion, resolvedProperties)
        }
        managedDependencies.push({
          groupId: resolveMavenProperty(extractTag(depXml, 'groupId'), resolvedProperties),
          artifactId: extractTag(depXml, 'artifactId'),
          version: depVersion,
          scope: extractTag(depXml, 'scope') || 'compile',
          optional: extractTag(depXml, 'optional') === 'true',
          isManaged: true,
        })
      }
    }
  }

  return {
    moduleDir,
    pomPath,
    module: { groupId, artifactId, version, packaging, modules: subModules },
    dependencies,
    managedDependencies,
    parent,
    properties,
    resolvedProperties,
  }
}

export function indexMavenDependenciesWithProperties(
  queries: QueryManager,
  config: MavenProjectConfig,
  moduleId: string,
): void {
  const nodeId = `pom:${config.module.groupId}:${config.module.artifactId}`
  queries.insertNode({
    id: nodeId,
    kind: 'module',
    name: config.module.artifactId,
    qualifiedName: `${config.module.groupId}:${config.module.artifactId}`,
    filePath: config.pomPath,
    language: 'xml',
    startLine: 1,
    endLine: 1,
    startColumn: 0, endColumn: 0,
    docstring: `Maven module ${config.module.artifactId} ${config.module.version}`,
    signature: `<module>${config.module.artifactId}</module>`,
    visibility: 'public',
    isExported: true,
    parentId: null,
    moduleId,
  })

  for (const [k, v] of Object.entries(config.resolvedProperties)) {
    if (k === 'parentChain' || k === 'project.artifactId' || k === 'project.groupId' || k === 'project.version') continue
    const propId = `${nodeId}:prop:${k}`
    queries.insertMavenProperty(propId, nodeId, k, config.properties[k] ?? v, v, 'direct')
  }

  for (const dep of config.managedDependencies) {
    const mgmtId = `mgmt:${dep.groupId}:${dep.artifactId}`
    queries.insertMavenDepMgmt(mgmtId, nodeId, dep.groupId, dep.artifactId, dep.version, dep.scope)
  }

  for (const dep of config.dependencies) {
    const depId = `pom:${dep.groupId}:${dep.artifactId}`
    queries.insertEdge(nodeId, depId, 'maven_depends_on',
      JSON.stringify({ groupId: dep.groupId, artifactId: dep.artifactId, version: dep.version, scope: dep.scope, optional: dep.optional }),
      1, 0)

    queries.insertNode({
      id: depId,
      kind: 'package',
      name: dep.artifactId,
      qualifiedName: `${dep.groupId}:${dep.artifactId}`,
      filePath: config.pomPath,
      language: 'xml',
      startLine: 1,
      endLine: 1,
      startColumn: 0, endColumn: 0,
      docstring: `Maven dependency ${dep.groupId}:${dep.artifactId}:${dep.version} (${dep.scope})`,
      signature: `<dependency>${dep.groupId}:${dep.artifactId}</dependency>`,
      visibility: 'public',
      isExported: false,
      parentId: null,
      moduleId,
    })
  }

  for (const sub of config.module.modules) {
    const subId = `pom:${config.module.groupId}:${sub}`
    queries.insertEdge(nodeId, subId, 'maven_submodule', '{}', 1, 0)
  }
}

export const indexMavenDependencies = indexMavenDependenciesWithProperties

export function findMavenScopeConflicts(configs: MavenProjectConfig[]): {
  artifactKey: string; scopes: string[]; modules: string[]
}[] {
  const depScope: Record<string, { scopes: Set<string>; modules: Set<string> }> = {}
  for (const cfg of configs) {
    for (const dep of cfg.dependencies) {
      const key = `${dep.groupId}:${dep.artifactId}`
      if (!depScope[key]) depScope[key] = { scopes: new Set(), modules: new Set() }
      depScope[key].scopes.add(dep.scope)
      depScope[key].modules.add(cfg.module.artifactId)
    }
  }
  return Object.entries(depScope)
    .filter(([_, v]) => v.scopes.size > 1)
    .map(([k, v]) => ({ artifactKey: k, scopes: [...v.scopes], modules: [...v.modules] }))
}
