import { SUPPORTED_LANGUAGES } from '../../../types.js'
import type { LanguageConfig } from '../../../types.js'

export const typescriptConfig: LanguageConfig = SUPPORTED_LANGUAGES.find(l => l.name === 'typescript')!

export function isTypeScriptFile(filePath: string): boolean {
  return typescriptConfig.extensions.some(ext => filePath.endsWith(ext))
}

export { type LanguageConfig }
