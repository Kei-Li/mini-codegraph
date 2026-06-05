import type { QueryManager } from '../db/queries.js'

export interface AsyncAnnotation {
  classFile: string
  methodName: string
  returnType: string
  annotation: 'Async' | 'Scheduled' | 'AsyncScheduled' | 'JobRunr' | 'JobRunrRecurring'
  cronExpression?: string
  fixedRate?: number
  fixedDelay?: number
  initialDelay?: number
  executor?: string
  line: number
  moduleId: string
  virtualThread?: boolean
  jobName?: string
}

const SCHEDULED_ATTRS = ['cron', 'fixedRate', 'fixedDelay', 'initialDelay', 'zone']

function detectVirtualThreadsEnabled(source: string): boolean {
  return source.includes('@EnableVirtualThreads')
    || source.includes('VirtualThreadTaskExecutor')
    || source.includes('spring.threads.virtual.enabled=true')
}

export function indexAsyncAnnotations(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): AsyncAnnotation[] {
  const results: AsyncAnnotation[] = []
  const lines = source.split('\n')
  const vtContext = detectVirtualThreadsEnabled(source)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    let annotation: AsyncAnnotation['annotation'] | null = null
    let annValue = ''

    if (line.startsWith('@Async')) {
      annotation = 'Async'
      annValue = line
    } else if (line.startsWith('@Scheduled')) {
      annotation = 'Scheduled'
      annValue = line
    } else if (line.startsWith('@Job(') || line.startsWith('@Job ') || line === '@Job') {
      annotation = 'JobRunr'
      annValue = line
    } else if (line.startsWith('@Recurring(') || line.startsWith('@Recurring ') || line === '@Recurring') {
      annotation = 'JobRunrRecurring'
      annValue = line
    } else if (line.startsWith('@EnableVirtualThreads')) {
      queries.insertAnnotation(
        `${filePath}:EnableVirtualThreads`,
        'EnableVirtualThreads', '{}', i + 1, moduleId,
      )
      continue
    }

    if (!annotation) continue

    let j = i + 1
    while (j < lines.length && !lines[j].trim().endsWith(')') && !lines[j].trim().includes('{')) j++
    const methodLine = j < lines.length && lines[j].trim().includes('(') ? lines[j] : lines[i]

    const fullAnnSrc = lines.slice(i, j + 1).join(' ')
    const methodMatch = methodLine.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
    if (!methodMatch) continue

    const returnType = methodMatch[1]
    const methodName = methodMatch[2]

    let cronExpr: string | undefined
    let fixedRate: number | undefined
    let fixedDelay: number | undefined
    let initialDelay: number | undefined
    let executor: string | undefined
    let jobName: string | undefined

    if (annotation === 'Scheduled' || annotation === 'JobRunrRecurring') {
      const cronM = fullAnnSrc.match(/cron\s*=\s*["']([^"']+)["']/)
      if (cronM) cronExpr = cronM[1]
      const rateM = fullAnnSrc.match(/fixedRate\s*=\s*(\d+)/)
      if (rateM) fixedRate = parseInt(rateM[1], 10)
      const delayM = fullAnnSrc.match(/fixedDelay\s*=\s*(\d+)/)
      if (delayM) fixedDelay = parseInt(delayM[1], 10)
      const initM = fullAnnSrc.match(/initialDelay\s*=\s*(\d+)/)
      if (initM) initialDelay = parseInt(initM[1], 10)
    } else if (annotation === 'JobRunr') {
      const nameM = fullAnnSrc.match(/(?:name|id)\s*=\s*["']([^"']+)["']/)
      if (nameM) jobName = nameM[1]
    } else {
      const execM = fullAnnSrc.match(/@Async\s*\(\s*["']([^"']+)["']/)
      if (execM) executor = execM[1]
    }

    const ann: AsyncAnnotation = {
      classFile: filePath,
      methodName,
      returnType,
      annotation,
      cronExpression: cronExpr,
      fixedRate,
      fixedDelay,
      initialDelay,
      executor,
      line: i + 1,
      moduleId,
      virtualThread: vtContext,
      jobName,
    }
    results.push(ann)

    const nodeId = `${filePath}:${methodName}`
    const parentNodes = queries.searchNodes(filePath.split('/').pop()?.replace('.java', '') || '', 3)
      .filter(n => n.moduleId === moduleId && n.filePath === filePath)
    for (const pn of parentNodes) {
      const meta: Record<string, any> = { cron: cronExpr, fixedRate, fixedDelay, executor }
      if (vtContext) meta.virtualThread = true
      if (ann.jobName) meta.jobName = ann.jobName
      queries.insertAnnotation(nodeId, annotation, JSON.stringify(meta), i + 1, moduleId)
      let edgeKind = 'async_method'
      if (annotation === 'Scheduled') edgeKind = 'scheduled_method'
      else if (annotation === 'JobRunr') edgeKind = 'jobrunr_method'
      else if (annotation === 'JobRunrRecurring') edgeKind = 'jobrunr_recurring'
      queries.insertEdge(pn.id, nodeId, edgeKind,
        JSON.stringify(meta), i + 1, 0)
    }
  }

  return results
}
