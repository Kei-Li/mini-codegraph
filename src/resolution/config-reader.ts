import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface FlatConfig {
  properties: Map<string, string>
  activeProfiles: string[]
  sourceFiles: string[]
}

export function readProjectConfig(projectRoot: string): FlatConfig {
  const properties = new Map<string, string>()
  const activeProfiles: string[] = []
  const sourceFiles: string[] = []

  const resourceDirs = [
    join(projectRoot, 'src', 'main', 'resources'),
    join(projectRoot, 'src', 'main', 'resources', 'config'),
    join(projectRoot, 'config'),
    projectRoot,
  ]

  const seenDirs = new Set<string>()

  for (const dir of resourceDirs) {
    if (seenDirs.has(dir)) continue
    seenDirs.add(dir)
    if (!existsSync(dir)) continue

    const baseYml = tryReadYamlFile(dir, 'application.yml')
    if (baseYml.size > 0) {
      sourceFiles.push(join(dir, 'application.yml'))
      for (const [k, v] of baseYml) properties.set(k, v)
    }

    const baseYaml = tryReadYamlFile(dir, 'application.yaml')
    if (baseYaml.size > 0) {
      sourceFiles.push(join(dir, 'application.yaml'))
      for (const [k, v] of baseYaml) {
        if (!properties.has(k)) properties.set(k, v)
      }
    }

    const baseProps = tryReadPropertiesFile(dir, 'application.properties')
    if (baseProps.size > 0) {
      sourceFiles.push(join(dir, 'application.properties'))
      for (const [k, v] of baseProps) {
        if (!properties.has(k)) properties.set(k, v)
      }
    }
  }

  const activeProfilesRaw = properties.get('spring.profiles.active')
  if (activeProfilesRaw) {
    const parsed = activeProfilesRaw.split(',').map(s => s.trim()).filter(Boolean)
    activeProfiles.push(...parsed)
  }

  for (const dir of resourceDirs) {
    if (!existsSync(dir)) continue

    for (const profile of activeProfiles) {
      const profileYml = tryReadYamlFile(dir, `application-${profile}.yml`)
      if (profileYml.size > 0) {
        sourceFiles.push(join(dir, `application-${profile}.yml`))
        for (const [k, v] of profileYml) properties.set(k, v)
      }

      const profileProps = tryReadPropertiesFile(dir, `application-${profile}.properties`)
      if (profileProps.size > 0) {
        sourceFiles.push(join(dir, `application-${profile}.properties`))
        for (const [k, v] of profileProps) properties.set(k, v)
      }
    }
  }

  return { properties, activeProfiles, sourceFiles }
}

function tryReadYamlFile(dir: string, fileName: string): Map<string, string> {
  const result = new Map<string, string>()
  const filePath = join(dir, fileName)
  if (!existsSync(filePath)) return result

  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    const prefixStack: string[] = []

    for (const rawLine of lines) {
      const line = rawLine.trimEnd()

      const indentMatch = line.match(/^(\s*)([\w.-]+):\s*(.*)/)
      if (indentMatch) {
        const indent = indentMatch[1].length
        const key = indentMatch[2]
        const value = indentMatch[3].trim()

        while (prefixStack.length > 0 && prefixStack.length * 2 >= indent) {
          prefixStack.pop()
        }
        prefixStack.push(key)
        const fullKey = prefixStack.join('.')

        if (value && !value.startsWith('|') && !value.startsWith('>')) {
          result.set(fullKey, value)
        }

        if (!value) {
          result.set(fullKey, '')
        }
      }
    }
  } catch {
    /* silent */
  }

  return result
}

function tryReadPropertiesFile(dir: string, fileName: string): Map<string, string> {
  const result = new Map<string, string>()
  const filePath = join(dir, fileName)
  if (!existsSync(filePath)) return result

  try {
    const content = readFileSync(filePath, 'utf-8')
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#') || !line.includes('=')) continue
      const eqIdx = line.indexOf('=')
      const key = line.substring(0, eqIdx).trim()
      const value = line.substring(eqIdx + 1).trim()
      result.set(key, value)
    }
  } catch {
    /* silent */
  }

  return result
}

export function getConfigProperty(config: FlatConfig, key: string): string | undefined {
  return config.properties.get(key)
}

export function hasActiveProfile(config: FlatConfig, profile: string): boolean {
  return config.activeProfiles.includes(profile)
}
