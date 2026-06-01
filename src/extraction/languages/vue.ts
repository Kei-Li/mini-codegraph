import Parser from 'web-tree-sitter'
import { parseTypeScriptFile, type NodeInfo, type EdgeInfo } from './typescript.js'

export interface VueScriptBlock {
  content: string
  startLine: number
  setup: boolean
  lang: string
}

export interface VueTemplateBlock {
  content: string
  startLine: number
}

export function extractScriptBlock(source: string): VueScriptBlock | null {
  const lines = source.split('\n')

  const scriptMatch = source.match(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/)
  if (!scriptMatch) return null

  const attrs = scriptMatch[1] || ''
  const content = scriptMatch[2] || ''
  const setup = /\bsetup\b/.test(attrs)
  const langMatch = attrs.match(/lang=['"]([a-zA-Z]+)['"]/)
  const lang = langMatch ? langMatch[1] : 'js'

  const totalBefore = source.substring(0, scriptMatch.index!).split('\n')
  const startLine = totalBefore.length

  return { content, startLine, setup, lang }
}

export function extractTemplateBlock(source: string): VueTemplateBlock | null {
  const templateMatch = source.match(/<template>([\s\S]*?)<\/template>/)
  if (!templateMatch) return null

  const content = templateMatch[1]
  const totalBefore = source.substring(0, templateMatch.index!).split('\n')
  const startLine = totalBefore.length

  return { content, startLine }
}

export function parseVueTemplateBlock(
  templateContent: string,
  filePath: string,
  lineOffset: number
): { nodes: NodeInfo[]; edges: EdgeInfo[] } {
  const nodes: NodeInfo[] = []
  const edges: EdgeInfo[] = []

  const componentRefPattern = /<([A-Z][a-zA-Z]*)([^>]*)\/?>/g
  let m: RegExpExecArray | null
  while ((m = componentRefPattern.exec(templateContent)) !== null) {
    const componentName = m[1]
    const attrs = m[2] || ''
    const lineNum = templateContent.substring(0, m.index).split('\n').length + lineOffset
    const nodeId = `${filePath}:template:${componentName}:${lineNum}`

    nodes.push({
      id: nodeId,
      kind: 'template_component',
      name: componentName,
      qualifiedName: `${filePath}::${componentName}`,
      startLine: lineNum,
      endLine: lineNum,
      startColumn: m.index,
      endColumn: m.index + m[0].length,
      parentId: null,
      visibility: 'public',
      isExported: false,
      docstring: '',
      signature: `<${componentName}${attrs}>`,
      filePath,
      language: 'vue',
    })

    edges.push({
      source: `${filePath}:module`,
      target: nodeId,
      kind: 'contains',
      line: lineNum,
      col: m.index,
      metadata: JSON.stringify({ type: 'template_component' }),
    })

    const propPattern = /:([a-zA-Z][\w-]+)\s*=\s*["']([^"']+)["']/g
    let pm: RegExpExecArray | null
    while ((pm = propPattern.exec(attrs)) !== null) {
      edges.push({
        source: nodeId,
        target: `${filePath}:${pm[2]}:${lineNum}`,
        kind: 'references',
        line: lineNum,
        col: pm.index,
        metadata: JSON.stringify({ type: 'prop_binding', prop: pm[1], value: pm[2] }),
      })
    }

    const eventPattern = /@([a-zA-Z][\w.-]*)\s*=\s*["']([^"']+)["']/g
    while ((pm = eventPattern.exec(attrs)) !== null) {
      edges.push({
        source: nodeId,
        target: `${filePath}:${pm[2]}:${lineNum}`,
        kind: 'calls',
        line: lineNum,
        col: pm.index,
        metadata: JSON.stringify({ type: 'event_binding', event: pm[1], handler: pm[2] }),
      })
    }

    const vForPattern = /v-for\s*=\s*["'](?:(\w+)\s+in\s+(\w+)|(\w+)\s+of\s+(\w+))["']/g
    while ((pm = vForPattern.exec(attrs)) !== null) {
      const iterable = pm[2] || pm[4]
      edges.push({
        source: nodeId,
        target: `${filePath}:${iterable}:${lineNum}`,
        kind: 'references',
        line: lineNum,
        col: pm.index,
        metadata: JSON.stringify({ type: 'v_for_iterable', iterable }),
      })
    }
  }

  const kebabComponentPattern = /<([a-z][a-z0-9-]+)([^>]*)\/?>/g
  while ((m = kebabComponentPattern.exec(templateContent)) !== null) {
    const tagName = m[1]
    const lineNum = templateContent.substring(0, m.index).split('\n').length + lineOffset

    if (tagName.includes('-') && !['template', 'slot', 'component'].includes(tagName)) {
      const nodeId = `${filePath}:template:${tagName}:${lineNum}`
      const pascalName = tagName.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        .replace(/^(\w)/, (_, c) => c.toUpperCase())

      nodes.push({
        id: nodeId,
        kind: 'template_component',
        name: pascalName,
        qualifiedName: `${filePath}::${pascalName}`,
        startLine: lineNum,
        endLine: lineNum,
        startColumn: m.index,
        endColumn: m.index + m[0].length,
        parentId: null,
        visibility: 'public',
        isExported: false,
        docstring: '',
        signature: `<${tagName}>`,
        filePath,
        language: 'vue',
      })
    }
  }

  const slotPattern = /<slot\s[^>]*name=["']([^"']+)["'][^>]*\/?>|<slot\b(?!\s)/g
  while ((m = slotPattern.exec(templateContent)) !== null) {
    const slotName = m[1] || 'default'
    const lineNum = templateContent.substring(0, m.index).split('\n').length + lineOffset
    const nodeId = `${filePath}:slot:${slotName}:${lineNum}`

    nodes.push({
      id: nodeId,
      kind: 'slot',
      name: slotName,
      qualifiedName: `${filePath}::slot:${slotName}`,
      startLine: lineNum,
      endLine: lineNum,
      startColumn: m.index,
      endColumn: m.index + m[0].length,
      parentId: null,
      visibility: 'public',
      isExported: false,
      docstring: '',
      signature: `<slot name="${slotName}">`,
      filePath,
      language: 'vue',
    })
  }

  return { nodes, edges }
}

export function parseVueFile(
  parser: Parser,
  source: string,
  filePath: string,
  language: string
): { nodes: NodeInfo[]; edges: EdgeInfo[] } {
  const nodes: NodeInfo[] = []
  const edges: EdgeInfo[] = []

  const scriptBlock = extractScriptBlock(source)
  if (!scriptBlock) return { nodes, edges }

  const scriptSource = scriptBlock.content
  const lineOffset = scriptBlock.startLine

  try {
    const tree = parser.parse(scriptSource)

    if (!tree || !tree.rootNode) return { nodes, edges }

    const parseResult = parseTypeScriptFile(tree, scriptSource, filePath, language)

    for (const n of parseResult.nodes) {
      nodes.push({
        ...n,
        startLine: n.startLine + lineOffset,
        endLine: n.endLine + lineOffset,
      })
    }

    for (const e of parseResult.edges) {
      edges.push({
        ...e,
        line: e.line + lineOffset,
      })
    }

    if (scriptBlock.setup) {
      const moduleId = `${filePath}:module`
      const hasModule = nodes.some(n => n.id === moduleId)
      if (!hasModule) {
        nodes.push({
          id: moduleId,
          kind: 'module',
          name: filePath.split('/').pop()?.replace(/\.\w+$/, '') || 'component',
          qualifiedName: filePath,
          startLine: 1 + lineOffset,
          endLine: scriptSource.split('\n').length + lineOffset,
          startColumn: 0,
          endColumn: 0,
          parentId: null,
          visibility: 'public',
          isExported: true,
          docstring: '',
          signature: `<script setup>`,
          filePath,
          language,
        })
      }
    }
  } catch {
    return { nodes, edges }
  }

  const templateBlock = extractTemplateBlock(source)
  if (templateBlock) {
    const templateResult = parseVueTemplateBlock(templateBlock.content, filePath, templateBlock.startLine)
    nodes.push(...templateResult.nodes)
    edges.push(...templateResult.edges)
  }

  return { nodes, edges }
}
