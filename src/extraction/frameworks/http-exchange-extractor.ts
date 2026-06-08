import type { QueryManager } from '../../db/queries.js'

export interface HttpExchangeInterface {
  interfaceName: string
  filePath: string
  basePath: string
  methods: { name: string; httpMethod: string; path: string; returnType: string }[]
  line: number
  moduleId: string
}

const EXCHANGE_ANNOTATIONS = ['HttpExchange', 'GetExchange', 'PostExchange', 'PutExchange', 'DeleteExchange', 'PatchExchange']

export function extractHttpExchanges(source: string, filePath: string): HttpExchangeInterface[] {
  const results: HttpExchangeInterface[] = []
  const lines = source.split('\n')

  let currentInterface: {
    interfaceName: string; basePath: string; methods: HttpExchangeInterface['methods']
  } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    if (line.startsWith('@HttpExchange')) {
      const pathMatch = line.match(/(?:value|path)\s*=\s*["']([^"']+)["']/)
      const basePath = pathMatch ? pathMatch[1] : '/'

      for (let j = i; j < Math.min(i + 5, lines.length); j++) {
        const ifaceMatch = lines[j].match(/(?:public\s+)?interface\s+(\w+)/)
        if (ifaceMatch) {
          currentInterface = {
            interfaceName: ifaceMatch[1],
            basePath,
            methods: [],
          }
          break
        }
      }
      continue
    }

    if (!currentInterface) continue

    for (const ann of EXCHANGE_ANNOTATIONS) {
      if (ann === 'HttpExchange') continue
      if (line.startsWith(`@${ann}`)) {
        const pathMatch = line.match(/(?:value|path)\s*=\s*["']([^"']+)["']/)
        const path = pathMatch ? pathMatch[1] : '/'
        const httpMethod = ann.replace('Exchange', '').toUpperCase()

        let j = i + 1
        while (j < lines.length && !lines[j].trim().includes('(') && !lines[j].trim().startsWith('}')) j++
        const methodLine = lines[j] || lines[i]
        const methodMatch = methodLine.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
        if (methodMatch) {
          currentInterface.methods.push({
            name: methodMatch[2],
            httpMethod,
            path,
            returnType: methodMatch[1],
          })
        }
        break
      }
    }

    if (line.trim() === '}' && currentInterface.interfaceName) {
      results.push({
        interfaceName: currentInterface.interfaceName,
        filePath,
        basePath: currentInterface.basePath,
        methods: currentInterface.methods,
        line: i + 1,
        moduleId: '',
      })
      currentInterface = null
    }
  }

  return results
}

export function indexHttpExchanges(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): HttpExchangeInterface[] {
  const ifaces = extractHttpExchanges(source, filePath)
  for (const iface of ifaces) {
    iface.moduleId = moduleId

    const nodeId = `httpexchange:${filePath}:${iface.interfaceName}`
    queries.insertNode({
      id: nodeId,
      kind: 'interface',
      name: iface.interfaceName,
      qualifiedName: `${moduleId}.${iface.interfaceName}`,
      filePath,
      language: 'java',
      startLine: iface.line,
      endLine: iface.line,
      startColumn: 0,
      endColumn: 0,
      docstring: '',
      signature: `@HttpExchange ${iface.basePath}`,
      visibility: 'public',
      isExported: true,
      parentId: null,
      moduleId,
    })

    for (const m of iface.methods) {
      const methodNodeId = `${nodeId}:${m.name}`
      queries.insertNode({
        id: methodNodeId,
        kind: 'method',
        name: m.name,
        qualifiedName: `${iface.interfaceName}.${m.name}`,
        filePath,
        language: 'java',
        startLine: iface.line,
        endLine: iface.line,
        startColumn: 0,
        endColumn: 0,
        docstring: '',
        signature: `@${m.httpMethod}Exchange ${m.path}`,
        visibility: 'public',
        isExported: true,
        parentId: nodeId,
        moduleId,
      })
      queries.insertEdge(nodeId, methodNodeId, 'contains', '{}', iface.line, 0)
    }
  }
  return ifaces
}
