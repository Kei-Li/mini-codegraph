import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'

function safeJsonParse(text: string): any {
  try { return JSON.parse(text) } catch { return {} }
}

function collectFiles(dir: string, ext: string): string[] {
  const files: string[] = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) files.push(...collectFiles(full, ext))
      else if (e.name.endsWith(ext)) files.push(full)
    }
  } catch { /* silent */ }
  return files
}

function detectBaseUrl(projectRoot: string): string[] {
  const urls: string[] = []
  const envFiles = ['.env', '.env.development', '.env.production', '.env.local']
  for (const f of envFiles) {
    const fp = join(projectRoot, f)
    if (existsSync(fp)) {
      try {
        const content = readFileSync(fp, 'utf-8')
        const m = content.match(/(?:VITE_)?API_BASE_URL\s*=\s*["']?(https?:\/\/[^"'\s]+)["']?/)
        if (m) urls.push(m[1])
      } catch { /* silent */ }
    }
  }
  const configFiles = ['vite.config.ts', 'vite.config.js', 'next.config.js', 'proxy.conf.json']
  for (const f of configFiles) {
    const fp = join(projectRoot, f)
    if (existsSync(fp)) {
      try {
        const content = readFileSync(fp, 'utf-8')
        const m = content.match(/target\s*:\s*["'](https?:\/\/[^"']+)["']/)
        if (m) urls.push(m[1])
        const m2 = content.match(/proxy\s*:\s*\{[^}]*?target\s*:\s*["'](https?:\/\/[^"']+)["']/)
        if (m2) urls.push(m2[1])
      } catch { /* silent */ }
    }
  }
  return urls
}

function scanApiCallsInSource(content: string): string[] {
  const paths: string[] = []
  const patterns = [
    /["']\/(?:api\/[^"']+)["']/g,
    /axios\s*[.(].*?["']\/(?:api\/[^"']+)["']/g,
    /fetch\s*\(\s*["']\/(?:api\/[^"']+)["']/g,
    /this\.http\s*[.(].*?["']\/(?:api\/[^"']+)["']/g,
    /http\s*\.(?:get|post|put|delete|patch)\s*\(\s*["']\/(?:api\/[^"']+)["']/g,
  ]
  for (const p of patterns) {
    let m: RegExpExecArray | null
    while ((m = p.exec(content)) !== null) {
      const path = m[1] || m[0]
      if (!paths.includes(path)) paths.push(path)
    }
  }
  return paths
}

export class FrontendExtractor implements IExtractor {
  name = 'frontend'

  async extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    // Local DB data (Vue api_mapping edges, React query nodes)
    const vueApiEdges = queries.getAllEdges().filter(e => e.kind === 'api_mapping')
    for (const edge of vueApiEdges) {
      try {
        const meta = safeJsonParse(edge.metadata || '{}')
        consumes.push({
          symbolId: `http.${meta.path || edge.targetId}`,
          referenceType: 'http_request',
          sourceLocation: edge.sourceId,
        })
      } catch { /* silent */ }
    }

    const reactQueryNodes = queries.getAllNodes().filter(n => n.id.startsWith('react:query:'))
    for (const node of reactQueryNodes) {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        if (meta.endpoint) {
          consumes.push({
            symbolId: `http.${meta.endpoint}`,
            referenceType: 'http_request',
            sourceLocation: `${node.filePath}:${node.startLine}:${node.startColumn}`,
          })
        }
      } catch { /* silent */ }
    }

    // Cross-repo matching: scan frontend source files for API calls
    // and match against known backend endpoints in external_symbols
    const srcDir = join(projectRoot, 'src')
    const apiPaths: string[] = []
    if (existsSync(srcDir)) {
      for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.vue']) {
        for (const f of collectFiles(srcDir, ext)) {
          try {
            const content = readFileSync(f, 'utf-8')
            apiPaths.push(...scanApiCallsInSource(content))
          } catch { /* silent */ }
        }
      }
    }

    const knownEndpoints = queries.getAllExternalSymbols()
      .filter(s => s.kind === 'http_endpoint')

    for (const path of apiPaths) {
      const cleanPath = path.replace(/["']/g, '').replace(/^https?:\/\/[^/]+/, '')
      for (const ep of knownEndpoints) {
        const epPath = (ep.signature || '').split(' ').pop() || ''
        if (cleanPath.includes(epPath) || epPath.includes(cleanPath)) {
          consumes.push({
            symbolId: `http.match.${ep.id}`,
            referenceType: 'http_request',
            sourceLocation: `${projectRoot}:${cleanPath}`,
          })
          break
        }
      }
    }

    return { provides, consumes }
  }
}
