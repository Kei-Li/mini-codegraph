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
    await Parser.init()
    this.initialized = true
  }

  async loadGrammar(language: string): Promise<Parser> {
    if (this.parsers.has(language)) return this.parsers.get(language)!

    if (!this.initialized) {
      await this.init()
    }

    const parser = new Parser()
    const wasmPath = findWasmPath(language)

    if (wasmPath && existsSync(wasmPath)) {
      const wasmBytes = readFileSync(wasmPath)
      const Lang = await Parser.Language.load(wasmBytes)
      parser.setLanguage(Lang)
    } else {
      // Try loading from the tree-sitter wasm CDN / npm package
      try {
        const module = await importLanguageModule(language)
        if (module) {
          const Lang = await Parser.Language.load(module.bytes ?? module.default?.bytes)
          parser.setLanguage(Lang)
        }
      } catch {
        throw new Error(
          `Grammar for "${language}" not found. ` +
          `Place tree-sitter-${language}.wasm in the grammars/ directory.`
        )
      }
    }

    this.parsers.set(language, parser)
    return parser
  }

  hasGrammar(language: string): boolean {
    if (this.parsers.has(language)) return true

    const wasmPath = findWasmPath(language)
    return (wasmPath && existsSync(wasmPath)) || false
  }
}

function findWasmPath(language: string): string | null {
  const searchPaths = [
    join(__dirname, '..', '..', '..', 'grammars'),
    join(__dirname, '..', '..', 'grammars'),
    join(process.cwd(), 'grammars'),
  ]

  const filename = `tree-sitter-${language}.wasm`

  for (const dir of searchPaths) {
    const fullPath = join(dir, filename)
    if (existsSync(fullPath)) return fullPath
  }

  return null
}

async function importLanguageModule(language: string): Promise<any> {
  try {
    const url = `https://cdn.jsdelivr.net/npm/tree-sitter-${language}`
    const response = await fetch(url)
    if (!response.ok) return null
  } catch {
    return null
  }
}
