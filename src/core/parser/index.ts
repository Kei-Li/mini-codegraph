import { GrammarLoader } from '../../extraction/grammar-loader.js'
import { languageForFile, isSupportedFile } from '../../utils.js'

export class ParserManager {
  private loader: GrammarLoader

  constructor() {
    this.loader = new GrammarLoader()
  }

  async init(): Promise<void> {
    await this.loader.init()
  }

  getLoader(): GrammarLoader {
    return this.loader
  }

  detectLanguage(filePath: string): string | null {
    const lang = languageForFile(filePath)
    return lang?.name ?? null
  }

  isSourceFile(filePath: string): boolean {
    return isSupportedFile(filePath)
  }
}

export { GrammarLoader } from '../../extraction/grammar-loader.js'
export * as languages from './languages/index.js'
