import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import ignore from 'ignore'
import { createHash } from 'node:crypto'
import { SUPPORTED_LANGUAGES } from './types.js'
import type { LanguageConfig } from './types.js'

export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function languageForFile(filePath: string): LanguageConfig | undefined {
  const ext = extname(filePath).toLowerCase()
  return SUPPORTED_LANGUAGES.find(l => l.extensions.includes(ext))
}

export function isSupportedFile(filePath: string): boolean {
  return languageForFile(filePath) !== undefined
}

export function loadGitignore(root: string): (path: string) => boolean {
  const ig = ignore()
  const gitignorePath = join(root, '.gitignore')
  try {
    const content = readFileSync(gitignorePath, 'utf-8')
    ig.add(content)
  } catch {
    // No .gitignore, use sensible defaults
    ig.add(['node_modules', 'dist', 'build', '.git', 'target', '.codegraph', '.venv', 'venv', '__pycache__'])
  }

  return (path: string) => {
    const rel = relative(root, path).replace(/\\/g, '/')
    if (!rel || rel.startsWith('..')) return false
    return ig.ignores(rel)
  }
}

export function findFiles(root: string, isIgnored: (path: string) => boolean): string[] {
  const result: string[] = []

  function walk(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry)
      if (isIgnored(fullPath)) continue

      try {
        const s = statSync(fullPath)
        if (s.isDirectory()) {
          walk(fullPath)
        } else if (s.isFile() && isSupportedFile(fullPath)) {
          result.push(fullPath)
        }
      } catch {
        // skip inaccessible files
      }
    }
  }

  walk(root)
  return result
}

export function extractDocstring(lines: string[], startLine: number): string {
  const docLines: string[] = []
  let lineIdx = startLine - 1
  while (lineIdx >= 0) {
    const trimmed = lines[lineIdx]?.trim()
    if (trimmed?.startsWith('//')) {
      docLines.unshift(trimmed.slice(2).trim())
    } else if (trimmed?.startsWith('*') && lineIdx > 0 && lines[lineIdx - 1]?.trim().endsWith('/**')) {
      docLines.unshift(trimmed.replace(/^\s*\*\s?/, ''))
    } else if (trimmed?.endsWith('*/')) {
      break
    } else if (trimmed?.startsWith('/**')) {
      docLines.unshift(trimmed.replace(/^\s*\/\*\*\s?/, ''))
      break
    } else if (lineIdx === startLine - 1) {
      lineIdx--
      continue
    } else {
      break
    }
    lineIdx--
  }
  return docLines.join(' ')
}
