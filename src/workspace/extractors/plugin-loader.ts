import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { frameworkExtractor, type IExtractor } from './frameworks.js'

export interface PluginLoaderOptions {
  /** File extensions to scan (default: ['.js', '.mjs']) */
  extensions?: string[]
  /** Whether to register found extractors automatically (default: true) */
  autoRegister?: boolean
  /** Callback for each loaded plugin */
  onLoad?: (name: string, path: string) => void
  /** Callback on error */
  onError?: (path: string, error: Error) => void
}

export class PluginLoader {
  private loadedPlugins: Map<string, string> = new Map()
  private options: Required<PluginLoaderOptions>

  constructor(options?: PluginLoaderOptions) {
    this.options = {
      extensions: options?.extensions ?? ['.js', '.mjs'],
      autoRegister: options?.autoRegister ?? true,
      onLoad: options?.onLoad ?? (() => {}),
      onError: options?.onError ?? (() => {}),
    }
  }

  getLoadedPlugins(): Map<string, string> {
    return new Map(this.loadedPlugins)
  }

  /**
   * Scan a directory for extractor plugin files.
   * Returns the list of files found (without loading them).
   */
  scan(pluginDir: string): string[] {
    if (!existsSync(pluginDir)) return []

    const files: string[] = []
    const entries = readdirSync(pluginDir)

    for (const entry of entries) {
      const fullPath = join(pluginDir, entry)
      if (statSync(fullPath).isDirectory()) {
        files.push(...this.scan(fullPath))
      } else if (this.options.extensions.includes(extname(entry))) {
        files.push(fullPath)
      }
    }

    return files
  }

  /**
   * Load a single plugin file, register its extractors with the frameworkExtractor.
   */
  async loadPlugin(pluginPath: string): Promise<boolean> {
    try {
      const pluginName = basename(pluginPath, extname(pluginPath))
      if (this.loadedPlugins.has(pluginName)) return false

      const mod = await import(pluginPath) as Record<string, unknown>

      let loaded = false
      for (const [, value] of Object.entries(mod)) {
        if (
          value &&
          typeof value === 'function' &&
          value.prototype &&
          'name' in value.prototype &&
          'extract' in value.prototype
        ) {
          const instance = new (value as new () => IExtractor)()
          if (this.options.autoRegister) {
            frameworkExtractor.register(instance)
          }
          this.loadedPlugins.set(instance.name, pluginPath)
          this.options.onLoad(instance.name, pluginPath)
          loaded = true
        }
      }

      return loaded
    } catch (err) {
      this.options.onError(pluginPath, err as Error)
      return false
    }
  }

  /**
   * Scan and load all plugins from a directory.
   */
  async loadAll(pluginDir: string): Promise<{ loaded: number; failed: number; files: string[] }> {
    const files = this.scan(pluginDir)
    let loaded = 0
    let failed = 0

    for (const file of files) {
      const ok = await this.loadPlugin(file)
      if (ok) loaded++
      else failed++
    }

    return { loaded, failed, files }
  }

  /**
   * Unload a previously loaded plugin by name.
   */
  unload(name: string): boolean {
    return this.loadedPlugins.delete(name)
  }
}
