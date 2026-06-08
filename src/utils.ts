import { readFileSync, readdirSync, statSync, existsSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, relative, extname, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import ignore from 'ignore'
import type { Ignore } from 'ignore'
import { createHash, randomBytes } from 'node:crypto'
import { SUPPORTED_LANGUAGES } from './types.js'
import type { LanguageConfig } from './types.js'

export class FileLock {
  private lockPath: string
  private held = false
  private static readonly STALE_TIMEOUT_MS = 2 * 60 * 1000

  constructor(lockPath: string) {
    this.lockPath = lockPath
  }

  acquire(): void {
    if (existsSync(this.lockPath)) {
      try {
        const content = readFileSync(this.lockPath, 'utf-8').trim()
        const pid = parseInt(content, 10)
        const stat = statSync(this.lockPath)
        const lockAge = Date.now() - stat.mtimeMs

        if (lockAge < FileLock.STALE_TIMEOUT_MS && !isNaN(pid) && pid !== process.pid && this.isProcessAlive(pid)) {
          throw new Error(
            `mini-codegraph database is locked by another process (PID ${pid}). ` +
            `If this is stale, delete ${this.lockPath}`
          )
        }

        unlinkSync(this.lockPath)
      } catch (err) {
        if (err instanceof Error && err.message.includes('locked by another')) throw err
        try { unlinkSync(this.lockPath) } catch { /* silent */ }
      }
    }

    const lockId = `${process.pid}:${randomBytes(8).toString('hex')}`
    try {
      writeFileSync(this.lockPath, lockId, { flag: 'wx' })
      this.held = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(
          'mini-codegraph database is locked by another process. ' +
          `If this is stale, delete ${this.lockPath}`
        )
      }
      throw err
    }
  }

  release(): void {
    if (!this.held) return
    try { unlinkSync(this.lockPath) } catch { /* silent */ }
    this.held = false
  }

  withLock<T>(fn: () => T): T {
    this.acquire()
    try { return fn() } finally { this.release() }
  }

  async withLockAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.acquire()
    try { return await fn() } finally { this.release() }
  }

  private isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true } catch { return false }
  }
}

export class MemoryMonitor {
  private checkInterval: ReturnType<typeof setInterval> | null = null
  private peakUsage = 0
  private threshold: number
  private onThresholdExceeded?: (usage: number) => void

  constructor(thresholdMB: number = 500, onThresholdExceeded?: (usage: number) => void) {
    this.threshold = thresholdMB * 1024 * 1024
    this.onThresholdExceeded = onThresholdExceeded
  }

  start(intervalMs: number = 1000): void {
    this.stop()
    this.peakUsage = 0
    this.checkInterval = setInterval(() => {
      const usage = process.memoryUsage().heapUsed
      if (usage > this.peakUsage) this.peakUsage = usage
      if (usage > this.threshold && this.onThresholdExceeded) this.onThresholdExceeded(usage)
    }, intervalMs)
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
  }

  getPeakUsage(): number {
    return this.peakUsage
  }

  getCurrentUsage(): number {
    return process.memoryUsage().heapUsed
  }
}

export function validatePathWithinRoot(projectRoot: string, filePath: string): string | null {
  const resolved = resolve(projectRoot, filePath)
  const normalizedRoot = resolve(projectRoot)

  const realRoot = (() => {
    try { return realpathSync(normalizedRoot) } catch { return normalizedRoot }
  })()
  const realResolved = (() => {
    try { return realpathSync(resolved) } catch { return resolved }
  })()

  if (!realResolved.startsWith(realRoot + sep) && realResolved !== realRoot) return null
  return resolved
}

export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

export function safeJsonParse(text: string, fallback?: unknown): any {
  try {
    return JSON.parse(text, (_key, value) =>
      _key === '__proto__' || _key === 'constructor' ? undefined : value
    ) ?? fallback
  } catch { return fallback } // returns undefined when fallback omitted on parse error
}

export function computeContentHash(content: string): string {
  return createHash('md5').update(content).digest('hex')
}

export function languageForFile(filePath: string): LanguageConfig | undefined {
  const ext = extname(filePath).toLowerCase()
  return SUPPORTED_LANGUAGES.find(l => l.extensions.includes(ext))
}

const SUPPORTED_EXTENSIONS = new Set(SUPPORTED_LANGUAGES.flatMap(l => l.extensions))

export function isSupportedFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase())
}

// ── Shared ignore logic (watcher + indexer) ──

