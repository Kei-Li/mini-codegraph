import type { QueryManager } from '../db/queries.js'
import type { ExternalSymbol, ExternalReference } from '../types.js'

const KIND_COMPAT: Record<string, string[]> = {
  rpc_call: ['http_endpoint', 'gateway_route'],
  http_request: ['http_endpoint', 'gateway_route'],
  mq_publish: ['mq_queue', 'mq_exchange'],
  mq_subscribe: ['mq_queue', 'mq_exchange'],
  cache_get: ['cache_key'],
  cache_put: ['cache_key'],
  db_rw: ['db_table', 'db_collection', 'db_table'],
  gateway_route: ['http_endpoint'],
}

function candidateScore(consume: { symbolId: string; referenceType: string }, provide: { id: string; name: string; kind: string; signature: string }): number {
  let score = 0

  const compat = KIND_COMPAT[consume.referenceType] || ['http_endpoint', 'gateway_route', 'mq_queue', 'cache_key', 'db_table']
  if (compat.includes(provide.kind)) {
    score += 10
  }

  const consumeLower = consume.symbolId.toLowerCase()
  const nameWords = provide.name.split(/(?=[A-Z])/).map(w => w.toLowerCase()).filter(Boolean)
  for (const w of nameWords) {
    if (w.length >= 3 && consumeLower.includes(w)) {
      score += 5
    }
  }

  const idWords = provide.id.toLowerCase().split(/[.\-_]/).filter(w => w.length >= 3)
  for (const w of idWords) {
    if (consumeLower.includes(w)) {
      score += 3
    }
  }

  const sig = (provide.signature ?? '').toLowerCase()
  if (sig) {
    const sigWords = sig.split(/[\s,/()]+/).filter(w => w.length >= 3)
    for (const w of sigWords) {
      if (consumeLower.includes(w)) {
        score += 2
      }
    }
  }

  return score
}

export class WorkspaceGraphBuilder {
  private queries: QueryManager
  private currentService: string

  constructor(queries: QueryManager, currentService: string) {
    this.queries = queries
    this.currentService = currentService
  }

  setCurrentService(service: string): void {
    this.currentService = service
  }

  buildGlobalGraph(
    allProjectsProvides: Map<string, { id: string; name: string; kind: string; signature: string }[]>,
    currentProjectConsumes: { symbolId: string; referenceType: string; sourceLocation: string }[]
  ): { symbols: ExternalSymbol[]; refs: ExternalReference[] } {
    const symbolMap = new Map<string, ExternalSymbol>()
    const byService = new Map<string, ExternalSymbol[]>()
    const refs: ExternalReference[] = []

    for (const [serviceName, provides] of allProjectsProvides) {
      for (const p of provides) {
        const sym: ExternalSymbol = {
          id: p.id,
          name: p.name,
          kind: p.kind,
          providingService: serviceName,
          definitionFile: '',
          signature: p.signature,
          metadata: '{}',
        }
        symbolMap.set(p.id, sym)
        const list = byService.get(serviceName) || []
        list.push(sym)
        byService.set(serviceName, list)
      }
    }

    for (const consume of currentProjectConsumes) {
      let matchedSymbol = symbolMap.get(consume.symbolId)
      if (!matchedSymbol) {
        const svcMatch = consume.symbolId.match(/\.(\w[\w-]*)\.[^.]+$/)
        if (svcMatch) {
          const candidates = byService.get(svcMatch[1]) || []
          if (candidates.length > 0) {
            let bestScore = -1
            let bestIdx = 0
            for (let i = 0; i < candidates.length; i++) {
              const score = candidateScore(consume, candidates[i])
              if (score > bestScore) {
                bestScore = score
                bestIdx = i
              }
            }
            // Require minimum score to avoid false positives:
            // need at least kind match (10) AND at least one name/id overlap (>=15 total)
            if (bestScore >= 15) {
              matchedSymbol = candidates[bestIdx]
            }
          }
        }
      }
      if (matchedSymbol) {
        refs.push({
          id: 0,
          sourceLocation: consume.sourceLocation,
          externalSymbolId: matchedSymbol.id,
          referenceType: consume.referenceType,
          targetService: matchedSymbol.providingService,
          metadata: '{}',
        })
      }
    }

    return { symbols: Array.from(symbolMap.values()), refs }
  }

