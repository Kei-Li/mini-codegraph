import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Parser from 'web-tree-sitter'
import { GrammarError } from '../../errors.js'
import { logError } from '../../logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const GRAMMAR_CDN = 'https://cdn.jsdelivr.net/npm/@tree-sitter-grammars'

const MAX_PARSED_FILES_BEFORE_RECYCLE = 4000

export class GrammarLoader {
  private initialized = false
  private parsers = new Map<string, { parser: Parser; fileCount: number }>()
  private totalFileCount = 0

  async init(): Promise<void> {
    if (this.initialized) return
    await Parser.init({
      locateFile(path: string): string {
        if (path === 'tree-sitter.wasm') {
          const p = findWasmPath('tree-sitter.wasm')
          if (p) return p
        }
        const p = findWasmPath(path)
        if (p) return p
        return path
      },
    })
    this.initialized = true
  }

  async loadGrammar(language: string): Promise<Parser> {
    if (this.parsers.has(language)) {
      const entry = this.parsers.get(language)!
      entry.fileCount++
      this.totalFileCount++
      if (entry.fileCount >= MAX_PARSED_FILES_BEFORE_RECYCLE) {
        this.resetParser(language)
        return this.loadGrammarFresh(language)
      }
      return entry.parser
    }

    return this.loadGrammarFresh(language)
  }

  private async loadGrammarFresh(language: string): Promise<Parser> {
    if (!this.initialized) {
      await this.init()
    }

    let wasmPath = findWasmPath(`tree-sitter-${language}.wasm`)

    if (!wasmPath || !existsSync(wasmPath)) {
      await this.downloadGrammar(language)
      wasmPath = findWasmPath(`tree-sitter-${language}.wasm`)
    }

    if (wasmPath && existsSync(wasmPath)) {
      const wasmBytes = readFileSync(wasmPath)
      const Lang = await Parser.Language.load(wasmBytes)
      const parser = new Parser()
      parser.setLanguage(Lang)
      this.parsers.set(language, { parser, fileCount: 1 })
      this.totalFileCount++
      return parser
    } else {
      throw new GrammarError(
        `Grammar for "${language}" not found`,
        { language, wasmPath },
      )
    }
  }

  resetParser(language: string): void {
    if (this.parsers.has(language)) {
      try {
        const entry = this.parsers.get(language)!
        const parser = entry.parser
        try { parser.delete() } catch { /* silent */ }
        this.parsers.delete(language)
        if (typeof globalThis.gc === 'function') {
          try { globalThis.gc() } catch { /* silent */ }
        }
      } catch { /* silent */ }
    }
  }

  resetAllParsers(): void {
    for (const [lang] of this.parsers) {
      this.resetParser(lang)
    }
    this.totalFileCount = 0
  }

  recycleIfNeeded(): void {
    if (this.totalFileCount >= MAX_PARSED_FILES_BEFORE_RECYCLE * this.parsers.size) {
      this.resetAllParsers()
    }
  }

  hasGrammar(language: string): boolean {
    const wasmPath = findWasmPath(`tree-sitter-${language}.wasm`)
    return (wasmPath && existsSync(wasmPath)) || false
  }

  get totalFilesParsed(): number {
    return this.totalFileCount
  }

  private async downloadGrammar(language: string): Promise<void> {
    const filename = `tree-sitter-${language}.wasm`
    const grammarsDir = findGrammarsDir()
    if (!grammarsDir) {
      throw new Error(`Cannot find grammars directory to save ${filename}`)
    }

    const urls = [
      `${GRAMMAR_CDN}/${language}-wasm@latest/${filename}`,
      `https://github.com/tree-sitter/tree-sitter-${language}/releases/latest/download/${filename}`,
      `https://cdn.jsdelivr.net/npm/tree-sitter-wasms@latest/out/${filename}`,
      `https://github.com/tree-sitter/tree-sitter-${language}/releases/download/v0.23.6/${filename}`,
    ]

    let lastError: Error | null = null
    for (const url of urls) {
      logError(`Downloading grammar: ${url}`)
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const buffer = await response.arrayBuffer()
        const targetPath = join(grammarsDir, filename)
        if (!existsSync(grammarsDir)) {
          mkdirSync(grammarsDir, { recursive: true })
        }
        writeFileSync(targetPath, Buffer.from(buffer))
        logError(`Downloaded grammar to ${targetPath}`)
        return
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e))
        logError(`  fallback: ${url} failed (${lastError.message})`)
      }
    }

    throw new Error(`Failed to download grammar for "${language}" from all sources: ${lastError?.message}`)
  }
}

function findWasmPath(filename: string): string | null {
  const searchPaths = [
    join(__dirname, '..', '..', '..', 'grammars'),
    join(__dirname, '..', '..', 'grammars'),
    join(process.cwd(), 'grammars'),
  ]

  for (const dir of searchPaths) {
    const fullPath = join(dir, filename)
    if (existsSync(fullPath)) return fullPath
  }

  return null
}

function findGrammarsDir(): string | null {
  const candidates = [
    join(__dirname, '..', '..', '..', 'grammars'),
    join(__dirname, '..', '..', 'grammars'),
    join(process.cwd(), 'grammars'),
  ]

  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  // Create in project root's grammars directory
  return candidates[candidates.length - 1]
}
