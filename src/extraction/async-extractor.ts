import type { QueryManager } from '../db/queries.js'

export interface AsyncAnnotation {
  classFile: string
  methodName: string
  returnType: string
  annotation: 'Async' | 'Scheduled' | 'AsyncScheduled'
  cronExpression?: string
  fixedRate?: number
  fixedDelay?: number
  initialDelay?: number
  executor?: string
  line: number
  moduleId: string
}

const SCHEDULED_ATTRS = ['cron', 'fixedRate', 'fixedDelay', 'initialDelay', 'zone']

export function indexAsyncAnnotations(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): AsyncAnnotation[] {
  const results: AsyncAnnotation[] = []
  const lines = source.split('\n')

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

    if (annotation === 'Scheduled') {
      const cronM = fullAnnSrc.match(/cron\s*=\s*["']([^"']+)["']/)
      if (cronM) cronExpr = cronM[1]
      const rateM = fullAnnSrc.match(/fixedRate\s*=\s*(\d+)/)
      if (rateM) fixedRate = parseInt(rateM[1], 10)
      const delayM = fullAnnSrc.match(/fixedDelay\s*=\s*(\d+)/)
      if (delayM) fixedDelay = parseInt(delayM[1], 10)
      const initM = fullAnnSrc.match(/initialDelay\s*=\s*(\d+)/)
      if (initM) initialDelay = parseInt(initM[1], 10)
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
    }
    results.push(ann)

    const nodeId = `${filePath}:${methodName}`
    const parentNodes = queries.searchNodes(filePath.split('/').pop()?.replace('.java', '') || '', 3)
      .filter(n => n.moduleId === moduleId && n.filePath === filePath)
    for (const pn of parentNodes) {
      queries.insertAnnotation(nodeId, annotation,
        JSON.stringify({ cron: cronExpr, fixedRate, fixedDelay, executor }), i + 1, moduleId)
      queries.insertEdge(pn.id, nodeId, annotation === 'Async' ? 'async_method' : 'scheduled_method',
        JSON.stringify(annotation === 'Async'
          ? { executor }
          : { cron: cronExpr, fixedRate, fixedDelay }),
        i + 1, 0)
    }
  }

  return results
}
