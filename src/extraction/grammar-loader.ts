import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Parser from 'web-tree-sitter'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

    const parser = new Parser()
    const wasmPath = findWasmPath(`tree-sitter-${language}.wasm`)

    if (wasmPath && existsSync(wasmPath)) {
      const wasmBytes = readFileSync(wasmPath)
      const Lang = await Parser.Language.load(wasmBytes)
      parser.setLanguage(Lang)
    } else {
      throw new Error(
        `Grammar for "${language}" not found at grammars/tree-sitter-${language}.wasm`
      )
    }

    this.parsers.set(language, parser)
    return parser
  }

  hasGrammar(language: string): boolean {
    const wasmPath = findWasmPath(`tree-sitter-${language}.wasm`)
    return (wasmPath && existsSync(wasmPath)) || false
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
