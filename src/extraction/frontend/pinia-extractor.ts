import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../../db/queries.js'

export interface PiniaStore {
  name: string
  filePath: string
  stateKeys: string[]
  actions: string[]
  getters: string[]
  usedInComponents: string[]
}

export function extractPiniaStores(source: string, filePath: string): PiniaStore[] {
  const stores: PiniaStore[] = []

  const nameMatch = source.match(/defineStore\s*\(\s*['"](\w+)['"]/)
  if (!nameMatch) return stores

  const storeName = nameMatch[1]
  const stateKeys: string[] = []
  const actions: string[] = []
  const getters: string[] = []

  const arrowFn = source.match(/\(\)\s*=>\s*\(\{([\s\S]*?\})\)/)
  if (arrowFn) {
    const body = arrowFn[1]
    const keyMatches = body.matchAll(/(?:const\s+)?(\w+)\s*(?::|=[\s\S]*?ref|reactive|computed)/g)
    for (const km of keyMatches) {
      if (km[0].includes('computed')) getters.push(km[1])
      else stateKeys.push(km[1])
    }
  }

  const fnMatches = source.matchAll(/(?:const\s+)?(\w+)\s*=\s*(?:async\s+)?\(/g)
  for (const fm of fnMatches) {
    if (!['if', 'for', 'while', 'switch', 'function', 'return', 'state', 'getters', 'actions'].includes(fm[1]) && fm[1] !== storeName) {
      actions.push(fm[1])
    }
  }

  stores.push({ name: storeName, filePath, stateKeys, actions, getters, usedInComponents: [] })
  return stores
}

export function findPiniaUsages(source: string, _currentFile: string): string[] {
  const usages: string[] = []
  const storePatterns = [
    /use(\w+Store)\s*\(/g,
    /(\w+Store)\s*(?:\(\))/g,
  ]
  for (const pattern of storePatterns) {
    let m: RegExpExecArray | null
    while ((m = pattern.exec(source)) !== null) {
      usages.push(m[1])
    }
  }
  return usages
}

export function indexPiniaStores(
  queries: QueryManager,
  source: string,
  filePath: string,
  _moduleId: string,
  projectRoot?: string
): PiniaStore[] {
  const stores = extractPiniaStores(source, filePath)
  if (stores.length === 0) return stores

  for (const store of stores) {
    const storeId = `pinia:${store.name}`

    const allNodes = queries.getAllNodes()
    for (const n of allNodes) {
      if (n.filePath.endsWith('.vue') && n.language === 'vue') {
        try {
          const absPath = projectRoot ? join(projectRoot, n.filePath) : n.filePath
          const vueSource = readFileSync(absPath, 'utf-8')
          const usages = findPiniaUsages(vueSource, n.filePath)
          if (usages.some(u => u.toLowerCase().includes(store.name.toLowerCase()))) {
            queries.insertEdge(storeId, n.id, 'store_used_by',
              JSON.stringify({ store: store.name, component: n.filePath }), 0, 0)
            store.usedInComponents.push(n.filePath)
          }
        } catch { /* silent */ }
      }
    }
  }

  return stores
}
