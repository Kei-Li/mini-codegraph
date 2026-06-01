import type { QueryManager } from '../db/queries.js'

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
  parent: { groupId: string; artifactId: string; version: string } | null
  properties: Record<string, string>
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

export function parsePomXml(xml: string, moduleDir: string, pomPath: string): MavenProjectConfig {
  const groupId = extractTag(xml, 'groupId')
  const artifactId = extractTag(xml, 'artifactId')
  const version = extractTag(xml, 'version')
  const packaging = extractTag(xml, 'packaging') || 'jar'

  const subModules = extractAllTags(extractBlock(xml, 'modules') ?? '', 'module')

  const parentBlock = extractBlock(xml, 'parent')
  let parent: MavenProjectConfig['parent'] = null
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

  const depsBlock = extractBlock(xml, 'dependencies')
  const dependencies: MavenDependency[] = []
  if (depsBlock) {
    const depRe = /<dependency>([\s\S]*?)<\/dependency>/g
    let dm: RegExpExecArray | null
    while ((dm = depRe.exec(depsBlock)) !== null) {
      const depXml = dm[1]
      let depVersion = extractTag(depXml, 'version')
      if (!depVersion && properties[depVersion]) {
        depVersion = properties[depVersion]
      }
      dependencies.push({
        groupId: extractTag(depXml, 'groupId'),
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
        managedDependencies.push({
          groupId: extractTag(depXml, 'groupId'),
          artifactId: extractTag(depXml, 'artifactId'),
          version: extractTag(depXml, 'version'),
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
  }
}

export function indexMavenDependencies(
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

const MAVEN_SCOPE_ORDER: Record<string, number> = {
  compile: 0,
  provided: 1,
  runtime: 2,
  test: 3,
  system: 4,
}

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
