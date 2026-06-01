import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import type { QueryManager } from '../db/queries.js'
import type { CodeGraphNode } from '../types.js'

const EXTENSION_RESOLUTION = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.java', '.kt']

export interface ImportMapping {
  localName: string
  moduleName: string
  isDefault: boolean
  isNamespace: boolean
}

export function resolveImportPath(
  importPath: string,
  sourceFile: string,
  projectRoot: string,
  sourceModuleRoot: string
): string | null {
  if (importPath.startsWith('.')) {
    return resolveRelativeImport(importPath, sourceFile, projectRoot)
  }

  if (importPath.startsWith('@/') || importPath.startsWith('~/')) {
    return resolveAliasedImport(importPath, projectRoot, sourceModuleRoot)
  }

  if (importPath.includes('/') && !importPath.startsWith('@')) {
    const parts = importPath.split('/')
    const base = parts[0]
    if (!base.startsWith('@')) {
      if (existsSync(join(projectRoot, 'node_modules', base))) return null
      if (existsSync(join(projectRoot, base))) {
        return resolveAliasedImport(importPath, projectRoot, sourceModuleRoot)
      }
    }
  }

  return null
}

function resolveRelativeImport(importPath: string, sourceFile: string, projectRoot: string): string | null {
  const sourceDir = dirname(sourceFile)
  const resolved = resolve(projectRoot, sourceDir, importPath)

  for (const ext of EXTENSION_RESOLUTION) {
    const withExt = `${resolved}${ext}`
    if (existsSync(withExt)) return withExt.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
  }

  const indexDir = resolve(resolved)
  for (const ext of EXTENSION_RESOLUTION) {
    const indexPath = join(indexDir, `index${ext}`)
    if (existsSync(indexPath)) return indexPath.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
  }

  return null
}

function resolveAliasedImport(importPath: string, projectRoot: string, sourceModuleRoot: string): string | null {
  let baseDir = sourceModuleRoot || projectRoot

  if (importPath.startsWith('@/')) {
    const relative = importPath.slice(2)
    const srcPath = join(baseDir, 'src', relative)
    for (const ext of EXTENSION_RESOLUTION) {
      if (existsSync(`${srcPath}${ext}`)) {
        const full = `${srcPath}${ext}`
        return full.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      }
    }
    const dirPath = srcPath
    for (const ext of EXTENSION_RESOLUTION) {
      if (existsSync(join(dirPath, `index${ext}`))) {
        const full = join(dirPath, `index${ext}`)
        return full.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      }
    }
  }

  if (importPath.startsWith('~/')) {
    const relative = importPath.slice(2)
    const srcPath = join(baseDir, relative)
    for (const ext of EXTENSION_RESOLUTION) {
      if (existsSync(`${srcPath}${ext}`)) {
        const full = `${srcPath}${ext}`
        return full.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      }
    }
    for (const ext of EXTENSION_RESOLUTION) {
      if (existsSync(join(srcPath, `index${ext}`))) {
        const full = join(srcPath, `index${ext}`)
        return full.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      }
    }
    if (existsSync(srcPath)) {
      return srcPath.replace(projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
    }
  }

  return null
}

export function extractJavaImports(source: string): ImportMapping[] {
  const mappings: ImportMapping[] = []
  const lines = source.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('import ')) {
      const importStr = trimmed.replace('import ', '').replace(';', '').trim()
      if (importStr.endsWith('.*')) continue

      const parts = importStr.split('.')
      const localName = parts[parts.length - 1]
      mappings.push({
        localName,
        moduleName: importStr,
        isDefault: false,
        isNamespace: false,
      })
    }
  }
  return mappings
}

export function extractTypeScriptImports(source: string, filePath: string): ImportMapping[] {
  const mappings: ImportMapping[] = []

  const importRegex = /import\s+(?:(?:\{[^}]*\})\s+from\s+|(?:\*\s+as\s+\w+\s+from\s+)|(?:\w+\s+from\s+))['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = importRegex.exec(source)) !== null) {
    const moduleName = match[1]
    const importClause = match[0]

    let localName = moduleName.split('/').pop() || moduleName
    if (importClause.startsWith('import * as ')) {
      const nsMatch = importClause.match(/import\s*\*\s*as\s+(\w+)/)
      if (nsMatch) localName = nsMatch[1]
    } else if (importClause.startsWith('import {')) {
      const namedMatch = importClause.match(/\{\s*(\w+)/)
      if (namedMatch) localName = namedMatch[1]
    } else {
      const defMatch = importClause.match(/import\s+(\w+)\s+from/)
      if (defMatch) localName = defMatch[1]
    }

    mappings.push({
      localName,
      moduleName,
      isDefault: !importClause.includes('{') && !importClause.includes('* as'),
      isNamespace: importClause.includes('* as'),
    })
  }

  return mappings
}

export function resolveJvmImport(
  queries: QueryManager,
  fqn: string,
  simpleName: string
): CodeGraphNode | null {
  const byQName = queries.getNodesByQualifiedName(fqn)
  if (byQName.length > 0) return byQName[0]

  const byName = queries.searchNodes(simpleName, 50)
  for (const node of byName) {
    if (node.qualifiedName === fqn) return node
    if (node.qualifiedName.endsWith(`.${simpleName}`) && node.qualifiedName.replace(/\.\w+$/, '') === fqn.replace(/\.\w+$/, '')) {
      return node
    }
  }

  return null
}

export function resolveViaImportChain(
  queries: QueryManager,
  refName: string,
  sourceFile: string,
  fileImports: ImportMapping[],
  sourceModuleId: string
): CodeGraphNode | null {
  for (const imp of fileImports) {
    if (imp.localName === refName) {
      const candidates = queries.searchNodes(imp.localName, 20)
      for (const c of candidates) {
        if (c.filePath !== sourceFile) {
          if (c.qualifiedName === imp.moduleName || c.qualifiedName.endsWith(`.${imp.localName}`)) {
            return c
          }
        }
      }

      if (imp.moduleName.includes('.')) {
        const jvmMatch = resolveJvmImport(queries, imp.moduleName, imp.localName)
        if (jvmMatch) return jvmMatch
      }
    }

    if (refName.includes('.') && imp.isNamespace) {
      const parts = refName.split('.')
      const namespace = parts[0]
      const member = parts.slice(1).join('.')
      if (namespace === imp.localName) {
        const candidates = queries.searchNodes(member, 20)
        for (const c of candidates) {
          const parent = c.parentId ? queries.getNode(c.parentId) : null
          if (parent && (parent.name === imp.localName || parent.qualifiedName.endsWith(`.${imp.localName}`))) {
            return c
          }
        }
      }
    }
  }

  return null
}
