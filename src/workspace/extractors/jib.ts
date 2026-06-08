import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'

export interface JibConfig {
  from: { image: string }
  to: { image: string }
  container: { jvmFlags: string[]; mainClass: string; ports: string[]; format: string }
  skip: boolean
}

function extractXmlBlock(xml: string, tag: string): string | null {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = xml.indexOf(open)
  if (start === -1) return null
  const end = xml.indexOf(close, start + open.length)
  if (end === -1) return null
  return xml.substring(start + open.length, end)
}

function extractXmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`)
  const m = re.exec(xml)
  return m ? m[1].trim() : ''
}

export function parseJibConfig(pomContent: string): JibConfig | null {
  const pluginBlock = pomContent.match(/<plugin>[\s\S]*?<artifactId>jib-maven-plugin<\/artifactId>[\s\S]*?<\/plugin>/)
  if (!pluginBlock) return null

  const configBlock = extractXmlBlock(pluginBlock[0], 'configuration')
  if (!configBlock) return null

  const fromBlock = extractXmlBlock(configBlock, 'from')
  const toBlock = extractXmlBlock(configBlock, 'to')
  const containerBlock = extractXmlBlock(configBlock, 'container')
  const skipVal = extractXmlTag(configBlock, 'skip')

  return {
    from: {
      image: fromBlock ? extractXmlTag(fromBlock, 'image') : '',
    },
    to: {
      image: toBlock ? extractXmlTag(toBlock, 'image') : '',
    },
    container: {
      jvmFlags: containerBlock
        ? [...containerBlock.matchAll(/<flag>([^<]*)<\/flag>/g)].map(m => m[1])
        : [],
      mainClass: containerBlock ? extractXmlTag(containerBlock, 'mainClass') : '',
      ports: containerBlock
        ? [...containerBlock.matchAll(/<port>([^<]*)<\/port>/g)].map(m => m[1])
        : [],
      format: containerBlock ? extractXmlTag(containerBlock, 'format') || 'Docker' : 'Docker',
    },
    skip: skipVal === 'true',
  }
}

function extractRegistryUrl(image: string): string {
  if (image.includes('docker.io') || image.includes('dockerhub')) return 'docker.io'
  const registryMatch = image.match(/^([^/]+\.[^/]+)\//)
  return registryMatch ? registryMatch[1] : ''
}

export class JibExtractor implements IExtractor {
  name = 'jib'

  async extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    const pomPath = join(projectRoot, 'pom.xml')
    if (!existsSync(pomPath)) return { provides, consumes }

    try {
      const content = readFileSync(pomPath, 'utf-8')
      const config = parseJibConfig(content)
      if (!config || config.skip) return { provides, consumes }

      const serviceName = projectRoot.split(/[/\\]/).pop() || 'unknown'
      const moduleId = serviceName
      const toImage = config.to.image || `${serviceName}:latest`
      const registryUrl = extractRegistryUrl(toImage)
      const ports = JSON.stringify(config.container.ports)
      const jvmFlags = JSON.stringify(config.container.jvmFlags)

      const id = `jib:${serviceName}`
      queries.insertContainerImage(id, serviceName, toImage, registryUrl, config.from.image, ports, jvmFlags, 'jib', pomPath, moduleId)

      provides.push({
        id,
        name: serviceName,
        kind: 'container_image',
        signature: `from:${config.from.image}, to:${toImage}, ports:${config.container.ports.join(',') || '-'}`,
      })

      if (registryUrl) {
        provides.push({
          id: `registry:${registryUrl}`,
          name: registryUrl,
          kind: 'container_registry',
          signature: `push target for ${serviceName}`,
        })
      }
    } catch { /* silent */ }

    return { provides, consumes }
  }
}
