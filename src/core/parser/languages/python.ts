import { SUPPORTED_LANGUAGES } from '../../../types.js'
import type { LanguageConfig } from '../../../types.js'

export const pythonConfig: LanguageConfig = SUPPORTED_LANGUAGES.find(l => l.name === 'python')!

export function isPythonFile(filePath: string): boolean {
  return pythonConfig.extensions.some(ext => filePath.endsWith(ext))
}

export { type LanguageConfig }