const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'bower_components', 'jspm_packages', 'web_modules',
  '.yarn', '.pnpm-store',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.vite', '.parcel-cache', '.angular',
  '.docusaurus', 'storybook-static', '.vinxi', '.nitro', 'out-tsc',
  '.vercel', '.netlify', '.wrangler',
  'dist', 'build', 'out', '.output',
  'coverage', '.nyc_output',
  '__pycache__', '__pypackages__', '.venv', 'venv', '.pixi', '.pdm-build',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.nox', '.hypothesis',
  '.ipynb_checkpoints', '.eggs',
  'target', '.gradle',
  'obj',
  'vendor',
  '.build', 'Pods', 'Carthage', 'DerivedData', '.swiftpm',
  '.dart_tool', '.pub-cache',
  '.cxx', '.externalNativeBuild', 'vcpkg_installed',
  '.bloop', '.metals',
  'lua_modules', '.luarocks',
  '__history', '__recovery',
  '.cache',
])

const DEFAULT_IGNORE_PATTERNS: string[] = [
  ...Array.from(DEFAULT_IGNORE_DIRS, (d) => `${d}/`),
  '*.egg-info/',
  'cmake-build-*/',
  'bazel-*/',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'credentials*',
  'secret*',
]

export function buildDefaultIgnore(rootDir: string, extraPatterns?: string[]): Ignore {
  const ig = ignore().add(DEFAULT_IGNORE_PATTERNS)
  try {
    const rootGitignore = join(rootDir, '.gitignore')
    if (existsSync(rootGitignore)) ig.add(readFileSync(rootGitignore, 'utf-8'))
  } catch { /* silent */ }
  if (extraPatterns && extraPatterns.length > 0) ig.add(extraPatterns)
  return ig
}

// ── Git-based file enumeration ──

function collectGitFiles(repoDir: string, prefix: string, files: Set<string>): void {
  const gitOpts = { cwd: repoDir, encoding: 'utf-8' as const, timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true }

  const tracked = execFileSync('git', ['ls-files', '-c', '--recurse-submodules'], gitOpts)
  for (const line of tracked.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) files.add(normalizePath(prefix + trimmed))
  }

  const untracked = execFileSync('git', ['ls-files', '-o', '--exclude-standard'], gitOpts)
  for (const line of untracked.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.endsWith('/')) {
      const childDir = join(repoDir, trimmed)
      if (existsSync(join(childDir, '.git'))) {
        collectGitFiles(childDir, prefix + trimmed, files)
      }
      continue
    }
    files.add(normalizePath(prefix + trimmed))
  }
}

export function getGitVisibleFiles(rootDir: string, excludePatterns?: string[]): Set<string> | null {
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    }).trim()

    if (resolve(gitRoot) !== resolve(rootDir)) {
      try {
        execFileSync('git', ['check-ignore', '-q', resolve(rootDir)], {
          cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        })
        return null
      } catch { /* silent */ }
    }

    const files = new Set<string>()
    collectGitFiles(rootDir, '', files)
    const ig = buildDefaultIgnore(rootDir, excludePatterns)
    return new Set([...files].filter(f => !ig.ignores(f)))
  } catch {
    return null
  }
}

export function scanDirectory(rootDir: string, onProgress?: (current: number, file: string) => void, excludePatterns?: string[]): string[] {
  const gitFiles = getGitVisibleFiles(rootDir, excludePatterns)
  if (gitFiles) {
    const files: string[] = []
    let count = 0
    for (const filePath of gitFiles) {
      if (isSupportedFile(filePath)) {
        files.push(filePath)
        count++
        onProgress?.(count, filePath)
      }
    }
    return files
  }
  return scanDirectoryWalk(rootDir, onProgress, excludePatterns)
}

export async function scanDirectoryAsync(rootDir: string, onProgress?: (current: number, file: string) => void, excludePatterns?: string[]): Promise<string[]> {
  const gitFiles = getGitVisibleFiles(rootDir, excludePatterns)
  if (gitFiles) {
    const files: string[] = []
    let count = 0
    for (const filePath of gitFiles) {
      if (isSupportedFile(filePath)) {
        files.push(filePath)
        count++
        onProgress?.(count, filePath)
        if (count % 100 === 0) await new Promise<void>(r => setImmediate(r))
      }
    }
    return files
  }
  return scanDirectoryWalk(rootDir, onProgress, excludePatterns)
}

interface ScopedIgnore {
  dir: string
  ig: Ignore
}

