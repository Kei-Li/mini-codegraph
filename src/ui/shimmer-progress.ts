import type { ShimmerMessage } from './types.js'

export interface ProgressCallbacks {
  onProgress: (msg: ShimmerMessage) => void
  stop: () => Promise<void>
}

export function createShimmerProgress(phases: string[] = ['Scanning files', 'Parsing AST', 'Extracting references', 'Persisting graph']): ProgressCallbacks {
  let currentPhase = 0
  let currentPercent = 0
  let running = true

  const render = (): void => {
    if (!running) return
    const phase = phases[currentPhase] ?? 'Working'
    const bar = '█'.repeat(Math.floor(currentPercent / 5)) + '░'.repeat(20 - Math.floor(currentPercent / 5))
    process.stderr.write(`\r  ${phase} ${bar} ${currentPercent}%`)
  }

  const onProgress = (msg: ShimmerMessage): void => {
    if (msg.type === 'progress') {
      if (msg.phase) {
        const idx = phases.indexOf(msg.phase)
        if (idx >= 0) currentPhase = idx
      }
      if (msg.percent != null) currentPercent = msg.percent
      render()
    } else if (msg.type === 'complete') {
      currentPercent = 100
      render()
      process.stderr.write('\n')
      running = false
    } else if (msg.type === 'error') {
      process.stderr.write(`\n  Error: ${msg.message ?? 'Unknown'}\n`)
      running = false
    }
  }

  const stop = async (): Promise<void> => {
    running = false
    process.stderr.write('\n')
  }

  return { onProgress, stop }
}
