import { SUPPORTED_LANGUAGES } from '../../../types.js'
import type { LanguageConfig } from '../../../types.js'

export const vueConfig: LanguageConfig = SUPPORTED_LANGUAGES.find(l => l.name === 'vue')!

export function isVueFile(filePath: string): boolean {
  return vueConfig.extensions.some(ext => filePath.endsWith(ext))
}

export { type LanguageConfig }