function scanDirectoryWalk(rootDir: string, onProgress?: (current: number, file: string) => void, excludePatterns?: string[]): string[] {
  const files: string[] = []
  let count = 0
  const visitedDirs = new Set<string>()

  const loadIgnore = (dir: string): ScopedIgnore | null => {
    try {
      const giPath = join(dir, '.gitignore')
      if (existsSync(giPath)) return { dir, ig: ignore().add(readFileSync(giPath, 'utf-8')) }
    } catch { /* silent */ }
    return null
  }

  const isIgnored = (fullPath: string, isDir: boolean, matchers: ScopedIgnore[]): boolean => {
    for (const { dir, ig } of matchers) {
      let rel = normalizePath(relative(dir, fullPath))
      if (!rel || rel.startsWith('..')) continue
      if (isDir) rel += '/'
      if (ig.ignores(rel)) return true
    }
    return false
  }

  function walk(dir: string, matchers: ScopedIgnore[]): void {
    let realDir: string
    try { realDir = realpathSync(dir) } catch { return }
    if (visitedDirs.has(realDir)) return
    visitedDirs.add(realDir)

    const own = dir === rootDir ? null : loadIgnore(dir)
    const active = own ? [...matchers, own] : matchers

    let entryNames: string[]
    try { entryNames = readdirSync(dir) } catch { return }

    for (const name of entryNames) {
      if (name === '.git' || name === '.mini-codegraph') continue
      const fullPath = join(dir, name)
      const relativePath = normalizePath(relative(rootDir, fullPath))

      let stat: ReturnType<typeof statSync> | undefined
      try { stat = statSync(fullPath) } catch { continue }

      if (stat.isDirectory()) {
        if (!isIgnored(fullPath, true, active)) walk(fullPath, active)
      } else if (stat.isFile()) {
        if (!isIgnored(fullPath, false, active) && isSupportedFile(relativePath)) {
          files.push(relativePath)
          count++
          onProgress?.(count, relativePath)
        }
      }
    }
  }

  walk(rootDir, [{ dir: rootDir, ig: buildDefaultIgnore(rootDir, excludePatterns) }])
  return files
}

// ── Git change detection ──

interface GitChanges {
  modified: string[]
  added: string[]
  deleted: string[]
}

function getGitChangedFiles(rootDir: string): GitChanges | null {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '--no-renames'], {
      cwd: rootDir, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })

    const modified: string[] = []
    const added: string[] = []
    const deleted: string[] = []

    for (const line of output.split('\n')) {
      if (line.length < 4) continue
      const statusCode = line.substring(0, 2)
      const filePath = normalizePath(line.substring(3))
      if (!isSupportedFile(filePath)) continue
      if (statusCode === '??') {
        added.push(filePath)
      } else if (statusCode.includes('D')) {
        deleted.push(filePath)
      } else {
        modified.push(filePath)
      }
    }

    return { modified, added, deleted }
  } catch {
    return null
  }
}

export function findAllGitRepos(workspaceRoot: string): string[] {
  const repos: string[] = []
  try {
    const entries = readdirSync(workspaceRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      const gitPath = join(workspaceRoot, entry.name, '.git')
      if (existsSync(gitPath)) {
        repos.push(join(workspaceRoot, entry.name))
      }
    }
  } catch { /* silent */ }
  return repos
}

// ── Legacy helpers (kept for backward compat in routes.ts etc.) ──

export function loadGitignore(root: string): (path: string) => boolean {
  const ig = ignore()
  const gitignorePath = join(root, '.gitignore')
  try {
    const content = readFileSync(gitignorePath, 'utf-8')
    ig.add(content)
  } catch {
    ig.add(['node_modules', 'dist', 'build', '.git', 'target', '.mini-codegraph', '.venv', 'venv', '__pycache__'])
  }

  return (path: string) => {
    const rel = relative(root, path).replace(/\\/g, '/')
    if (!rel || rel.startsWith('..')) return false
    return ig.ignores(rel)
  }
}

export function findFiles(root: string, isIgnored: (path: string) => boolean): string[] {
  const result: string[] = []

  function walk(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry)
      if (isIgnored(fullPath)) continue

      try {
        const s = statSync(fullPath)
        if (s.isDirectory()) {
          walk(fullPath)
        } else if (s.isFile() && isSupportedFile(fullPath)) {
          result.push(fullPath)
        }
      } catch { /* silent */ }
    }
  }

  walk(root)
  return result
}

export { getGitChangedFiles }
export type { GitChanges }

export function extractDocstring(lines: string[], startLine: number): string {
  const docLines: string[] = []
  let lineIdx = startLine - 1
  while (lineIdx >= 0) {
    const trimmed = lines[lineIdx]?.trim()
    if (trimmed?.startsWith('//')) {
      docLines.unshift(trimmed.slice(2).trim())
    } else if (trimmed?.startsWith('*') && lineIdx > 0 && lines[lineIdx - 1]?.trim().endsWith('/**')) {
      docLines.unshift(trimmed.replace(/^\s*\*\s?/, ''))
    } else if (trimmed?.endsWith('*/')) {
      break
    } else if (trimmed?.startsWith('/**')) {
      docLines.unshift(trimmed.replace(/^\s*\/\*\*\s?/, ''))
      break
    } else if (lineIdx === startLine - 1) {
      lineIdx--
      continue
    } else {
      break
    }
    lineIdx--
  }
  return docLines.join(' ')
}
