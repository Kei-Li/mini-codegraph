import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'

export interface AzurePipelineStage {
  name: string
  jobs: AzurePipelineJob[]
}

export interface AzurePipelineJob {
  name: string
  steps: AzurePipelineStep[]
}

export interface AzurePipelineStep {
  task: string
  displayName: string
  inputs: Record<string, string>
}

export interface AzurePipeline {
  trigger: string[]
  pool: { vmImage: string }
  variables: Record<string, string>
  stages: AzurePipelineStage[]
}

export function parseAzurePipeline(filePath: string): AzurePipeline | null {
  try {
    const content = readFileSync(filePath, 'utf-8')

    const pipeline: AzurePipeline = {
      trigger: [],
      pool: { vmImage: '' },
      variables: {},
      stages: [],
    }

    const triggerMatch = content.match(/trigger:\s*\n((?:\s+- .*\n?)*)/)
    if (triggerMatch) {
      pipeline.trigger = [...triggerMatch[1].matchAll(/- \s*(.+)/g)].map(m => m[1].trim())
    }

    const vmMatch = content.match(/vmImage:\s*["']?([^"'\s]+)["']?/)
    if (vmMatch) pipeline.pool.vmImage = vmMatch[1]

    const varSection = content.match(/variables:\s*\n((?:\s+\w+: .*\n?)*)/)
    if (varSection) {
      const varLines = varSection[1].matchAll(/(\w+):\s*["']?([^"'\n]+)["']?/g)
      for (const v of varLines) pipeline.variables[v[1]] = v[2]
    }

    const stageBlocks = content.split(/(?=^- stage:)/m).slice(1)
    for (const stageBlock of stageBlocks) {
      const stageNameMatch = stageBlock.match(/stage:\s*["']?([^"'\n]+)["']?/)
      const stageName = stageNameMatch ? stageNameMatch[1] : ''
      const jobs: AzurePipelineJob[] = []
      const jobBlocks = stageBlock.split(/(?=^- job:)/m).slice(1)
      for (const jobBlock of jobBlocks) {
        const jobNameMatch = jobBlock.match(/job:\s*["']?([^"'\n]+)["']?/)
        const jobName = jobNameMatch ? jobNameMatch[1] : ''
        const steps: AzurePipelineStep[] = []
        const stepMatches = [...jobBlock.matchAll(/-\s*task:\s*([^\s@]+)@?(\d*)/g)]
        for (const sm of stepMatches) {
          const taskName = sm[1]
          const taskVersion = sm[2]
          const stepBlock = jobBlock.substring(sm.index)
          const displayNameMatch = stepBlock.match(/displayName:\s*["']?([^"'\n]+)["']?/)
          const inputs: Record<string, string> = {}
          const inputSection = stepBlock.match(/inputs:\s*\n((?:\s+\w+: .*\n?)*)/)
          if (inputSection) {
            const inputLines = inputSection[1].matchAll(/(\w+):\s*["']?([^"'\n]+)["']?/g)
            for (const iv of inputLines) inputs[iv[1]] = iv[2]
          }
          steps.push({
            task: taskVersion ? `${taskName}@${taskVersion}` : taskName,
            displayName: displayNameMatch ? displayNameMatch[1] : '',
            inputs,
          })
        }
        jobs.push({ name: jobName, steps })
      }
      pipeline.stages.push({ name: stageName, jobs })
    }

    return pipeline
  } catch {
    return null
  }
}

export function findAzurePipelineFiles(projectRoot: string): string[] {
  const candidates = [
    join(projectRoot, 'azure-pipelines.yml'),
    join(projectRoot, 'azure-pipelines.yaml'),
    join(projectRoot, '.azure-pipelines', 'azure-pipelines.yml'),
    join(projectRoot, 'pipelines', 'azure-pipelines.yml'),
  ]
  return candidates.filter(f => existsSync(f))
}

export class AzureDevOpsExtractor implements IExtractor {
  name = 'azure-devops'

  async extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    const files = findAzurePipelineFiles(projectRoot)
    for (const f of files) {
      const pipeline = parseAzurePipeline(f)
      if (!pipeline) continue

      const serviceName = projectRoot.split(/[/\\]/).pop() || 'unknown'
      const moduleId = serviceName
      const id = `cicd:azure:${serviceName}`
      const stagesJson = JSON.stringify(pipeline.stages.map(s => ({
        name: s.name,
        jobs: s.jobs.map(j => ({ name: j.name, taskCount: j.steps.length })),
      })))

      queries.insertCicdPipeline(id, 'azure-devops', JSON.stringify(pipeline.trigger), pipeline.pool.vmImage, stagesJson, f, moduleId)

      provides.push({
        id,
        name: `${serviceName} CI/CD`,
        kind: 'cicd_pipeline',
        signature: `stages: ${pipeline.stages.length}, vm: ${pipeline.pool.vmImage}, triggers: ${pipeline.trigger.join(',') || '-'}`,
      })

      for (const stage of pipeline.stages) {
        for (const job of stage.jobs) {
          for (const step of job.steps) {
            if (step.task.includes('Maven')) {
              const pomPath = step.inputs['pomFile'] || step.inputs['pomXmlFile'] || 'pom.xml'
              consumes.push({
                symbolId: `pom:${pomPath}`,
                referenceType: 'maven_build',
                sourceLocation: `${f}:${step.task}`,
              })
            }
            if (step.task.includes('Sonar') || step.task.includes('sonar')) {
              provides.push({
                id: `sonar:${serviceName}`,
                name: `${serviceName} Sonar`,
                kind: 'code_quality',
                signature: `sonar analysis in CI`,
              })
            }
            if (step.task.includes('jib') || step.task.includes('dockerBuild')) {
              provides.push({
                id: `ci:build:${serviceName}`,
                name: `${serviceName} container build`,
                kind: 'ci_build_step',
                signature: `task: ${step.task}`,
              })
            }
          }
        }
      }
    }

    return { provides, consumes }
  }
}
