import Parser from 'web-tree-sitter'

export interface NodeInfo {
  kind: string; name: string; qualifiedName: string
  startLine: number; endLine: number; startColumn: number; endColumn: number
  parentId: string | null; visibility: string; isExported: boolean
  docstring: string; signature: string; filePath: string; language: string; id: string
  annotations?: { name: string; value: string }[]
}

export interface EdgeInfo {
  source: string; target: string; kind: string; line: number; col: number; metadata: string
}

const SPRING_ANNOTATIONS = new Set([
  'Autowired', 'RestController', 'Controller', 'Service', 'Repository', 'Component',
  'Configuration', 'Value', 'FeignClient', 'RequestMapping', 'GetMapping', 'PostMapping',
  'PutMapping', 'DeleteMapping', 'PatchMapping', 'SpringBootApplication',
  'ConfigurationProperties', 'Transactional', 'Cacheable', 'KafkaListener',
  'RabbitListener', 'StreamListener', 'EnableBinding', 'EnableAutoConfiguration',
  'Bean', 'Qualifier', 'Primary',
])

export function parseKotlinFile(
  tree: Parser.Tree, source: string, filePath: string, language: string
): { nodes: NodeInfo[]; edges: EdgeInfo[] } {
  const nodes: NodeInfo[] = []; const edges: EdgeInfo[] = []
  const classStack: string[] = []; const lines = source.split('\n')
  const cursor = tree.walk(); const visited = new Set<number>()

  function visit(): void {
    const node = cursor.currentNode
    if (!node || visited.has(node.id)) return
    visited.add(node.id)
    const nt = node.type; const r = { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, startColumn: node.startPosition.column, endColumn: node.endPosition.column }

    if (['class_declaration', 'object_declaration', 'interface_declaration'].includes(nt)) {
      const nameNode = node.namedChildren.find((c: any) => c.type === 'simple_identifier')
      const name = nameNode?.text ?? 'Unknown'
      const pid = classStack.length > 0 ? classStack[classStack.length - 1] : null
      const ni = `${filePath}:${name}:${r.startLine}`
      const vis = findVisibility(lines, r.startLine)
      const anns = extractAnnotations(lines, r.startLine)
      const kind = nt === 'interface_declaration' ? 'interface' : nt === 'object_declaration' ? 'object' : 'class'
      const pkg = extractPackage(lines, name)
      nodes.push({ id: ni, kind, name, qualifiedName: pid ? `${getNodeName(pid)}.${name}` : pkg, startLine: r.startLine, endLine: r.endLine, startColumn: r.startColumn, endColumn: r.endColumn, parentId: pid, visibility: vis, isExported: vis === 'public', docstring: extractKDoc(lines, r.startLine), signature: name, filePath, language, annotations: anns })
      if (pid) edges.push({ source: pid, target: ni, kind: 'contains', line: r.startLine, col: r.startColumn, metadata: '{}' })
      classStack.push(ni); visitChildren(); classStack.pop(); return
    }

    if (nt === 'function_declaration') {
      const nameNode = node.namedChildren.find((c: any) => c.type === 'simple_identifier')
      const name = nameNode?.text ?? 'Unknown'
      const pid = classStack.length > 0 ? classStack[classStack.length - 1] : null
      const ni = `${filePath}:${name}:${r.startLine}`
      const vis = findVisibility(lines, r.startLine)
      const anns = extractAnnotations(lines, r.startLine)
      const params = node.namedChildren.filter((c: any) => c.type === 'function_parameters').flatMap((c: any) => c.namedChildren.map((p: any) => p.text)).join(', ')
      const sig = `${vis} ${name}(${params})`.trim()
      nodes.push({ id: ni, kind: pid ? 'method' : 'function', name, qualifiedName: pid ? `${getNodeName(pid)}.${name}(${params})`.trim() : name, startLine: r.startLine, endLine: r.endLine, startColumn: r.startColumn, endColumn: r.endColumn, parentId: pid, visibility: vis, isExported: vis === 'public', docstring: extractKDoc(lines, r.startLine), signature: sig, filePath, language, annotations: anns })
      if (pid) edges.push({ source: pid, target: ni, kind: 'contains', line: r.startLine, col: r.startColumn, metadata: '{}' })
      visitChildren(); return
    }

    if (nt === 'property_declaration') {
      const pid = classStack.length > 0 ? classStack[classStack.length - 1] : null
      const nameNode = node.namedChildren.find((c: any) => c.type === 'simple_identifier')
      const name = nameNode?.text ?? 'unknown'
      const ni = `${filePath}:${name}:${r.startLine}`
      const anns = extractAnnotations(lines, r.startLine)
      nodes.push({ id: ni, kind: 'field', name, qualifiedName: pid ? `${getNodeName(pid)}.${name}` : name, startLine: r.startLine, endLine: r.endLine, startColumn: r.startColumn, endColumn: r.endColumn, parentId: pid, visibility: 'public', isExported: true, docstring: '', signature: name, filePath, language, annotations: anns })
      if (pid) edges.push({ source: pid, target: ni, kind: 'contains', line: r.startLine, col: r.startColumn, metadata: '{}' })
      return
    }

    if (nt === 'call_expression') {
      const nameNode = node.namedChildren.find((c: any) => c.type === 'simple_identifier' || c.type === 'navigation_expression')
      if (!nameNode) return
      const callName = nameNode.type === 'navigation_expression' ? nameNode.text : nameNode.text
      const callerId = findEnclosingFunction(node, filePath)
      if (callerId) edges.push({ source: callerId, target: `${filePath}:${callName}`, kind: 'calls', line: r.startLine, col: r.startColumn, metadata: JSON.stringify({ name: callName, type: 'call_expression' }) })
      return
    }

    if (nt === 'import_header') {
      if (classStack.length === 0) return
      const importText = node.text.replace('import ', '').trim()
      const importName = importText.split('.').pop() ?? importText
      edges.push({ source: classStack[0], target: importName, kind: 'imports', line: r.startLine, col: r.startColumn, metadata: JSON.stringify({ path: importText }) })
      return
    }

    visitChildren()
  }

  function visitChildren(): void {
    if (cursor.gotoFirstChild()) { do { visit() } while (cursor.gotoNextSibling()); cursor.gotoParent() }
  }

  visit()
  return { nodes, edges }
}