  async buildServiceDependencies(): Promise<void> {
    const db = this.queries.getDb()
    const depEdges = db.prepare(`SELECT source, target, metadata FROM edges WHERE kind = 'maven_depends_on'`).all() as { source: string; target: string; metadata: string }[]
    for (const e of depEdges) {
      const srcModule = db.prepare(`SELECT module_id FROM nodes WHERE id = ?`).get(e.source) as { module_id: string } | undefined
      const tgtModule = db.prepare(`SELECT module_id FROM nodes WHERE id = ?`).get(e.target) as { module_id: string } | undefined
      if (srcModule && tgtModule && srcModule.module_id !== tgtModule.module_id) {
        let meta: Record<string, any> = {}
        try { meta = JSON.parse(e.metadata) } catch { /* ignore */ }
        this.queries.insertServiceDependency(
          srcModule.module_id,
          tgtModule.module_id,
          meta.scope || 'compile',
          meta.optional ? 1 : 0,
          'maven_pom',
          srcModule.module_id
        )
      }
    }
  }

  async refreshExternalTables(
    allProvides: Map<string, { id: string; name: string; kind: string; signature: string }[]>,
    currentConsumes: { symbolId: string; referenceType: string; sourceLocation: string }[]
  ): Promise<void> {
    this.queries.deleteServiceDependenciesByService(this.currentService)
    await this.buildServiceDependencies()
    const { symbols: newSymbols, refs: newRefs } = this.buildGlobalGraph(allProvides, currentConsumes)

    const newSymbolMap = new Map(newSymbols.map(s => [s.id, s]))
    const newRefKeySet = new Set(newRefs.map(r => `${r.externalSymbolId}:${r.sourceLocation}:${r.targetService}`))

    const existingSymbols = this.queries.getAllExternalSymbols()
    const existingRefs = this.queries.getAllExternalReferences()

    const existingSymbolMap = new Map(existingSymbols.map(s => [s.id, s]))
    const existingRefKeySet = new Set(existingRefs.map(r => `${r.symbolName}:${r.sourceLocation}:${r.serviceName ?? ''}`))

    for (const sym of newSymbols) {
      const existing = existingSymbolMap.get(sym.id)
      if (!existing || existing.signature !== sym.signature || existing.kind !== sym.kind) {
        if (existing) {
          this.queries.updateExternalSymbol(sym.id, sym.name, sym.kind, sym.providingService, sym.signature ?? '')
        } else {
          this.queries.insertExternalSymbol(sym.id, sym.name, sym.kind, sym.providingService, sym.definitionFile, sym.signature, sym.metadata)
        }
      }
    }

    for (const esym of existingSymbols) {
      if (esym.serviceName === this.currentService && !newSymbolMap.has(esym.id)) {
        this.queries.deleteExternalSymbol(esym.id)
      }
    }

    for (const ref of newRefs) {
      const refKey = `${ref.externalSymbolId}:${ref.sourceLocation}:${ref.targetService}`
      if (!existingRefKeySet.has(refKey)) {
        this.queries.insertExternalReference(ref.sourceLocation, ref.externalSymbolId, ref.referenceType, ref.targetService, ref.metadata, this.currentService)
        this.upsertSyntheticNode(ref.externalSymbolId, ref.referenceType, ref.targetService)
      }
    }

    for (const existing of existingRefs) {
      const refKey = `${existing.symbolName}:${existing.sourceLocation}:${existing.serviceName ?? ''}`
      if ((existing.sourceService === this.currentService) && !newRefKeySet.has(refKey)) {
        this.queries.deleteExternalReference(existing.id as unknown as number)
      }
    }
  }

  private upsertSyntheticNode(symbolId: string, kind: string, serviceName: string): void {
    const nodeId = `ext://${symbolId}`
    const name = symbolId.includes('.') ? symbolId.split('.').pop() || symbolId : symbolId
    const kindMap: Record<string, string> = {
      rpc_call: 'external_endpoint',
      http_request: 'external_endpoint',
      mq_publish: 'external_queue',
      mq_subscribe: 'external_queue',
      cache_get: 'external_cache',
      db_rw: 'external_table',
      gateway_route: 'external_gateway',
    }
    const nodeKind = kindMap[kind] || 'external_symbol'
    const fpath = `external://${serviceName}`
    const db = this.queries.getDb()
    const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(nodeId) as { id: string } | undefined
    if (!existing) {
      db.prepare(
        `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, signature, is_exported, module_id)
         VALUES (?, ?, ?, ?, ?, 'workspace', 0, 0, 0, 0, ?, 1, ?)`
      ).run(nodeId, nodeKind, name, nodeId, fpath, kind, serviceName)
    }
  }
}
