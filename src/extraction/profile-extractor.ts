import type { QueryManager } from '../db/queries.js'

export interface ProfileAnnotation {
  className: string
  filePath: string
  profiles: string[]
  line: number
  moduleId: string
}

export function indexProfileAnnotations(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): ProfileAnnotation[] {
  const results: ProfileAnnotation[] = []
  const lines = source.split('\n')

  let currentProfiles: string[] | null = null
  let currentLine = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    if (line.startsWith('@Profile')) {
      const fullAnn = line
      const profiles: string[] = []

      const bracketMatch = fullAnn.match(/@Profile\s*\(\s*\{([^}]+)\}/)
      if (bracketMatch) {
        profiles.push(...bracketMatch[1].split(',').map(s => s.trim().replace(/["']/g, '')))
      } else {
        const singleMatch = fullAnn.match(/@Profile\s*\(\s*["']([^"']+)["']/)
        if (singleMatch) profiles.push(singleMatch[1])
      }

      if (profiles.length > 0) {
        currentProfiles = profiles
        currentLine = i + 1
      }
      continue
    }

    if (!currentProfiles) continue

    let targetName = ''
    let targetKind = 'class'

    const classMatch = line.match(/(?:public\s+)?class\s+(\w+)/)
    if (classMatch) {
      targetName = classMatch[1]
      targetKind = 'class'
    }

    const configMatch = line.match(/(?:public\s+)?@Configuration\s+(?:class\s+)?(\w+)/)
    if (configMatch) {
      targetName = configMatch[1]
      targetKind = 'class'
    }

    if (targetName) {
      const pa: ProfileAnnotation = {
        className: targetName,
        filePath,
        profiles: [...currentProfiles],
        line: currentLine,
        moduleId,
      }
      results.push(pa)

      const targetNodes = queries.searchNodes(targetName, 10)
        .filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const tn of targetNodes) {
        queries.insertAnnotation(tn.id, 'Profile',
          JSON.stringify(currentProfiles), currentLine, moduleId)
        queries.insertEdge(tn.id, `profile:${currentProfiles.join(',')}`, 'profile_activated',
          JSON.stringify({ profiles: currentProfiles }), currentLine, 0)
      }

      currentProfiles = null
    }
  }

  return results
}
