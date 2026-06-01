import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { QueryManager } from '../db/queries.js'
import { isSupportedFile } from '../utils.js'

export class GitSyncManager {
  private projectRoot: string
  private lastCommitHash = ''
  private trackedFiles = new Set<string>()

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
  }

  isGitRepo(): boolean {
    return existsSync(join(this.projectRoot, '.git'))
  }

  getCurrentCommitHash(): string {
    try {
      return execSync('git rev-parse HEAD', { cwd: this.projectRoot, encoding: 'utf-8' }).trim()
    } catch {
      return ''
    }
  }

  getChangedFilesSince(hash: string): string[] {
    try {
      const changed = execSync(`git diff --name-only ${hash}..HEAD`, { cwd: this.projectRoot, encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean)
      const untracked = execSync('git ls-files --others --exclude-standard', { cwd: this.projectRoot, encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean)
      return [...changed, ...untracked].filter(f => isSupportedFile(f))
    } catch {
      return []
    }
  }

  getAllTrackedFiles(): string[] {
    try {
      return execSync('git ls-files', { cwd: this.projectRoot, encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean).filter(f => isSupportedFile(f))
    } catch {
      return []
    }
  }

  getFileDiff(oldHash: string, filePath: string): { added: number; removed: number; lines: string[] } {
    try {
      const diff = execSync(`git diff ${oldHash}..HEAD -- "${filePath}"`, { cwd: this.projectRoot, encoding: 'utf-8' })
      const lines = diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-'))
      const added = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length
      const removed = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length
      return { added, removed, lines }
    } catch {
      return { added: 0, removed: 0, lines: [] }
    }
  }

  detectNewFilesSince(hash: string): string[] {
    try {
      const newFiles = execSync(`git diff --diff-filter=A --name-only ${hash}..HEAD`, { cwd: this.projectRoot, encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean)
      return newFiles.filter(f => isSupportedFile(f))
    } catch {
      return []
    }
  }

  detectDeletedFilesSince(hash: string): string[] {
    try {
      const deleted = execSync(`git diff --diff-filter=D --name-only ${hash}..HEAD`, { cwd: this.projectRoot, encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean)
      return deleted
    } catch {
      return []
    }
  }

  sync(queries: QueryManager): { added: string[]; removed: string[]; changed: string[] } {
    const prevHash = this.lastCommitHash
    const currentHash = this.getCurrentCommitHash()

    if (!prevHash || prevHash === currentHash) {
      this.lastCommitHash = currentHash
      return { added: [], removed: [], changed: [] }
    }

    if (!this.isGitRepo()) {
      return { added: [], removed: [], changed: [] }
    }

    const newFiles = this.detectNewFilesSince(prevHash)
    const deletedFiles = this.detectDeletedFilesSince(prevHash)
    const changedFiles = this.getChangedFilesSince(prevHash)

    for (const f of deletedFiles) {
      const fullPath = join(this.projectRoot, f)
      const absPath = fullPath.replace(/\\/g, '/')
      const nodes = queries.getNodesByFile(f)
      for (const node of nodes) {
        queries.deleteNodesForFile(f)
      }
      this.trackedFiles.delete(f)
    }

    for (const f of changedFiles) {
      this.trackedFiles.add(f)
    }

    for (const f of newFiles) {
      this.trackedFiles.add(f)
    }

    this.lastCommitHash = currentHash

    return { added: newFiles, removed: deletedFiles, changed: changedFiles }
  }

  getLastCommitHash(): string {
    return this.lastCommitHash
  }

  setLastCommitHash(hash: string): void {
    this.lastCommitHash = hash
  }
}
