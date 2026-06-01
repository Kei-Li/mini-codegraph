import type { QueryManager } from '../db/queries.js'

export interface StreamFunctionBinding {
  beanMethod: string
  className: string
  functionType: 'Function' | 'Consumer' | 'Supplier'
  inputType: string
  outputType: string
  bindingName: string
  filePath: string
  line: number
  moduleId: string
}

export function indexStreamFunctions(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): StreamFunctionBinding[] {
  const results: StreamFunctionBinding[] = []
  if (!source.includes('java.util.function.Function') && !source.includes('java.util.function.Consumer') &&
      !source.includes('java.util.function.Supplier') && !source.includes('@Bean')) return results

  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (!line.includes('@Bean') && !line.includes('@Bean(')) continue

    let j = i + 1
    while (j < lines.length && !lines[j].trim().startsWith('public') && !lines[j].trim().startsWith('@Bean')) j++
    const methodLine = lines[j] || ''

    const funcMatch = methodLine.match(/(?:public\s+)?(Function|Consumer|Supplier)<([^>]+)>\s+(\w+)\s*\(/)
    if (!funcMatch) continue

    const functionType = funcMatch[1] as StreamFunctionBinding['functionType']
    const typeParams = funcMatch[2]
    const beanName = funcMatch[3]

    let inputType = ''
    let outputType = ''

    if (functionType === 'Function') {
      const parts = typeParams.split(',').map(s => s.trim())
      inputType = parts[0] || ''
      outputType = parts[1] || ''
    } else if (functionType === 'Consumer') {
      inputType = typeParams.trim()
    } else if (functionType === 'Supplier') {
      outputType = typeParams.trim()
    }

    let bindingName = beanName
    for (let k = i - 1; k <= i + 1; k++) {
      if (k >= 0 && k < lines.length) {
        const bnMatch = lines[k].match(/@Bean\s*\(\s*["']([^"']+)["']/)
        if (bnMatch) bindingName = bnMatch[1]
      }
    }

    const sb: StreamFunctionBinding = {
      beanMethod: beanName,
      className: filePath.split('/').pop()?.replace('.java', '') || '',
      functionType,
      inputType, outputType,
      bindingName,
      filePath, line: i + 1, moduleId,
    }
    results.push(sb)

    const nodeId = `${filePath}:${beanName}`
    queries.insertAnnotation(nodeId, 'StreamFunction',
      JSON.stringify({ type: functionType, input: inputType, output: outputType, binding: bindingName }),
      i + 1, moduleId)

    const parentNodes = queries.searchNodes(sb.className, 3)
      .filter(n => n.moduleId === moduleId && n.filePath === filePath)
    for (const pn of parentNodes) {
      queries.insertEdge(pn.id, nodeId, 'stream_function',
        JSON.stringify({ type: functionType, input: inputType, output: outputType, binding: bindingName }),
        i + 1, 0)
    }

    const inputNodes = queries.searchNodes(inputType.replace(/<[^>]*>/g, '').split('.').pop() || '', 5)
    for (const inn of inputNodes) {
      if (inn.moduleId === moduleId && inn.kind === 'class') {
        queries.insertEdge(inn.id, nodeId, 'stream_function_input',
          JSON.stringify({ binding: bindingName }), i + 1, 0)
      }
    }

    const outputNodes = queries.searchNodes(outputType.replace(/<[^>]*>/g, '').split('.').pop() || '', 5)
    for (const on of outputNodes) {
      if (on.moduleId === moduleId && on.kind === 'class') {
        queries.insertEdge(nodeId, on.id, 'stream_function_output',
          JSON.stringify({ binding: bindingName }), i + 1, 0)
      }
    }
  }

  return results
}
