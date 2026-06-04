import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../db/queries.js'
import type { ConfigPropertyBinding } from '../types.js'
import { extractFileAnnotations } from '../resolution/index.js'

export function parseApplicationYml(content: string): { key: string; value: string; line: number }[] {
  const props: { key: string; value: string; line: number }[] = []
  const lines = content.split('\n')
  const prefixStack: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
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
        props.push({ key: fullKey, value, line: i + 1 })
      }
    } else {
      const dashMatch = line.match(/^\s*-\s+([\w.-]+):\s*(.*)/)
      if (dashMatch) {
        const key = dashMatch[1]
        const value = dashMatch[2].trim()
        if (value) {
          const fullKey = [...prefixStack, key].join('.')
          props.push({ key: fullKey, value, line: i + 1 })
        }
      }
    }
  }

  return props
}

export function parsePropertiesFile(content: string): { key: string; value: string; line: number }[] {
  const props: { key: string; value: string; line: number }[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line && !line.startsWith('#') && line.includes('=')) {
      const eqIdx = line.indexOf('=')
      const key = line.substring(0, eqIdx).trim()
      const value = line.substring(eqIdx + 1).trim()
      props.push({ key, value, line: i + 1 })
    }
  }
  return props
}

export function extractConfigProperties(projectRoot: string): { key: string; value: string; sourceFile: string; sourceLine: number }[] {
  const result: { key: string; value: string; sourceFile: string; sourceLine: number }[] = []
  const candidates = [
    'application.yml', 'application.yaml', 'application.properties',
    'application-dev.yml', 'application-prod.yml', 'application-test.yml',
    'bootstrap.yml', 'bootstrap.properties',
  ]

  for (const candidate of candidates) {
    const filePath = join(projectRoot, 'src', 'main', 'resources', candidate)
    if (!existsSync(filePath)) continue
    try {
      const content = readFileSync(filePath, 'utf-8')
      const ext = candidate.endsWith('.properties') ? 'properties' : 'yml'
      const parsed = ext === 'properties'
        ? parsePropertiesFile(content)
        : parseApplicationYml(content)
      for (const p of parsed) {
        result.push({ key: p.key, value: p.value, sourceFile: filePath, sourceLine: p.line })
      }
    } catch { /* silent */ }
  }

  return result
}

const SENSITIVE_KEYS = /password|secret|token|key|credential|certificate|private_key|api_key|access_key/i

function maskSensitiveValue(key: string, value: string): string {
  if (SENSITIVE_KEYS.test(key)) return '***'
  return value
}

export function indexConfigProperties(
  queries: QueryManager,
  projectRoot: string,
  moduleId: string
): ConfigPropertyBinding[] {
  const bindings: ConfigPropertyBinding[] = []
  const configProps = extractConfigProperties(projectRoot)
  if (configProps.length === 0) return bindings

  const allNodes = queries.getAllNodes()
  const configClassNodes = allNodes.filter(n => {
    const anns = queries.getAnnotationsByNode(n.id)
    return anns.some(a => a.annotationName === 'ConfigurationProperties')
  })

  for (const node of configClassNodes) {
    const anns = queries.getAnnotationsByNode(node.id)
    const configPropAnn = anns.find(a => a.annotationName === 'ConfigurationProperties')
    if (!configPropAnn) continue

    const prefix = configPropAnn.value.replace(/"/g, '').replace(/^prefix\s*=\s*/, '')
    const nodeProps = configProps.filter(p => p.key.startsWith(prefix))

    const binding: ConfigPropertyBinding = {
      configClass: node.name,
      prefix,
      filePath: node.filePath,
      properties: nodeProps.map(p => ({
        key: p.key,
        value: maskSensitiveValue(p.key, p.value),
        sourceFile: p.sourceFile,
        sourceLine: p.sourceLine,
      })),
      moduleId,
    }

    const bindingId = `config:${moduleId}:${prefix}`
    for (const np of nodeProps) {
      queries.insertEdge(bindingId, node.id, 'config_binding',
        JSON.stringify({ prefix, key: np.key, value: maskSensitiveValue(np.key, np.value) }),
        0, 0)
    }

    bindings.push(binding)
  }

  for (const node of allNodes) {
    const anns = queries.getAnnotationsByNode(node.id)
    const valueAnn = anns.find(a => a.annotationName === 'Value')
    if (valueAnn) {
      const placeholder = valueAnn.value.replace(/"/g, '')
      const match = placeholder.match(/\$\{([^}]+)}/)
      if (match) {
        const propKey = match[1].split(':')[0]
        const matchedProp = configProps.find(p => p.key === propKey)
        if (matchedProp) {
          queries.insertEdge(node.id, `config:${moduleId}:${propKey}`, 'value_inject',
            JSON.stringify({ key: propKey, value: matchedProp.value }),
            0, 0)
        }
      }
    }
  }

  return bindings
}
