import type { CodeGraphNode } from '../types.js'

export interface ParsedQuery {
  text: string
  kind?: string
  language?: string
  file?: string
}

export function parseSearchQuery(query: string): ParsedQuery {
  const result: ParsedQuery = { text: query }

  const kindMatch = query.match(/\bkind:(\w+)\b/)
  if (kindMatch) {
    result.kind = kindMatch[1]
    result.text = result.text.replace(kindMatch[0], '').trim()
  }

  const langMatch = query.match(/\blang:(\w+)\b/)
  if (langMatch) {
    result.language = langMatch[1]
    result.text = result.text.replace(langMatch[0], '').trim()
  }

  const fileMatch = query.match(/\bpath:(\S+)\b/)
  if (fileMatch) {
    result.file = fileMatch[1]
    result.text = result.text.replace(fileMatch[0], '').trim()
  }

  return result
}

export function buildFtsQuery(query: string): string {
  // Escape special FTS5 characters and build match query
  const terms = query
    .replace(/[()*"']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t}"`)
    .join(' AND ')

  return terms || query
}

export function filterNodesByKind(nodes: CodeGraphNode[], kind?: string): CodeGraphNode[] {
  if (!kind) return nodes
  const kinds = kind.split(',')
  return nodes.filter(n => kinds.includes(n.kind))
}

export function filterNodesByLanguage(nodes: CodeGraphNode[], language?: string): CodeGraphNode[] {
  if (!language) return nodes
  return nodes.filter(n => n.language === language)
}
