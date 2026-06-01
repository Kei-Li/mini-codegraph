import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'

export interface WorktreeIndexMismatch {
  worktreeRoot: string
  indexRoot: string
}

export function gitWorktreeRoot(dir: string): string | null {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()
    if (!out) return null
    try { return realpathSync(out) } catch { return resolve(out) }
  } catch { return null }
}

export function detectWorktreeIndexMismatch(
  startPath: string,
  indexRoot: string,
): WorktreeIndexMismatch | null {
  const worktreeRoot = gitWorktreeRoot(startPath)
  if (!worktreeRoot) return null

  const resolvedIndexRoot = (() => {
    try { return realpathSync(indexRoot) } catch { return resolve(indexRoot) }
  })()

  if (worktreeRoot === resolvedIndexRoot) return null

  if (gitWorktreeRoot(resolvedIndexRoot) !== resolvedIndexRoot) return null

  return { worktreeRoot, indexRoot: resolvedIndexRoot }
}

export function worktreeMismatchWarning(m: WorktreeIndexMismatch): string {
  return (
    `This mini-codegraph index belongs to a different git working tree.\n` +
    `  Running in: ${m.worktreeRoot}\n` +
    `  Index from: ${m.indexRoot}\n` +
    `Results reflect that tree's code (often a different branch), not this worktree — ` +
    `symbols changed only here are missing. Run "mini-cg init -i" in this worktree ` +
    `for a worktree-local index.`
  )
}

export function worktreeMismatchNotice(m: WorktreeIndexMismatch): string {
  return (
    `⚠ mini-codegraph results below come from a different git worktree (${m.indexRoot}), ` +
    `not where you're working (${m.worktreeRoot}) — they may reflect another branch, ` +
    `and symbols changed only here are missing. Run "mini-cg init -i" here for a ` +
    `worktree-local index.`
  )
}
