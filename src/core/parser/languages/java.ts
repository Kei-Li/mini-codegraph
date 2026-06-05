import { SUPPORTED_LANGUAGES } from '../../../types.js'
import type { LanguageConfig } from '../../../types.js'

export const javaConfig: LanguageConfig = SUPPORTED_LANGUAGES.find(l => l.name === 'java')!

export function isJavaFile(filePath: string): boolean {
  return javaConfig.extensions.some(ext => filePath.endsWith(ext))
}

export { type LanguageConfig }
