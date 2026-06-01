import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../db/queries.js'
import type { DeployContainer } from '../types.js'

export function parseDockerCompose(filePath: string): DeployContainer[] {
  const containers: DeployContainer[] = []
  try {
    const content = readFileSync(filePath, 'utf-8')
    const serviceSection = content.match(/services:\n((?:\s+.*\n?)*)/)?.[1]
    if (!serviceSection) return containers

    const serviceBlocks = serviceSection.split(/(?=^\s+\w+:)/m)
    for (const block of serviceBlocks) {
      const nameMatch = block.match(/^\s+(\w+):/)
      if (!nameMatch) continue
      const name = nameMatch[1]
      const imageMatch = block.match(/image:\s*(\S+)/)
      const portMatches = [...block.matchAll(/- "?(\d+:\d+)"?/g)].map(m => m[1])
      const depMatches = [...block.matchAll(/- (\w+)/g)]
        .map(m => m[1])
        .filter(d => !d.includes(':'))
      const envMatches = [...block.matchAll(/- (\w+(?:=\S+)?)/g)].map(m => m[1])

      containers.push({
        name, image: imageMatch?.[1] ?? '',
        ports: portMatches, dependsOn: depMatches, envVars: envMatches,
      })
    }
  } catch {}
  return containers
}

export function parseDockerfile(filePath: string): { from: string; exposedPorts: string[]; envVars: string[] } {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const fromMatch = content.match(/FROM\s+(\S+)/)
    const ports = [...content.matchAll(/EXPOSE\s+(\d+)/g)].map(m => m[1])
    const envs = [...content.matchAll(/ENV\s+(\w+(?:=\S+)?)/g)].map(m => m[1])
    return { from: fromMatch?.[1] ?? '', exposedPorts: ports, envVars: envs }
  } catch { return { from: '', exposedPorts: [], envVars: [] } }
}

export function indexDeployment(
  queries: QueryManager,
  projectRoot: string,
  moduleId: string
): DeployContainer[] {
  const allContainers: DeployContainer[] = []

  const composeFile = join(projectRoot, 'docker-compose.yml')
  if (existsSync(composeFile)) {
    allContainers.push(...parseDockerCompose(composeFile))
  }

  const composeYaml = join(projectRoot, 'docker-compose.yaml')
  if (existsSync(composeYaml)) {
    allContainers.push(...parseDockerCompose(composeYaml))
  }

  for (const c of allContainers) {
    const containerId = `docker:${c.name}`

    for (const dep of c.dependsOn) {
      const depId = `docker:${dep}`
      queries.insertEdge(containerId, depId, 'depends_on',
        JSON.stringify({ from: c.name, to: dep }), 0, 0)
    }

    const moduleNodes = queries.getAllNodes()
    for (const n of moduleNodes) {
      if (n.moduleId && n.name.toLowerCase().includes(c.name.toLowerCase())) {
        queries.insertEdge(containerId, n.id, 'deploy_mapping',
          JSON.stringify({ container: c.name, image: c.image }), 0, 0)
      }
    }
  }

  return allContainers
}
