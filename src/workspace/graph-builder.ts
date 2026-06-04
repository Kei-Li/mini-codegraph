import type { QueryManager } from '../db/queries.js'
import type { ExternalSymbol, ExternalReference } from '../types.js'

export class WorkspaceGraphBuilder {
  private queries: QueryManager
  private currentService: string

  constructor(queries: QueryManager, currentService: string) {
    this.queries = queries
    this.currentService = currentService
  }

  buildGlobalGraph(
    allProjectsProvides: Map<string, { id: string; name: string; kind: string; signature: string }[]>,
    currentProjectConsumes: { symbolId: string; referenceType: string; sourceLocation: string }[]
  ): { symbols: ExternalSymbol[]; refs: ExternalReference[] } {
    const symbolMap = new Map<string, ExternalSymbol>()
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
      }
    }

    for (const consume of currentProjectConsumes) {
      const matchedSymbol = symbolMap.get(consume.symbolId)
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

  async refreshExternalTables(
    allProvides: Map<string, { id: string; name: string; kind: string; signature: string }[]>,
    currentConsumes: { symbolId: string; referenceType: string; sourceLocation: string }[]
  ): Promise<void> {
    const { symbols: newSymbols, refs: newRefs } = this.buildGlobalGraph(allProvides, currentConsumes)

    const newSymbolMap = new Map(newSymbols.map(s => [s.id, s]))
    const newRefKeySet = new Set(newRefs.map(r => `${r.externalSymbolId}:${r.sourceLocation}:${r.referenceType}`))

    const existingSymbols = this.queries.getAllExternalSymbols()
    const existingRefs = this.queries.getAllExternalReferences()

    const existingSymbolMap = new Map(existingSymbols.map(s => [s.id, s]))
    const existingRefKeySet = new Set(existingRefs.map(r => `${r.symbolName}:${r.sourceLocation}:${r.serviceName ?? ''}`))

    const existingByService = new Set(
      existingSymbols.filter(s => s.serviceName === this.currentService).map(s => s.id)
    )
    const existingRefsByService = new Set(
      existingRefs.filter(r => r.serviceName === this.currentService)
        .map(r => `${r.symbolName}:${r.sourceLocation}:${r.serviceName ?? ''}`)
    )

    for (const sym of newSymbols) {
      const existing = existingSymbolMap.get(sym.id)
      if (!existing || existing.signature !== sym.signature || existing.kind !== sym.kind) {
        if (existing) {
          this.queries.getDb().exec(
            `UPDATE external_symbols SET name='${sym.name.replace(/'/g, "''")}', kind='${sym.kind.replace(/'/g, "''")}', providing_service='${sym.providingService.replace(/'/g, "''")}', signature='${(sym.signature ?? '').replace(/'/g, "''")}' WHERE id='${sym.id.replace(/'/g, "''")}'`
          )
        } else {
          this.queries.insertExternalSymbol(sym.id, sym.name, sym.kind, sym.providingService, sym.definitionFile, sym.signature, sym.metadata)
        }
      }
    }

    for (const esym of existingSymbols) {
      if (esym.serviceName === this.currentService && !newSymbolMap.has(esym.id)) {
        this.queries.getDb().exec(`DELETE FROM external_symbols WHERE id = '${esym.id.replace(/'/g, "''")}'`)
      }
    }

    for (const ref of newRefs) {
      const refKey = `${ref.externalSymbolId}:${ref.sourceLocation}:${ref.referenceType}`
      if (!existingRefKeySet.has(refKey)) {
        this.queries.insertExternalReference(ref.sourceLocation, ref.externalSymbolId, ref.referenceType, ref.targetService, ref.metadata)
      }
    }

    for (const existing of existingRefs) {
      const refKey = `${existing.symbolName}:${existing.sourceLocation}:${existing.serviceName ?? ''}`
      if ((existing.serviceName === this.currentService || existingRefsByService.has(refKey)) && !newRefKeySet.has(refKey)) {
        this.queries.getDb().exec(
          `DELETE FROM external_references WHERE id = ${existing.id}`
        )
      }
    }
  }
}
