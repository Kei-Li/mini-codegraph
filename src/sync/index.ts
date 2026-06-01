export {
  FileWatcher,
  LockUnavailableError,
} from './watcher.js'
export { buildDefaultIgnore } from '../utils.js'
export type { WatchOptions, PendingFile } from './watcher.js'
export { watchDisabledReason, detectWsl, __resetWslCacheForTests } from './watch-policy.js'
export type { WatchProbe } from './watch-policy.js'
export {
  installGitSyncHook,
  removeGitSyncHook,
  isSyncHookInstalled,
  isGitRepo,
  DEFAULT_SYNC_HOOKS,
} from './git-hooks.js'
export type { GitHookName, GitHookResult } from './git-hooks.js'
export {
  gitWorktreeRoot,
  detectWorktreeIndexMismatch,
  worktreeMismatchWarning,
  worktreeMismatchNotice,
} from './worktree.js'
export type { WorktreeIndexMismatch } from './worktree.js'
