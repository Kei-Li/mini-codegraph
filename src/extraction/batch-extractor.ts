import type { QueryManager } from '../db/queries.js'

export interface BatchJob {
  name: string
  steps: string[]
  reader?: string
  processor?: string
  writer?: string
  chunkSize?: number
  filePath: string
}

export function extractBatchJobs(source: string, filePath: string): BatchJob[] {
  const jobs: BatchJob[] = []

  if (!source.includes('@EnableBatchProcessing') && !source.includes('JobBuilderFactory') && !source.includes('JobBuilder')) {
    return jobs
  }

  const jobMatches = source.matchAll(/(?:JobBuilder|JobBuilderFactory)\s*[.<]\s*(?:get|build)?\s*\(?\s*["'](\w+)["']/g)
  for (const jm of jobMatches) {
    const jobName = jm[1]
    const steps: string[] = []
    const stepMatches = source.matchAll(/\.\s*start\s*\(?\s*(\w+)\s*\)|\.\s*next\s*\(?\s*(\w+)\s*\)/g)
    for (const sm of stepMatches) {
      steps.push(sm[1] || sm[2])
    }

    const chunkMatches = [...source.matchAll(/chunk\s*\((\d+)\)/g)]
    const chunkSize = chunkMatches.length > 0 ? parseInt(chunkMatches[0][1]) : undefined

    const readerMatch = source.match(/reader\s*\(\s*(\w+)\s*\)/)
    const processorMatch = source.match(/processor\s*\(\s*(\w+)\s*\)/)
    const writerMatch = source.match(/writer\s*\(\s*(\w+)\s*\)/)

    jobs.push({
      name: jobName, steps,
      reader: readerMatch?.[1],
      processor: processorMatch?.[1],
      writer: writerMatch?.[1],
      chunkSize, filePath,
    })
  }

  return jobs
}

export function indexBatchJobs(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): BatchJob[] {
  const jobs = extractBatchJobs(source, filePath)
  if (jobs.length === 0) return jobs

  for (const job of jobs) {
    const jobId = `batch:${job.name}`
    const candidates = queries.searchNodes(job.name, 10)
    for (const c of candidates) {
      if (c.filePath === filePath) {
        queries.insertEdge(c.id, jobId, 'batch_job',
          JSON.stringify({ steps: job.steps, chunkSize: job.chunkSize }), 0, 0)
      }
    }
  }

  return jobs
}
