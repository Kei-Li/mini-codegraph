export interface ParsedQuery {
  text: string
  kind?: string
  language?: string
  file?: string
  name?: string
  raw: string
}

export function parseSearchQuery(query: string): ParsedQuery {
  const result: ParsedQuery = { text: query.trim(), raw: query }
  if (!result.text) return result

  const fieldPattern = /(\w+):(?:"([^"]+)"|(\S+))/g
  let match: RegExpExecArray | null
  const fields: { key: string; value: string }[] = []
  let lastIndex = 0

  while ((match = fieldPattern.exec(result.text)) !== null) {
    fields.push({ key: match[1], value: match[2] ?? match[3] })
    lastIndex = match.index + match[0].length
  }

  const remaining = result.text.slice(lastIndex).trim()
  result.text = remaining || ''

  for (const f of fields) {
    switch (f.key) {
      case 'kind': result.kind = f.value; break
      case 'lang':
      case 'language': result.language = f.value; break
      case 'path': result.file = f.value; break
      case 'name': result.name = f.value; break
    }
  }

  return result
}

export function buildFtsQuery(query: string): string {
  const terms = query
    .replace(/[()*"']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t}"`)
    .join(' AND ')
  return terms || query
}

export function filterNodesByKind(nodes: { kind: string }[], kind?: string): { kind: string }[] {
  if (!kind) return nodes
  const kinds = kind.split(',')
  return nodes.filter(n => kinds.includes(n.kind))
}

export function filterNodesByLanguage(nodes: { language: string }[], language?: string): { language: string }[] {
  if (!language) return nodes
  return nodes.filter(n => n.language === language)
}

export function filterNodesByFile(nodes: { filePath: string }[], filePattern?: string): { filePath: string }[] {
  if (!filePattern) return nodes
  const regex = new RegExp(filePattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i')
  return nodes.filter(n => regex.test(n.filePath))
}
