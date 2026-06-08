import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../../db/queries.js'

export interface FlowableProcess {
  id: string
  processId: string
  name: string
  isExecutable: boolean
  version: string
  targetNamespace: string
  nodes: FlowableNode[]
  flows: FlowableFlow[]
}

export interface FlowableNode {
  id: string
  name: string
  type: string
  implementation: string
  async: boolean
  documentation: string
}

export interface FlowableFlow {
  id: string
  fromNode: string
  toNode: string
  conditionExpression: string
  conditionLanguage: string
}

function extractXmlAttr(xml: string, attr: string): string {
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`)
  const m = re.exec(xml)
  return m ? m[1] : ''
}

function extractXmlContent(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`)
  const m = re.exec(xml)
  return m ? m[1].trim() : ''
}

function extractBlockXml(xml: string, tag: string): string[] {
  const blocks: string[] = []
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[0])
  }
  return blocks
}

export function parseBpmnXml(filePath: string): FlowableProcess[] {
  const processes: FlowableProcess[] = []
  try {
    const content = readFileSync(filePath, 'utf-8')

    const processBlocks = extractBlockXml(content, 'process')
    for (const procXml of processBlocks) {
      const processId = extractXmlAttr(procXml, 'id')
      const processName = extractXmlAttr(procXml, 'name')
      const isExecutable = extractXmlAttr(procXml, 'isExecutable') !== 'false'
      const targetNamespace = extractXmlAttr(content, 'targetNamespace') || ''

      const nodes: FlowableNode[] = []
      const flows: FlowableFlow[] = []

      const nodeTags = [
        'userTask', 'serviceTask', 'scriptTask', 'businessRuleTask',
        'manualTask', 'receiveTask', 'sendTask', 'callActivity',
        'subProcess', 'startEvent', 'endEvent', 'intermediateCatchEvent',
        'intermediateThrowEvent', 'boundaryEvent',
        'exclusiveGateway', 'inclusiveGateway', 'parallelGateway',
        'complexGateway', 'eventBasedGateway',
      ]

      for (const tag of nodeTags) {
        const nodeBlocks = extractBlockXml(procXml, tag)
        for (const nodeXml of nodeBlocks) {
          const nodeId = extractXmlAttr(nodeXml, 'id')
          const nodeName = extractXmlAttr(nodeXml, 'name') || ''
          const implementation = extractXmlAttr(nodeXml, 'implementation')
            || extractXmlAttr(nodeXml, 'delegateExpression')
            || extractXmlAttr(nodeXml, 'class')
            || ''
          const async = extractXmlContent(nodeXml, 'async') === 'true'
          const documentation = extractXmlContent(nodeXml, 'documentation') || ''

          nodes.push({
            id: `${processId}:${nodeId}`,
            name: nodeName,
            type: tag,
            implementation,
            async,
            documentation,
          })

          if (tag === 'callActivity') {
            const calledElement = extractXmlAttr(nodeXml, 'calledElement')
            if (calledElement) {
              nodes.push({
                id: `${processId}:${nodeId}:call`,
                name: `call:${calledElement}`,
                type: 'callActivity_ref',
                implementation: calledElement,
                async: false,
                documentation: `Calls sub-process: ${calledElement}`,
              })
            }
          }
        }
      }

      const seqFlowBlocks = extractBlockXml(procXml, 'sequenceFlow')
      for (const flowXml of seqFlowBlocks) {
        const flowId = extractXmlAttr(flowXml, 'id')
        const fromRef = extractXmlAttr(flowXml, 'sourceRef')
        const toRef = extractXmlAttr(flowXml, 'targetRef')
        const conditionExpr = extractXmlContent(flowXml, 'conditionExpression') || ''
        const conditionLang = extractXmlAttr(
          extractBlockXml(flowXml, 'conditionExpression')[0] || '',
          'language'
        ) || ''

        flows.push({
          id: flowId,
          fromNode: fromRef,
          toNode: toRef,
          conditionExpression: conditionExpr,
          conditionLanguage: conditionLang,
        })
      }

      processes.push({
        id: `flowable:${processId}`,
        processId,
        name: processName || processId,
        isExecutable,
        version: '',
        targetNamespace,
        nodes,
        flows,
      })
    }
  } catch { /* silent */ }
  return processes
}

export function findBpmnFiles(projectRoot: string): string[] {
  const files: string[] = []
  const srcDirs = [
    join(projectRoot, 'src', 'main', 'resources'),
    join(projectRoot, 'src', 'main', 'resources', 'processes'),
    join(projectRoot, 'src', 'main', 'resources', 'bpmn'),
    join(projectRoot, 'processes'),
    join(projectRoot, 'bpmn'),
    projectRoot,
  ]

  for (const dir of srcDirs) {
    if (!existsSync(dir)) continue
    try {
      const entries = readdirSync(dir, { recursive: true }) as string[]
      for (const e of entries) {
        if (e.endsWith('.bpmn20.xml') || e.endsWith('.bpmn')) {
          files.push(join(dir, e))
        }
      }
    } catch { /* silent */ }
  }
  return files
}

export function detectFlowable(projectRoot: string): boolean {
  const pomPath = join(projectRoot, 'pom.xml')
  if (existsSync(pomPath)) {
    try {
      const content = readFileSync(pomPath, 'utf-8')
      if (content.includes('flowable-spring-boot-starter') || content.includes('flowable-engine')) {
        return true
      }
    } catch { /* silent */ }
  }
  return findBpmnFiles(projectRoot).length > 0
}

export function indexFlowableProcesses(queries: QueryManager, projectRoot: string, moduleId: string): FlowableProcess[] {
  const allProcesses: FlowableProcess[] = []
  const files = findBpmnFiles(projectRoot)

  for (const f of files) {
    const processes = parseBpmnXml(f)
    for (const proc of processes) {
      queries.insertFlowableProcess(
        proc.id, proc.processId, proc.name,
        proc.isExecutable ? 1 : 0, proc.version,
        proc.targetNamespace, f, moduleId
      )

      for (const node of proc.nodes) {
        queries.insertFlowableNode(
          `${proc.id}:${node.id}`, proc.id, node.name,
          node.type, node.implementation, node.async ? 1 : 0,
          node.documentation, moduleId
        )
      }

      for (const flow of proc.flows) {
        queries.insertFlowableFlow(
          flow.id, proc.id, flow.fromNode, flow.toNode,
          flow.conditionExpression, flow.conditionLanguage
        )
      }

      allProcesses.push(proc)
    }
  }

  return allProcesses
}
