import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../../db/queries.js'

export interface I18nMessage {
  key: string
  value: string
  locale: string
  filePath: string
  usedIn: string[]
}

export function parseI18nLocaleFile(filePath: string): { key: string; value: string }[] {
  const results: { key: string; value: string }[] = []
  try {
    const content = readFileSync(filePath, 'utf-8')

    if (filePath.endsWith('.json')) {
      const json = JSON.parse(content)
      function walk(obj: Record<string, unknown>, prefix: string) {
        for (const [k, v] of Object.entries(obj)) {
          const key = prefix ? `${prefix}.${k}` : k
          if (typeof v === 'string') results.push({ key, value: v })
          else if (typeof v === 'object' && v !== null) walk(v as Record<string, unknown>, key)
        }
      }
      walk(json, '')
    } else {
      const lines = content.split('\n')
      for (const line of lines) {
        const m = line.match(/^\s*['"]?(\w+)['"]?\s*:\s*["'](.+?)["']/)
        if (m) results.push({ key: m[1], value: m[2] })
      }
    }
  } catch { /* silent */ }
  return results
}

export function findI18nDirs(projectRoot: string): string[] {
  const dirs: string[] = []
  const candidates = [
    join(projectRoot, 'src', 'locales'),
    join(projectRoot, 'src', 'i18n'),
    join(projectRoot, 'locales'),
    join(projectRoot, 'i18n'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) dirs.push(c)
  }
  return dirs
}

export function indexI18n(
  queries: QueryManager,
  projectRoot: string,
  _moduleId: string
): I18nMessage[] {
  const allMessages: I18nMessage[] = []
  const dirs = findI18nDirs(projectRoot)

  for (const dir of dirs) {
    const files = readdirSync(dir)
    for (const f of files) {
      if (!f.endsWith('.json') && !f.endsWith('.js') && !f.endsWith('.ts')) continue
      const localeMatch = f.match(/(\w+)\.(?:json|js|ts)$/)
      const locale = localeMatch?.[1] ?? 'en'
      const filePath = join(dir, f)
      const messages = parseI18nLocaleFile(filePath)
      for (const m of messages) {
        allMessages.push({ ...m, locale, filePath, usedIn: [] })
      }
    }
  }

  const vueFiles = queries.getAllNodes().filter(n => n.filePath.endsWith('.vue'))
  for (const vf of vueFiles) {
    try {
      const source = readFileSync(join(projectRoot, vf.filePath), 'utf-8')
      const usedKeys = new Set<string>()
      const tCalls = source.matchAll(/(?:\$t|i18n\.t|t)\s*\(\s*['"]([^'"]+)['"]/g)
      for (const tc of tCalls) usedKeys.add(tc[1])

      const mustachePattern = /\{\{\s*(?:\$t|t)\(['"]([^'"]+)['"]\)\s*\}\}/g
      let mp: RegExpExecArray | null
      while ((mp = mustachePattern.exec(source)) !== null) usedKeys.add(mp[1])

      for (const msg of allMessages) {
        if (usedKeys.has(msg.key)) {
          msg.usedIn.push(vf.filePath)
          const i18nId = `i18n:${msg.locale}:${msg.key}`
          queries.insertEdge(vf.id, i18nId, 'i18n_usage',
            JSON.stringify({ locale: msg.locale, key: msg.key, value: msg.value }), 0, 0)
        }
      }
    } catch { /* silent */ }
  }

  return allMessages
}
