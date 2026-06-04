import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface WorkspaceConfig {
  workspace: string
  exclude: string[]
  projects: { name: string; rootPath: string; language: string }[]
  extractors: string[]
}

const DEFAULT_CONFIG: WorkspaceConfig = {
  workspace: '',
  exclude: [],
  projects: [],
  extractors: ['spring-cloud', 'rabbitmq', 'redis', 'database', 'frontend', 'frameworks'],
}

export function loadWorkspaceConfig(dataDir: string): WorkspaceConfig {
  const configPath = join(dataDir, 'workspace.yml')
  try {
    if (!existsSync(configPath)) return { ...DEFAULT_CONFIG }
    const content = readFileSync(configPath, 'utf-8')
    return parseYamlConfig(content)
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveWorkspaceConfig(dataDir: string, config: WorkspaceConfig): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  const configPath = join(dataDir, 'workspace.yml')
  writeFileSync(configPath, serializeYamlConfig(config), 'utf-8')
}

function parseYamlConfig(content: string): WorkspaceConfig {
  const config: WorkspaceConfig = { ...DEFAULT_CONFIG }
  const lines = content.split('\n')
  let currentKey: string | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || !trimmed) continue
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue
    const key = trimmed.slice(0, colonIdx).trim()
    const value = trimmed.slice(colonIdx + 1).trim()
    if (key === 'workspace') config.workspace = value
    else if (key === 'exclude') config.exclude = value.split(',').map(s => s.trim()).filter(Boolean)
    else if (key === 'extractors') config.extractors = value.split(',').map(s => s.trim()).filter(Boolean)
    else if (key === 'name' && currentKey === 'projects') {
      config.projects.push({ name: value, rootPath: '', language: '' })
    } else if (key === 'rootPath' && config.projects.length > 0) {
      config.projects[config.projects.length - 1].rootPath = value
    } else if (key === 'language' && config.projects.length > 0) {
      config.projects[config.projects.length - 1].language = value
    }
  }
  return config
}

function serializeYamlConfig(config: WorkspaceConfig): string {
  const lines: string[] = ['# mini-codegraph workspace configuration']
  lines.push(`workspace: ${config.workspace}`)
  lines.push(`exclude: ${config.exclude.join(',')}`)
  lines.push(`extractors: ${config.extractors.join(',')}`)
  if (config.projects.length > 0) {
    lines.push('projects:')
    for (const p of config.projects) {
      lines.push(`  - name: ${p.name}`)
      lines.push(`    rootPath: ${p.rootPath}`)
      lines.push(`    language: ${p.language}`)
    }
  }
  return lines.join('\n') + '\n'
}
