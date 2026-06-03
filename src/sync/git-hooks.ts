import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

export type GitHookName = 'post-commit' | 'post-merge' | 'post-checkout'

export const DEFAULT_SYNC_HOOKS: GitHookName[] = ['post-commit', 'post-merge', 'post-checkout']

const MARKER_BEGIN = '# >>> mini-codegraph sync hook >>>'
const MARKER_END = '# <<< mini-codegraph sync hook <<<'

export interface GitHookResult {
  installed: GitHookName[]
  hooksDir: string | null
  skipped?: string
}

export function isGitRepo(projectRoot: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()
    return out === 'true'
  } catch {
    return false
  }
}

function gitHooksDir(projectRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()
    if (!out) return null
    return resolve(projectRoot, out)
  } catch {
    return null
  }
}

function markerBlock(): string {
  return [
    MARKER_BEGIN,
    '# Keeps the mini-codegraph index fresh while the live file watcher is off',
    '# (e.g. WSL2 /mnt drives). Runs in the background so it never blocks git.',
    '# Managed by mini-codegraph; remove with `mini-cg sync --remove-git-hooks` or delete this block.',
    'if command -v mini-cg >/dev/null 2>&1; then',
    '  ( mini-cg sync "$(git rev-parse --show-toplevel)" >/dev/null 2>&1 & ) >/dev/null 2>&1',
    'fi',
    MARKER_END,
  ].join('\n')
}

function stripMarkerBlock(content: string): string {
  const lines = content.split('\n')
  const kept: string[] = []
  let inBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === MARKER_BEGIN) { inBlock = true; continue }
    if (trimmed === MARKER_END) { inBlock = false; continue }
    if (!inBlock) kept.push(line)
  }
  return kept.join('\n')
}

function isEffectivelyEmpty(content: string): boolean {
  return content
    .split('\n')
    .map(l => l.trim())
    .every(l => l.length === 0 || l.startsWith('#!'))
}

export function installGitSyncHook(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): GitHookResult {
  const hooksDir = gitHooksDir(projectRoot)
  if (!hooksDir) {
    return { installed: [], hooksDir: null, skipped: 'not a git repository' }
  }

  try {
    mkdirSync(hooksDir, { recursive: true })
  } catch {
    return { installed: [], hooksDir, skipped: 'could not access the git hooks directory' }
  }

  const block = markerBlock()
  const installed: GitHookName[] = []

  for (const hook of hooks) {
    const file = join(hooksDir, hook)
    let content: string

    if (existsSync(file)) {
      const base = stripMarkerBlock(readFileSync(file, 'utf8')).replace(/\s*$/, '')
      content = base.length > 0
        ? `${base}\n\n${block}\n`
        : `#!/bin/sh\n${block}\n`
    } else {
      content = `#!/bin/sh\n${block}\n`
    }

    writeFileSync(file, content)
    try { chmodSync(file, 0o755) } catch { /* silent */ }
    installed.push(hook)
  }

  return { installed, hooksDir }
}

export function removeGitSyncHook(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): GitHookResult {
  const hooksDir = gitHooksDir(projectRoot)
  if (!hooksDir) {
    return { installed: [], hooksDir: null, skipped: 'not a git repository' }
  }

  const removed: GitHookName[] = []

  for (const hook of hooks) {
    const file = join(hooksDir, hook)
    if (!existsSync(file)) continue

    const original = readFileSync(file, 'utf8')
    if (!original.includes(MARKER_BEGIN)) continue

    const stripped = stripMarkerBlock(original)
    if (isEffectivelyEmpty(stripped)) {
      unlinkSync(file)
    } else {
      writeFileSync(file, `${stripped.replace(/\s*$/, '')}\n`)
      try { chmodSync(file, 0o755) } catch { /* silent */ }
    }
    removed.push(hook)
  }

  return { installed: removed, hooksDir }
}

export function isSyncHookInstalled(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): boolean {
  const hooksDir = gitHooksDir(projectRoot)
  if (!hooksDir) return false
  return hooks.some((hook) => {
    const file = join(hooksDir, hook)
    return existsSync(file) && readFileSync(file, 'utf8').includes(MARKER_BEGIN)
  })
}
