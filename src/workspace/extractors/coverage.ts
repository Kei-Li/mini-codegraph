import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'

export interface CoveragePluginConfig {
  plugin: 'surefire' | 'jacoco' | 'sonar'
  detectedFrom: string
  config: Record<string, string>
  reportPaths: string[]
}

function findReportDirs(projectRoot: string): string[] {
  return [
    join(projectRoot, 'target', 'surefire-reports'),
    join(projectRoot, 'target', 'jacoco-report'),
    join(projectRoot, 'target', 'site', 'jacoco'),
    join(projectRoot, 'target', 'sonar'),
    join(projectRoot, 'build', 'reports'),
  ].filter(d => existsSync(d))
}

function detectSurefire(pomContent: string, projectRoot: string): CoveragePluginConfig | null {
  const pluginBlock = pomContent.match(/<plugin>[\s\S]*?<artifactId>maven-surefire-plugin<\/artifactId>[\s\S]*?<\/plugin>/)
  if (!pluginBlock) return null
  const config: Record<string, string> = {}
  const configBlock = pluginBlock[0].match(/<configuration>([\s\S]*?)<\/configuration>/)
  if (configBlock) {
    const propRe = /<(\w+)>([^<]*)<\/\1>/g
    let m: RegExpExecArray | null
    while ((m = propRe.exec(configBlock[1])) !== null) config[m[1]] = m[2]
  }
  return {
    plugin: 'surefire',
    detectedFrom: 'pom.xml',
    config,
    reportPaths: [join(projectRoot, 'target', 'surefire-reports')],
  }
}

function detectJacoco(pomContent: string, projectRoot: string): CoveragePluginConfig | null {
  const pluginBlock = pomContent.match(/<plugin>[\s\S]*?<artifactId>jacoco-maven-plugin<\/artifactId>[\s\S]*?<\/plugin>/)
  if (!pluginBlock) return null
  const config: Record<string, string> = {}
  const configBlock = pluginBlock[0].match(/<configuration>([\s\S]*?)<\/configuration>/)
  if (configBlock) {
    const propRe = /<(\w+)>([^<]*)<\/\1>/g
    let m: RegExpExecArray | null
    while ((m = propRe.exec(configBlock[1])) !== null) config[m[1]] = m[2]
  }
  return {
    plugin: 'jacoco',
    detectedFrom: 'pom.xml',
    config,
    reportPaths: [
      join(projectRoot, 'target', 'jacoco-report'),
      join(projectRoot, 'target', 'site', 'jacoco'),
    ],
  }
}

function detectSonar(pomContent: string, projectRoot: string): CoveragePluginConfig | null {
  const properties = pomContent.match(/<properties>([\s\S]*?)<\/properties>/)
  const config: Record<string, string> = {}
  if (properties) {
    const propRe = /<sonar\.(\w+)>([^<]*)<\/sonar\.\1>/g
    let m: RegExpExecArray | null
    while ((m = propRe.exec(properties[1])) !== null) config[m[1]] = m[2]
  }

  const sonarProps = join(projectRoot, 'sonar-project.properties')
  if (existsSync(sonarProps)) {
    try {
      const content = readFileSync(sonarProps, 'utf-8')
      for (const line of content.split('\n')) {
        const eqIdx = line.indexOf('=')
        if (eqIdx > 0) {
          const key = line.substring(0, eqIdx).trim()
          const val = line.substring(eqIdx + 1).trim()
          if (key.startsWith('sonar.')) config[key.replace('sonar.', '')] = val
        }
      }
    } catch { /* silent */ }
  }

  if (pomContent.includes('sonar-maven-plugin') || pomContent.includes('sonar.projectKey') || config.projectKey) {
    return { plugin: 'sonar', detectedFrom: 'pom.xml', config, reportPaths: [join(projectRoot, 'target', 'sonar')] }
  }
  if (Object.keys(config).length > 0) {
    return { plugin: 'sonar', detectedFrom: 'sonar-project.properties', config, reportPaths: [] }
  }
  return null
}

export class CoverageExtractor implements IExtractor {
  name = 'coverage'

  async extract(projectRoot: string, _queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    const pomPath = join(projectRoot, 'pom.xml')
    let pomContent: string | null = null
    if (existsSync(pomPath)) {
      try { pomContent = readFileSync(pomPath, 'utf-8') } catch { /* silent */ }
    }

    if (!pomContent) return { provides, consumes }

    const serviceName = projectRoot.split(/[/\\]/).pop() || 'unknown'

    const surefire = detectSurefire(pomContent, projectRoot)
    if (surefire) {
      provides.push({
        id: `coverage:surefire:${serviceName}`,
        name: `${serviceName} Unit Tests`,
        kind: 'test_framework',
        signature: `surefire, config: ${JSON.stringify(surefire.config)}`,
      })
    }

    const jacoco = detectJacoco(pomContent, projectRoot)
    if (jacoco) {
      provides.push({
        id: `coverage:jacoco:${serviceName}`,
        name: `${serviceName} Code Coverage`,
        kind: 'code_coverage',
        signature: `jacoco, config: ${JSON.stringify(jacoco.config)}`,
      })
    }

    const sonar = detectSonar(pomContent, projectRoot)
    if (sonar) {
      const sonarId = `coverage:sonar:${sonar.config.projectKey || serviceName}`
      provides.push({
        id: sonarId,
        name: `${serviceName} SonarQube`,
        kind: 'code_quality',
        signature: `project: ${sonar.config.projectKey || '-'}, host: ${sonar.config.host || '-'}`,
      })
      provides.push({
        id: `coverage:sonar:gate:${sonar.config.projectKey || serviceName}`,
        name: `${serviceName} Quality Gate`,
        kind: 'quality_gate',
        signature: `quality gate for ${sonar.config.projectKey || serviceName}`,
      })
    }

    const reportDirs = findReportDirs(projectRoot)
    for (const dir of reportDirs) {
      provides.push({
        id: `coverage:report:${dir.replace(/[/\\]/g, '_')}`,
        name: dir.split(/[/\\]/).pop() || 'report',
        kind: 'test_report',
        signature: `report directory: ${dir}`,
      })
    }

    return { provides, consumes }
  }
}
