

export function formatContextAsMarkdown(
  task: string,
  symbols: {
    id: string
    name: string
    kind: string
    qualifiedName: string
    filePath: string
    lines: string
    signature: string
    docstring: string
    moduleId?: string
    code: string
    callers: { name: string; filePath: string }[]
    callees: { name: string; filePath: string }[]
    implementations: { name: string; filePath: string }[]
  }[],
  stats: { totalFiles: number; modules: number; nodes: number; edges: number },
  routes?: { path: string; method: string; handler: string }[]
): string {
  const lines: string[] = []

  lines.push(`# Context: ${task}`)
  lines.push('')
  lines.push(`> Index: ${stats.nodes} symbols · ${stats.totalFiles} files · ${stats.edges} edges · ${stats.modules} modules`)
  lines.push('')

  if (symbols.length === 0) {
    lines.push('_No relevant symbols found._')
    return lines.join('\n')
  }

  const files = new Map<string, typeof symbols>()
  for (const s of symbols) {
    if (!files.has(s.filePath)) files.set(s.filePath, [])
    files.get(s.filePath)!.push(s)
  }

  lines.push(`## Entry Points (${symbols.length} symbols across ${files.size} files)`)
  lines.push('')

  let idx = 0
  for (const [filePath, fileSymbols] of files) {
    const moduleTag = fileSymbols[0]?.moduleId ? ` \`[${fileSymbols[0].moduleId}]\`` : ''
    lines.push(`### ${idx + 1}. \`${filePath}\`${moduleTag}`)
    lines.push('')

    for (const s of fileSymbols) {
      const declLine = s.signature ? `\`${s.signature}\`` : `\`${s.name}\``
      lines.push(`- **${s.kind}** ${declLine} _(lines ${s.lines})_`)
      if (s.docstring) lines.push(`  - ${s.docstring.split('\n')[0]}`)
      if (s.moduleId) lines.push(`  - _Module: \`${s.moduleId}\`_`)

      if (s.callers.length > 0) {
        const callerList = s.callers.slice(0, 3).map(c => `\`${c.name}\``).join(', ')
        lines.push(`  - Called by: ${callerList}${s.callers.length > 3 ? ` +${s.callers.length - 3} more` : ''}`)
      }
      if (s.callees.length > 0) {
        const calleeList = s.callees.slice(0, 3).map(c => `\`${c.name}\``).join(', ')
        lines.push(`  - Calls: ${calleeList}${s.callees.length > 3 ? ` +${s.callees.length - 3} more` : ''}`)
      }
      if (s.implementations.length > 0) {
        const implList = s.implementations.slice(0, 2).map(c => `\`${c.name}\``).join(', ')
        lines.push(`  - Implementations: ${implList}${s.implementations.length > 2 ? ` +${s.implementations.length - 2} more` : ''}`)
      }
    }
    lines.push('')
    idx++
  }

  const codeBlocks = symbols.filter(s => s.code.length > 0)
  if (codeBlocks.length > 0) {
    lines.push('## Source Code')
    lines.push('')
    for (const s of codeBlocks) {
      lines.push(`<details>`)
      lines.push(`<summary><b>${s.filePath}:${s.lines}</b> — ${s.signature || s.name}</summary>`)
      lines.push('')
      lines.push('```' + (s.filePath.endsWith('.java') ? 'java' : s.filePath.endsWith('.ts') ? 'typescript' : ''))
      lines.push(s.code)
      lines.push('```')
      lines.push('')
      lines.push('</details>')
      lines.push('')
    }
  }

  if (routes && routes.length > 0) {
    lines.push('## Routes')
    lines.push('')
    lines.push('| Method | Path | Handler |')
    lines.push('|--------|------|---------|')
    for (const r of routes) {
      lines.push(`| ${r.method} | \`${r.path}\` | \`${r.handler}\` |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

export function formatContextAsJSON(
  task: string,
  symbols: unknown[],
  stats: { totalFiles: number; modules: number; nodes: number; edges: number },
  routes?: unknown[]
): string {
  return JSON.stringify({ task, symbols, stats, routes }, null, 2)
}
