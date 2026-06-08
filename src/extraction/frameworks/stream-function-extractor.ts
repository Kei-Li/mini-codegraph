import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../../db/queries.js'

export interface StreamFunctionBinding {
  beanMethod: string
  className: string
  functionType: 'Function' | 'Consumer' | 'Supplier' | 'Function<Flux' | 'Consumer<Flux' | 'Supplier<Flux'
  inputType: string
  outputType: string
  bindingName: string
  destination: string
  filePath: string
  line: number
  moduleId: string
}

function stripGeneric(input: string): string {
  return input.replace(/<[^>]*>/g, '').trim()
}

function detectDestination(beanName: string, bindingName: string, projectRoot: string): string {
  const configFiles = ['application.yml', 'application.yaml', 'application.properties']
  for (const cf of configFiles) {
    const fp = join(projectRoot, 'src', 'main', 'resources', cf)
    if (!existsSync(fp)) continue
    try {
      const content = readFileSync(fp, 'utf-8')
      const patterns = [
        new RegExp(`spring\\.cloud\\.stream\\.bindings\\.${bindingName}\\.destination\\s*[:=]\\s*(\\S+)`),
        new RegExp(`spring\\.cloud\\.stream\\.bindings\\.${beanName}\\.destination\\s*[:=]\\s*(\\S+)`),
      ]
      for (const p of patterns) {
        const m = content.match(p)
        if (m) return m[1].replace(/["']/g, '')
      }
    } catch { /* silent */ }
  }
  return ''
}

function streamBridgeUsage(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): void {
  const bridgePattern = /streamBridge\.send\s*\(\s*["']([^"']+)["']\s*,\s*([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = bridgePattern.exec(source)) !== null) {
    const destination = m[1]
    const payload = m[2].trim()
    const nodeId = `${filePath}:StreamBridge.${destination}`
    queries.insertAnnotation(nodeId, 'StreamBridge',
      JSON.stringify({ destination, payloadType: stripGeneric(payload) }), 0, moduleId)
  }
}

export function indexStreamFunctions(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string,
  projectRoot?: string
): StreamFunctionBinding[] {
  const results: StreamFunctionBinding[] = []

  streamBridgeUsage(queries, source, filePath, moduleId)

  const hasFunctional = source.includes('java.util.function.Function') ||
    source.includes('java.util.function.Consumer') ||
    source.includes('java.util.function.Supplier') ||
    source.includes('@Bean')
  if (!hasFunctional) return results

  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('@Bean') && !line.includes('@Bean(')) continue

    let j = i + 1
    while (j < lines.length && !lines[j].trim().startsWith('public') && !lines[j].trim().startsWith('@Bean')) j++
    const methodLine = lines[j] || ''

    const funcMatch = methodLine.match(
      /(?:public\s+)?(Function|Consumer|Supplier)(?:\s*<([^>]+(?:\s*,\s*[^>]+)*)>)+\s+(\w+)\s*\(/
    )
    if (!funcMatch) {
      const fluxMatch = methodLine.match(
        /(?:public\s+)?(Function|Consumer|Supplier)\s*<Flux\s*<\s*([^>]+)\s*>(?:\s*,\s*Flux\s*<\s*([^>]+)\s*>)?>\s+(\w+)\s*\(/
      )
      if (!fluxMatch) continue
      const fluxType = `${fluxMatch[1]}<Flux` as StreamFunctionBinding['functionType']
      const inputType = fluxMatch[2]
      const outputType = fluxMatch[3] || ''
      const beanName = fluxMatch[4]

      let bindingName = beanName
      for (let k = i - 1; k <= i + 1; k++) {
        if (k >= 0 && k < lines.length) {
          const bnMatch = lines[k].match(/@Bean\s*\(\s*["']([^"']+)["']/)
          if (bnMatch) bindingName = bnMatch[1]
        }
      }

      const destination = projectRoot ? detectDestination(beanName, bindingName, projectRoot) : ''

      const sb: StreamFunctionBinding = {
        beanMethod: beanName,
        className: filePath.split('/').pop()?.replace('.java', '') || '',
        functionType: fluxType,
        inputType, outputType,
        bindingName, destination,
        filePath, line: i + 1, moduleId,
      }
      results.push(sb)
      storeBinding(queries, sb, i + 1, moduleId)
      continue
    }

    const functionType = funcMatch[1] as StreamFunctionBinding['functionType']
    const typeParams = funcMatch[2]
    const beanName = funcMatch[3]

    let inputType = ''
    let outputType = ''

    if (functionType === 'Function') {
      const parts = typeParams.split(',').map(s => s.trim())
      inputType = stripGeneric(parts[0] || '')
      outputType = stripGeneric(parts[1] || '')
    } else if (functionType === 'Consumer') {
      inputType = stripGeneric(typeParams.trim())
    } else if (functionType === 'Supplier') {
      outputType = stripGeneric(typeParams.trim())
    }

    let bindingName = beanName
    for (let k = i - 1; k <= i + 1; k++) {
      if (k >= 0 && k < lines.length) {
        const bnMatch = lines[k].match(/@Bean\s*\(\s*["']([^"']+)["']/)
        if (bnMatch) bindingName = bnMatch[1]
      }
    }

    const destination = projectRoot ? detectDestination(beanName, bindingName, projectRoot) : ''

    const sb: StreamFunctionBinding = {
      beanMethod: beanName,
      className: filePath.split('/').pop()?.replace('.java', '') || '',
      functionType,
      inputType, outputType,
      bindingName, destination,
      filePath, line: i + 1, moduleId,
    }
    results.push(sb)
    storeBinding(queries, sb, i + 1, moduleId)
  }

  return results
}

function storeBinding(
  queries: QueryManager,
  sb: StreamFunctionBinding,
  line: number,
  moduleId: string
): void {
  const nodeId = `${sb.filePath}:${sb.beanMethod}`
  queries.insertAnnotation(nodeId, 'StreamFunction',
    JSON.stringify({
      type: sb.functionType, input: sb.inputType, output: sb.outputType,
      binding: sb.bindingName, destination: sb.destination,
    }),
    line, moduleId)

  const parentNodes = queries.searchNodes(sb.className, 3)
    .filter(n => n.moduleId === moduleId && n.filePath === sb.filePath)
  for (const pn of parentNodes) {
    queries.insertEdge(pn.id, nodeId, 'stream_function',
      JSON.stringify({
        type: sb.functionType, input: sb.inputType, output: sb.outputType,
        binding: sb.bindingName, destination: sb.destination,
      }),
      line, 0)
  }

  if (sb.inputType) {
    const inputNodes = queries.searchNodes(sb.inputType.split('.').pop() || '', 5)
    for (const inn of inputNodes) {
      if (inn.moduleId === moduleId && inn.kind === 'class') {
        queries.insertEdge(inn.id, nodeId, 'stream_function_input',
          JSON.stringify({ binding: sb.bindingName }), line, 0)
      }
    }
  }

  if (sb.outputType) {
    const outputNodes = queries.searchNodes(sb.outputType.split('.').pop() || '', 5)
    for (const on of outputNodes) {
      if (on.moduleId === moduleId && on.kind === 'class') {
        queries.insertEdge(nodeId, on.id, 'stream_function_output',
          JSON.stringify({ binding: sb.bindingName }), line, 0)
      }
    }
  }
}
