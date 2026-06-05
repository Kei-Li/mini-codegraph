import { SUPPORTED_LANGUAGES } from '../../../types.js'
import type { LanguageConfig } from '../../../types.js'

export const kotlinConfig: LanguageConfig = SUPPORTED_LANGUAGES.find(l => l.name === 'kotlin')!

export function isKotlinFile(filePath: string): boolean {
  return kotlinConfig.extensions.some(ext => filePath.endsWith(ext))
}

export { type LanguageConfig }