function findVisibility(lines: string[], lineNum: number): string {
  for (let i = lineNum - 2; i >= 0 && i >= lineNum - 5; i--) {
    const l = lines[i] ?? ''
    if (l.includes('public ')) return 'public'; if (l.includes('private ')) return 'private'; if (l.includes('protected ')) return 'protected'; if (l.includes('internal ')) return 'internal'
  }
  return 'public'
}

function extractKDoc(lines: string[], lineNum: number): string {
  const dl: string[] = []
  for (let i = lineNum - 2; i >= 0; i--) {
    const l = lines[i]?.trim() ?? ''
    if (l.startsWith('*')) dl.unshift(l.replace(/^\s*\*\s?/, ''))
    else if (l.includes('/**')) { dl.unshift(l.replace(/^\s*\/\*\*\s?/, '')); break }
    else if (dl.length > 0 && !l.startsWith('*') && !l.startsWith('/**')) break
    else if (dl.length === 0) continue
    else break
  }
  return dl.join(' ')
}

function extractAnnotations(lines: string[], lineNum: number): { name: string; value: string }[] {
  const anns: { name: string; value: string }[] = []
  for (let i = lineNum - 2; i >= 0; i--) {
    const l = lines[i]?.trim() ?? ''
    if (!l.startsWith('@')) break
    const m = l.match(/@(\w+)\s*(?:\(([^)]*)\))?/)
    if (m) anns.push({ name: m[1], value: m[2]?.trim() ?? '' })
  }
  return anns
}

function extractPackage(lines: string[], className: string): string {
  for (const l of lines) {
    const m = l.trim().match(/^package\s+([\w.]+)/)
    if (m) return `${m[1]}.${className}`
  }
  return className
}

function getNodeName(nid: string): string {
  const p = nid.split(':'); return p[p.length - 2] || nid
}

function findEnclosingFunction(node: any, filePath: string): string | null {
  let p = node.parent
  while (p) {
    if (p.type === 'function_declaration') {
      const nc = p.namedChildren.find((c: any) => c.type === 'simple_identifier')
      return `${filePath}:${nc?.text ?? 'Unknown'}:${p.startPosition.row + 1}`
    }
    p = p.parent
  }
  return null
}
