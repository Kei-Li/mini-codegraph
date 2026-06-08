import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../../db/queries.js'
import type { MiniCodeGraphNode, UnresolvedReference, FrameworkDetectionResult } from '../../types.js'


const VUE_COMPILER_MACROS = new Set([
  'defineProps', 'defineEmits', 'defineExpose', 'defineOptions',
  'defineSlots', 'defineModel', 'withDefaults',
])

const NUXT_AUTO_IMPORTS = new Set([
  'useRouter', 'useRoute', 'useHead', 'useSeoMeta', 'useNuxtApp',
  'useRuntimeConfig', 'useFetch', 'useAsyncData', 'useLazyFetch',
  'useLazyAsyncData', 'refreshNuxtData', 'clearNuxtData',
  'useCookie', 'useRequestHeaders', 'useRequestEvent',
  'useState', 'useAppConfig', 'navigateTo', 'abortNavigation',
  'addRouteMiddleware', 'definePageMeta', 'useLocalePath',
  'useSwitchLocalePath', 'useLocaleRoute',
])

const NUXT_VIRTUAL_MODULES = ['#imports', '#components', '#app', '#build', '#head']

export interface VueTemplateInfo {
  componentRefs: string[]
  eventBindings: { event: string; handler: string; line: number }[]
  slotUsages: string[]
  directives: string[]
}

export function detectVue(projectRoot: string): FrameworkDetectionResult | null {
  const pkgPath = join(projectRoot, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>

      if (deps.vue || deps.nuxt || deps['@nuxt/kit'] || deps['vue-router']) {
        const version = deps.vue?.replace('^', '').replace('~', '') || 'unknown'
        return { name: 'vue', version, confidence: deps.vue ? 0.95 : 0.8 }
      }
    } catch { /* silent */ }
  }

  const pagesDir = join(projectRoot, 'pages')
  if (existsSync(pagesDir)) {
    const vueFiles = (readdirSync(pagesDir, { recursive: true }) as string[]).filter(f => f.endsWith('.vue'))
    if (vueFiles.length > 0) {
      return { name: 'vue', version: 'detected', confidence: 0.6 }
    }
  }

  return null
}

export function resolveVueReference(
  queries: QueryManager,
  ref: UnresolvedReference,
  sourceFile: string,
  moduleId: string
): MiniCodeGraphNode | null {
  const refName = ref.referenceName

  if (VUE_COMPILER_MACROS.has(refName)) {
    return null
  }

  if (NUXT_AUTO_IMPORTS.has(refName)) {
    return null
  }

  if (NUXT_VIRTUAL_MODULES.some(m => refName.startsWith(m))) {
    return null
  }

  if (isPascalCase(refName)) {
    return resolveVueComponent(queries, refName, sourceFile, moduleId)
  }

  if (refName.endsWith('.vue')) {
    return resolveVueFileComponent(queries, refName, sourceFile, moduleId)
  }

  return null
}

function isPascalCase(str: string): boolean {
  return /^[A-Z][a-z]+(?:[A-Z][a-z]+)*$/.test(str) && str.length > 1
}

function resolveVueComponent(
  queries: QueryManager,
  componentName: string,
  sourceFile: string,
  _moduleId: string
): MiniCodeGraphNode | null {
  const sourceDir = sourceFile.substring(0, sourceFile.lastIndexOf('/'))

  const sameDirComponents = queries.searchNodes(componentName, 20)
    .filter(n =>
      n.filePath.endsWith('.vue') &&
      n.filePath.startsWith(sourceDir.substring(0, sourceDir.lastIndexOf('/'))) &&
      n.kind === 'module'
    )
  if (sameDirComponents.length > 0) return sameDirComponents[0]

  const vueFileMatches = queries.searchNodes(componentName, 20)
    .filter(n => n.filePath.endsWith('.vue') || n.filePath.endsWith('.tsx'))
  if (vueFileMatches.length > 0) return vueFileMatches[0]

  return null
}

function resolveVueFileComponent(
  queries: QueryManager,
  refName: string,
  _sourceFile: string,
  _moduleId: string
): MiniCodeGraphNode | null {
  const candidates = queries.searchNodes(refName, 10)
  for (const c of candidates) {
    if (c.filePath === refName || c.filePath.endsWith(`/${refName}`)) {
      return c
    }
  }
  return null
}

