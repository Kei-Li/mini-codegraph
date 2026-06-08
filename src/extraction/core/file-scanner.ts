import { statSync } from 'node:fs'
import { join } from 'node:path'
import { scanDirectory } from '../../utils.js'

export type PressureFn = () => number

export class FileScanner {
  private knownFiles = new Map<string, { size: number; modifiedAt: number }>()
  private pressureFn: PressureFn = () => 0

  constructor(private projectRoot: string, private excludePatterns?: string[]) {}

  setKnownFiles(files: { path: string; size: number; modifiedAt: number }[]): void {
    for (const f of files) {
      this.knownFiles.set(f.path, f)
    }
  }

  setPressureFn(fn: PressureFn): void {
    this.pressureFn = fn
  }

  async *scan(): AsyncGenerator<string> {
    const files = scanDirectory(this.projectRoot, undefined, this.excludePatterns)
    let yielded = 0
    for (const f of files) {
      yield f
      yielded++
      if (yielded % 1000 === 0) {
        await new Promise(r => setImmediate(r))
      }
      const p = this.pressureFn()
      if (p > 0.8 && yielded % 100 === 0) {
        await new Promise(r => setTimeout(r, Math.round(p * 50)))
      }
    }
  }

  async *scanWithSkip(): AsyncGenerator<string> {
    const files = scanDirectory(this.projectRoot, undefined, this.excludePatterns)
    let yielded = 0
    for (const f of files) {
      const known = this.knownFiles.get(f)
      if (known) {
        try {
          const s = statSync(join(this.projectRoot, f))
          if (s.size === known.size && Math.floor(s.mtimeMs) === Math.floor(known.modifiedAt)) {
            continue
          }
        } catch {
          // file missing, re-index
        }
      }
      yield f
      yielded++
      if (yielded % 500 === 0) {
        await new Promise(r => setImmediate(r))
      }
      const p = this.pressureFn()
      if (p > 0.8 && yielded % 100 === 0) {
        await new Promise(r => setTimeout(r, Math.round(p * 50)))
      }
    }
  }

  get size(): number {
    return scanDirectory(this.projectRoot, undefined, this.excludePatterns).length
  }
}
