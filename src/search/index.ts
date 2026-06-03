export { damerauLevenshtein, findFuzzyMatches, extractSearchTerms, matchCamelCase, splitCamelCase } from './fuzzy.js'

import { parseSearchQuery, buildFtsQuery, filterNodesByKind, filterNodesByLanguage, filterNodesByFile } from './query-parser.js'
import type { ParsedQuery as PQP } from './query-parser.js'
import { findFuzzyMatches } from './fuzzy.js'
import { computePathRelevance } from '../generated.js'
import type { MiniCodeGraphNode } from '../types.js'

export type ParsedQuery = PQP

export function runQualifiedSearch(
  query: string,
  searchFn: (query: string, limit: number) => { node: MiniCodeGraphNode; rank: number }[],
  fuzzyFallbackFn?: (query: string, limit: number) => { node: MiniCodeGraphNode; rank: number }[],
  limit = 20
): { node: MiniCodeGraphNode; rank: number }[] {
  const parsed = parseSearchQuery(query)
  const rawResults = searchFn(parsed.text || query, limit)

  let results = rawResults

  if (parsed.kind) {
    results = results.filter(r => parsed.kind!.split(',').includes(r.node.kind))
  }
  if (parsed.language) {
    results = results.filter(r => r.node.language === parsed.language)
  }
  if (parsed.file) {
    const regex = new RegExp(parsed.file.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i')
    results = results.filter(r => regex.test(r.node.filePath))
  }
  if (parsed.name) {
    const nameLower = parsed.name.toLowerCase()
    results = results.filter(r =>
      r.node.name.toLowerCase().includes(nameLower) ||
      r.node.qualifiedName.toLowerCase().includes(nameLower)
    )
  }

  if (results.length === 0 && fuzzyFallbackFn && parsed.text) {
    results = fuzzyFallbackFn(parsed.text, limit)
  }

  results.sort((a, b) => {
    const relevA = computePathRelevance(a.node.filePath)
    const relevB = computePathRelevance(b.node.filePath)
    if (relevA !== relevB) return relevB - relevA
    return b.rank - a.rank
  })

  return results.slice(0, limit)
}

export function fuzzySearchFallback(
  query: string,
  allNodes: MiniCodeGraphNode[],
  limit = 10
): { node: MiniCodeGraphNode; rank: number }[] {
  const fuzzyMatches = findFuzzyMatches(query, allNodes.map(n => ({ id: n.id, name: n.name, qualifiedName: n.qualifiedName })), limit)
  const nodeMap = new Map(allNodes.map(n => [n.id, n]))
  return fuzzyMatches
    .map(m => ({ node: nodeMap.get(m.id)!, rank: 1 / (m.distance + 1) }))
    .filter(m => m.node)
}

export { parseSearchQuery, buildFtsQuery, filterNodesByKind, filterNodesByLanguage, filterNodesByFile } from './query-parser.js'