export function parseVueTemplate(templateContent: string): VueTemplateInfo {
  const componentRefs: string[] = []
  const eventBindings: { event: string; handler: string; line: number }[] = []
  const slotUsages: string[] = []
  const directives: string[] = []

  const tagRegex = /<(\/?)([A-Z][a-zA-Z]*)([^>]*)\/?>/g
  let m: RegExpExecArray | null
  while ((m = tagRegex.exec(templateContent)) !== null) {
    const isClosing = m[1] === '/'
    const tagName = m[2]
    if (!isClosing) {
      componentRefs.push(tagName)
    }
  }

  const vueTagRegex = /<(\/?)([a-z][a-zA-Z0-9-]*)([^>]*)\/?>/g
  while ((m = vueTagRegex.exec(templateContent)) !== null) {
    const isClosing = m[1] === '/'
    const tagName = m[2]
    if (!isClosing && (tagName.includes('-') || ['router-view', 'router-link', 'component', 'slot', 'template'].includes(tagName))) {
      if (tagName.includes('-')) {
        componentRefs.push(tagName)
      }
    }
  }

  const eventRegex = /@([a-zA-Z][\w.-]*)\s*=\s*["']([^"']+)["']/g
  while ((m = eventRegex.exec(templateContent)) !== null) {
    const lineNum = templateContent.substring(0, m.index).split('\n').length
    eventBindings.push({ event: m[1], handler: m[2].trim(), line: lineNum })
  }

  const slotRegex = /<slot\s[^>]*name=["']([^"']+)["'][^>]*\/?>|<slot\b(?!\s)/g
  while ((m = slotRegex.exec(templateContent)) !== null) {
    const slotName = m[1]?.trim() || 'default'
    slotUsages.push(slotName)
  }

  const directiveNames = ['v-if', 'v-else-if', 'v-else', 'v-for', 'v-show', 'v-model',
    'v-bind', 'v-on', 'v-once', 'v-cloak', 'v-pre', 'v-html', 'v-text',
    'v-slot']
  const directiveRegex = /(v-[a-z]+(?:-[a-z]+)?)(?:\s*[:|=]["']([^"']+)["'])?/g
  while ((m = directiveRegex.exec(templateContent)) !== null) {
    if (directiveNames.includes(m[1])) {
      directives.push(m[0].trim())
    }
  }

  return {
    componentRefs: [...new Set(componentRefs)],
    eventBindings,
    slotUsages: [...new Set(slotUsages)],
    directives: [...new Set(directives)],
  }
}

export function extractVueRouterRoutes(projectRoot: string): {
  path: string
  component: string
  name?: string
  line: number
}[] {
  const routes: { path: string; component: string; name?: string; line: number }[] = []

  const routerFiles = [
    join(projectRoot, 'src', 'router', 'index.ts'),
    join(projectRoot, 'src', 'router', 'index.js'),
    join(projectRoot, 'src', 'router.ts'),
    join(projectRoot, 'src', 'router.js'),
  ]

  for (const rf of routerFiles) {
    if (!existsSync(rf)) continue
    try {
      const content = readFileSync(rf, 'utf-8')

      const routePattern = /\{\s*path:\s*['"](.+?)['"]\s*(?:,\s*name:\s*['"](.+?)['"])?\s*,?\s*(?:component|children|redirect)/g
      let m: RegExpExecArray | null
      while ((m = routePattern.exec(content)) !== null) {
        const path = m[1]
        const name = m[2]
        const lineNum = content.substring(0, m.index).split('\n').length + 1

        let component = ''
        const compMatch = content.substring(m.index).match(/(?:component|children|redirect):\s*(\w+)/)
        if (compMatch) component = compMatch[1]

        routes.push({ path, component, name, line: lineNum })
      }

      const lazyPattern = /path:\s*['"](.+?)['"][^}]*?component:\s*\(\)\s*=>\s*import\(['"](.+?)['"]\)/g
      while ((m = lazyPattern.exec(content)) !== null) {
        const path = m[1]
        const lazyPath = m[2]
        const lineNum = content.substring(0, m.index).split('\n').length + 1

        routes.push({ path, component: lazyPath, line: lineNum })
      }
    } catch { /* silent */ }
  }

  return routes
}

export function isVueProject(projectRoot: string): boolean {
  return detectVue(projectRoot) !== null
}
