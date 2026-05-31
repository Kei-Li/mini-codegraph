import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Parser from 'web-tree-sitter'

const __dirname = dirname(fileURLToPath(import.meta.url))

const GRAMMAR_CDN = 'https://cdn.jsdelivr.net/npm/@tree-sitter-grammars'

export class GrammarLoader {
  private initialized = false
  private parsers = new Map<string, Parser>()

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
    if (this.parsers.has(language)) return this.parsers.get(language)!

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
      this.parsers.set(language, parser)
      return parser
    } else {
      throw new Error(
        `Grammar for "${language}" not found at grammars/tree-sitter-${language}.wasm`
      )
    }
  }

  hasGrammar(language: string): boolean {
    const wasmPath = findWasmPath(`tree-sitter-${language}.wasm`)
    return (wasmPath && existsSync(wasmPath)) || false
  }

  private async downloadGrammar(language: string): Promise<void> {
    const filename = `tree-sitter-${language}.wasm`
    const grammarsDir = findGrammarsDir()
    if (!grammarsDir) {
      throw new Error(`Cannot find grammars directory to save ${filename}`)
    }

    const url = `${GRAMMAR_CDN}/${language}-wasm@latest/${filename}`
    console.error(`Downloading grammar: ${url}`)

    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = await response.arrayBuffer()
      const targetPath = join(grammarsDir, filename)
      if (!existsSync(grammarsDir)) {
        mkdirSync(grammarsDir, { recursive: true })
      }
      writeFileSync(targetPath, Buffer.from(buffer))
      console.error(`Downloaded grammar to ${targetPath}`)
    } catch (e) {
      throw new Error(`Failed to download grammar for "${language}" from ${url}: ${e}`)
    }
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
