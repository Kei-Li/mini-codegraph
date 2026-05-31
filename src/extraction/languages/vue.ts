import Parser from 'web-tree-sitter'
import { parseTypeScriptFile, type NodeInfo, type EdgeInfo } from './typescript.js'

export interface VueScriptBlock {
  content: string
  startLine: number
  setup: boolean
  lang: string
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

  return { nodes, edges }
}
