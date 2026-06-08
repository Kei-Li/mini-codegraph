import type { QueryManager } from '../../db/queries.js'

export interface ReactComponent {
  filePath: string
  componentName: string
  isDefaultExport: boolean
  hooks: string[]
  props: string[]
  children: string[]
}

export interface ReactHook {
  filePath: string
  hookName: string
  usedHooks: string[]
  dependencies: string[]
}

export interface ReduxStore {
  filePath: string
  storeName: string
  slices: string[]
  middleware: string[]
}

export interface ZustandStore {
  filePath: string
  storeName: string
  stateFields: string[]
  actions: string[]
}

export interface ReactQueryHook {
  filePath: string
  hookName: string
  queryKey: string
  endpoint: string
  method: string
}

export function extractReactComponents(source: string, filePath: string): ReactComponent[] {
  const components: ReactComponent[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    const arrowMatch = line.match(/(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+(\w+)\s*[=:]\s*(?:React\.)?memo\s*(?:<\w+>\s*)?\(?\s*(?:\([^)]*\)\s*)?=>/);
    if (arrowMatch) {
      const name = arrowMatch[1]
      const isDefaultExport = line.includes('export default')
      const hooks: string[] = []
      const propsMatch = line.match(/\(([^)]*)\)/)
      const props = propsMatch ? propsMatch[1].split(',').map(p => p.trim().replace(/[{}]/g, '').split(':')[0].trim()).filter(Boolean) : []

      for (let j = Math.max(0, i - 1); j < Math.min(lines.length, i + 80); j++) {
        const hook = lines[j].match(/(use\w+)\(/g)
        if (hook) hooks.push(...hook.map(h => h.replace('(', '')))
      }

      const children: string[] = []
      for (let j = i; j < Math.min(lines.length, i + 80); j++) {
        const jsxMatch = lines[j].match(/<(\w+)[^>]*>/g)
        if (jsxMatch) children.push(...jsxMatch.map(t => t.replace(/[<>]/g, '')))
      }

      components.push({ filePath, componentName: name, isDefaultExport, hooks, props, children })
      continue
    }

    const funcMatch = line.match(/(?:export\s+(?:default\s+)?)?function\s+(\w+)\s*(?:<\w+>\s*)?\([^)]*\)\s*(?::\s*\w+)?\s*{/);
    if (funcMatch) {
      const name = funcMatch[1]
      if (!name.match(/^use[A-Z]/) && !name.startsWith('_')) {
        const isDefaultExport = line.includes('export default')
        const hooks: string[] = []
        const propsMatch = line.match(/\(([^)]*)\)/)
        const props = propsMatch ? propsMatch[1].split(',').map(p => p.trim().split(':')[0].trim()).filter(Boolean) : []

        for (let j = i; j < Math.min(lines.length, i + 60); j++) {
          const hook = lines[j].match(/(use\w+)\(/g)
          if (hook) hooks.push(...hook.map(h => h.replace('(', '')))
        }

        const children: string[] = []
        for (let j = i; j < Math.min(lines.length, i + 60); j++) {
          const jsxMatch = lines[j].match(/<(\w+)[^>]*>/g)
          if (jsxMatch) children.push(...jsxMatch.map(t => t.replace(/[<>]/g, '')))
        }

        components.push({ filePath, componentName: name, isDefaultExport, hooks, props, children })
      }
    }
  }

  return components
}

export function extractReduxStore(source: string, filePath: string): ReduxStore | null {
  if (!source.includes('configureStore') && !source.includes('createSlice')) return null

  const sliceMatches = source.match(/createSlice\s*\(\s*{[^}]*name:\s*['"](\w+)['"]/g)
  const slices: string[] = []
  if (sliceMatches) {
    for (const m of sliceMatches) {
      const nameMatch = m.match(/name:\s*['"](\w+)['"]/)
      if (nameMatch) slices.push(nameMatch[1])
    }
  }

  const storeMatch = source.match(/(?:export\s+)?(?:const\s+)?(\w+Store)\s*[=:]\s*configureStore/)
  const storeName = storeMatch ? storeMatch[1] : 'store'

  const middleware: string[] = []
  const mwMatch = source.match(/middleware\s*:\s*\([^)]*\)\s*=>\s*[^)]*(?:concat|prepend)\(([^)]*)\)/)
  if (mwMatch) {
    middleware.push(...mwMatch[1].split(',').map(m => m.trim()).filter(Boolean))
  }

  return { filePath, storeName, slices, middleware }
}

export function extractZustandStore(source: string, filePath: string): ZustandStore | null {
  if (!source.includes('create')) return null

  const storeMatch = source.match(/(?:export\s+)?(?:const\s+)?use(\w+Store)\s*[=:]\s*create\s*</)
  if (!storeMatch) return null

  const storeName = storeMatch[1]
  const stateFields: string[] = []
  const actions: string[] = []

  const stateMatch = source.match(/(?:interface|type)\s+\w+\s*{[^}]*}/)
  if (stateMatch) {
    const fieldMatches = stateMatch[0].matchAll(/(\w+)\s*[?:]\s*[^;]+;/g)
    for (const f of fieldMatches) stateFields.push(f[1])
  }

  const actionMatches = source.matchAll(/(\w+):\s*(?:\([^)]*\)\s*=>|async\s*\([^)]*\)\s*=>)/g)
  for (const a of actionMatches) {
    if (!a[1].startsWith('_')) actions.push(a[1])
  }

  return { filePath, storeName: `use${storeName}`, stateFields, actions }
}

