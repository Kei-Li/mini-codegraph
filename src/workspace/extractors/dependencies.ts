import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ParsedDependency {
  groupId: string
  artifactId: string
  version?: string
  scope?: string
}

/**
 * Parse pom.xml to extract Maven dependencies.
 * Returns all `<dependency>` entries that look like they reference other services.
 */
export function parsePomDependencies(pomPath: string): ParsedDependency[] {
  const deps: ParsedDependency[] = []
  try {
    const content = readFileSync(pomPath, 'utf-8')

    // Extract all <dependency> blocks
    const depRegex = /<dependency>\s*([\s\S]*?)<\/dependency>/g
    let match: RegExpExecArray | null
    while ((match = depRegex.exec(content)) !== null) {
      const block = match[1]
      const groupId = extractXmlValue(block, 'groupId')
      const artifactId = extractXmlValue(block, 'artifactId')
      const version = extractXmlValue(block, 'version')
      const scope = extractXmlValue(block, 'scope')
      if (groupId && artifactId) {
        deps.push({ groupId, artifactId, version, scope: scope || 'compile' })
      }
    }
  } catch { /* silent */ }
  return deps
}

/**
 * Parse build.gradle[.kts] to extract project dependencies.
 * Supports: implementation(), compile(), api(), runtimeOnly(), testImplementation(), project(':xxx')
 */
export function parseGradleDependencies(gradlePath: string): ParsedDependency[] {
  const deps: ParsedDependency[] = []
  try {
    const content = readFileSync(gradlePath, 'utf-8')

    // project(':xxx') references — these are intra-workspace dependencies
    const projRegex = /(implementation|compile|api|runtimeOnly)\s+project\(['"]:([^'"]+)['"]\)/g
    let match: RegExpExecArray | null
    while ((match = projRegex.exec(content)) !== null) {
      deps.push({ groupId: 'project', artifactId: match[2], scope: match[1] })
    }

    // Standard maven-style dependencies: implementation 'group:artifact:version'
    const mavenDepRegex = /(implementation|compile|api|runtimeOnly)\s+['"]([^:]+):([^:"]+)(?::[^'"]+)?['"]/g
    while ((match = mavenDepRegex.exec(content)) !== null) {
      deps.push({ groupId: match[2], artifactId: match[3], scope: match[1] })
    }
  } catch { /* silent */ }
  return deps
}

/**
 * Match dependencies against known workspace project names.
 * Returns pairs of (dependencyTarget, dependencyType) for projects found in the workspace.
 */
export function matchDependenciesToProjects(
  deps: ParsedDependency[],
  knownProjectNames: string[]
): { targetService: string; dependencyType: string }[] {
  const results: { targetService: string; dependencyType: string }[] = []
  const nameSet = new Set(knownProjectNames.map(n => n.toLowerCase()))

  for (const dep of deps) {
    // Try matching artifactId against project names
    const match = nameSet.has(dep.artifactId.toLowerCase())
    if (match) {
      results.push({ targetService: dep.artifactId, dependencyType: dep.scope || 'compile' })
      continue
    }

    // Try matching groupId.lastPart against project names
    const groupParts = dep.groupId.split('.')
    const lastGroup = groupParts[groupParts.length - 1]
    if (lastGroup && nameSet.has(lastGroup.toLowerCase())) {
      results.push({ targetService: lastGroup, dependencyType: dep.scope || 'compile' })
    }
  }

  return results
}

/**
 * Extract dependency list for a project directory.
 * Detects build system (pom.xml / build.gradle) and parses accordingly.
 */
export function extractDependencies(
  projectRoot: string,
  knownProjectNames: string[]
): { targetService: string; dependencyType: string }[] {
  const pomPath = join(projectRoot, 'pom.xml')
  if (existsSync(pomPath)) {
    const deps = parsePomDependencies(pomPath)
    return matchDependenciesToProjects(deps, knownProjectNames)
  }

  for (const gFile of ['build.gradle', 'build.gradle.kts']) {
    const gPath = join(projectRoot, gFile)
    if (existsSync(gPath)) {
      const deps = parseGradleDependencies(gPath)
      return matchDependenciesToProjects(deps, knownProjectNames)
    }
  }

  return []
}

function extractXmlValue(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`)
  const m = regex.exec(xml)
  return m ? m[1].trim() : undefined
}