export function extractReactQuery(source: string, filePath: string): ReactQueryHook[] {
  const hooks: ReactQueryHook[] = []
  if (!source.includes('useQuery') && !source.includes('useMutation') && !source.includes('useInfiniteQuery')) return hooks

  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    const useQueryMatch = line.match(/(?:const\s+)?(?:\{[^}]*\}\s*=\s*)?use(?:Infinite)?Query\s*\(\s*{?\s*(?:queryKey\s*:\s*)?\[/);
    if (useQueryMatch) {
      let keyBlock = lines.slice(i, i + 5).join(' ')
      const keyMatch = keyBlock.match(/(?:queryKey\s*:\s*)?\[([^\]]*)\]/)
      const queryKey = keyMatch ? keyMatch[1].trim() : ''

      const queryFnMatch = keyBlock.match(/queryFn\s*:\s*(?:\([^)]*\)\s*=>\s*)?(\w+)/)
      const endpoint = queryFnMatch ? queryFnMatch[1] : ''

      const hookName = `use${queryKey.replace(/['"]/g, '').split('/').pop() || 'Query'}`

      hooks.push({ filePath, hookName, queryKey, endpoint, method: 'GET' })
      continue
    }

    const useMutationMatch = line.match(/(?:const\s+)?(?:\{[^}]*\}\s*=\s*)?useMutation\s*\(/);
    if (useMutationMatch) {
      let keyBlock = lines.slice(i, i + 4).join(' ')
      const mutationFnMatch = keyBlock.match(/mutationFn\s*:\s*(?:\([^)]*\)\s*=>\s*)?(\w+)/)
      const endpoint = mutationFnMatch ? mutationFnMatch[1] : ''

      hooks.push({ filePath, hookName: `use${endpoint || 'Mutation'}Mutation`, queryKey: '', endpoint, method: 'POST' })
    }
  }

  return hooks
}

export function indexReactComponents(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): { components: ReactComponent[]; stores: (ReduxStore | ZustandStore)[]; queriesFound: ReactQueryHook[] } {
  const components = extractReactComponents(source, filePath)
  const reduxStore = extractReduxStore(source, filePath)
  const zustandStore = extractZustandStore(source, filePath)
  const reactQueries = extractReactQuery(source, filePath)

  for (const comp of components) {
    const nodeId = `react:${filePath}:${comp.componentName}`
    const className = filePath.split('/').pop()?.replace(/\.(tsx|ts|jsx|js)$/, '') || ''

    queries.insertNode({
      id: nodeId,
      kind: 'component',
      name: comp.componentName,
      qualifiedName: comp.componentName,
      filePath,
      language: 'typescript',
      startLine: 0,
      endLine: 0,
      startColumn: 0,
      endColumn: 0,
      docstring: '',
      signature: JSON.stringify({ hooks: comp.hooks, props: comp.props, children: comp.children.slice(0, 20) }),
      visibility: 'public',
      isExported: comp.isDefaultExport,
      parentId: null,
      moduleId,
    })

    const parentNodes = queries.searchNodes(className, 3).filter(n => n.moduleId === moduleId && n.filePath === filePath)
    for (const pn of parentNodes) {
      queries.insertEdge(pn.id, nodeId, 'contains', JSON.stringify({ kind: 'react_component' }), 0, 0)
    }

    for (const hook of comp.hooks) {
      const hookId = `react:hook:${filePath}:${hook}`
      queries.insertNode({
        id: hookId, kind: 'hook', name: hook, qualifiedName: hook, filePath, language: 'typescript',
        startLine: 0, endLine: 0, startColumn: 0, endColumn: 0, docstring: '', signature: '',
        visibility: 'public', isExported: false, parentId: null, moduleId,
      })
      queries.insertEdge(nodeId, hookId, 'references', JSON.stringify({ kind: 'hook_usage' }), 0, 0)
    }
  }

  const stores: (ReduxStore | ZustandStore)[] = []
  if (reduxStore) {
    stores.push(reduxStore)
    const nodeId = `react:store:${filePath}:${reduxStore.storeName}`
    queries.insertNode({
      id: nodeId, kind: 'store', name: reduxStore.storeName, qualifiedName: reduxStore.storeName,
      filePath, language: 'typescript', startLine: 0, endLine: 0, startColumn: 0, endColumn: 0,
      docstring: '', signature: JSON.stringify({ slices: reduxStore.slices, middleware: reduxStore.middleware }),
      visibility: 'public', isExported: true, parentId: null, moduleId,
    })
  }

  if (zustandStore) {
    stores.push(zustandStore)
    const nodeId = `react:store:${filePath}:${zustandStore.storeName}`
    queries.insertNode({
      id: nodeId, kind: 'store', name: zustandStore.storeName, qualifiedName: zustandStore.storeName,
      filePath, language: 'typescript', startLine: 0, endLine: 0, startColumn: 0, endColumn: 0,
      docstring: '', signature: JSON.stringify({ stateFields: zustandStore.stateFields, actions: zustandStore.actions }),
      visibility: 'public', isExported: true, parentId: null, moduleId,
    })
  }

  for (const rq of reactQueries) {
    const nodeId = `react:query:${filePath}:${rq.hookName}`
    queries.insertNode({
      id: nodeId, kind: 'query_hook', name: rq.hookName, qualifiedName: rq.hookName,
      filePath, language: 'typescript', startLine: 0, endLine: 0, startColumn: 0, endColumn: 0,
      docstring: '', signature: JSON.stringify({ queryKey: rq.queryKey, endpoint: rq.endpoint, method: rq.method }),
      visibility: 'public', isExported: true, parentId: null, moduleId,
    })

    if (rq.endpoint) {
      const endpointNodes = queries.searchNodes(rq.endpoint, 3)
      for (const en of endpointNodes) {
        queries.insertEdge(nodeId, en.id, 'calls', JSON.stringify({ kind: 'api_call', method: rq.method }), 0, 0)
      }
    }
  }

  return { components, stores, queriesFound: reactQueries }
}
