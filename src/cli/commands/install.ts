import { join } from 'node:path'
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { logInfo, logError } from '../../logger.js'

export async function handleInstall(options: { target?: string; yes?: boolean; location?: string }): Promise<void> {
  const targets = (options.target || 'opencode').split(',').map((t: string) => t.trim())
  const location = options.location || 'global'
  const yes = options.yes || false

  const cliPath = ensureCliOnPath()
  if (cliPath) {
    logInfo(`CLI available at: ${cliPath}`)
  } else {
    logError('Warning: mini-codegraph not found on PATH. Agents may not be able to launch the server.')
    logError('Add the dist/ directory to your PATH or run: npm link')
  }

  const configs: { agent: string; configPath: string; config: any }[] = []

  for (const target of targets) {
    switch (target) {
      case 'opencode': {
        const configDir = join(homedir(), '.config', 'opencode')
        const configPath = join(configDir, 'opencode.json')
        const projectRoot = process.cwd()

        if (!existsSync(configDir) && !yes) {
          logError(`opencode config directory not found at ${configDir}`)
          continue
        }

        let opencodeConfig: any = { mcpServers: {} }
        if (existsSync(configPath)) {
          try {
            opencodeConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
          } catch { /* silent */ }
        }

        opencodeConfig.mcpServers = opencodeConfig.mcpServers || {}
        opencodeConfig.mcpServers['mini-codegraph'] = {
          type: 'stdio',
      command: 'mini-codegraph',
      args: ['serve', location === 'local' ? projectRoot : ''],
        }

        if (!existsSync(configDir)) {
          mkdirSync(configDir, { recursive: true })
        }

        configs.push({ agent: 'opencode', configPath, config: opencodeConfig })
        break
      }

      case 'claude': {
        const configPath = join(homedir(), '.claude.json')
        let claudeConfig: any = { mcpServers: {} }
        if (existsSync(configPath)) {
          try {
            claudeConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
          } catch { /* silent */ }
        }

        claudeConfig.mcpServers = claudeConfig.mcpServers || {}
        claudeConfig.mcpServers['mini-codegraph'] = {
          type: 'stdio',
          command: 'mini-codegraph',
          args: ['serve'],
        }

        configs.push({ agent: 'claude', configPath, config: claudeConfig })
        break
      }

      case 'cursor': {
        const configDir = join(homedir(), '.cursor')
        const configPath = join(configDir, 'mcp.json')
        let cursorConfig: any = { mcpServers: {} }
        if (existsSync(configPath)) {
          try {
            cursorConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
          } catch { /* silent */ }
        }
        cursorConfig.mcpServers = cursorConfig.mcpServers || {}
        cursorConfig.mcpServers['mini-codegraph'] = {
          type: 'stdio',
          command: 'mini-codegraph',
          args: ['serve'],
        }
        if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
        configs.push({ agent: 'cursor', configPath, config: cursorConfig })
        break
      }

      case 'codex': {
        const configPath = join(process.cwd(), '.codex.json')
        let codexConfig: any = {}
        if (existsSync(configPath)) {
          try { codexConfig = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* silent */ }
        }
        codexConfig.mcpServers = codexConfig.mcpServers || {}
        codexConfig.mcpServers['mini-codegraph'] = {
          type: 'stdio',
          command: 'mini-codegraph',
          args: ['serve'],
        }
        configs.push({ agent: 'codex', configPath, config: codexConfig })
        break
      }

      case 'gemini': {
        const configPath = join(homedir(), '.gemini', 'mcp.json')
        let geminiConfig: any = { mcpServers: {} }
        if (existsSync(configPath)) {
          try { geminiConfig = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* silent */ }
        }
        geminiConfig.mcpServers = geminiConfig.mcpServers || {}
        geminiConfig.mcpServers['mini-codegraph'] = {
          type: 'stdio',
          command: 'mini-codegraph',
          args: ['serve'],
        }
        const configDir = join(homedir(), '.gemini')
        if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
        configs.push({ agent: 'gemini', configPath, config: geminiConfig })
        break
      }

      case 'hermes': {
        const configDir = join(homedir(), '.config', 'hermes')
        const configPath = join(configDir, 'config.json')
        let hermesConfig: any = { mcpServers: {} }
        if (existsSync(configPath)) {
          try { hermesConfig = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* silent */ }
        }
        hermesConfig.mcpServers = hermesConfig.mcpServers || {}
        hermesConfig.mcpServers['mini-codegraph'] = {
          type: 'stdio',
          command: 'mini-codegraph',
          args: ['serve'],
        }
        if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
        configs.push({ agent: 'hermes', configPath, config: hermesConfig })
        break
      }

      case 'antigravity': {
        const configDir = join(homedir(), '.antigravity')
        const configPath = join(configDir, 'mcp.json')
        let agConfig: any = { mcpServers: {} }
        if (existsSync(configPath)) {
          try { agConfig = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* silent */ }
        }
        agConfig.mcpServers = agConfig.mcpServers || {}
        agConfig.mcpServers['mini-codegraph'] = {
          type: 'stdio',
          command: 'mini-codegraph',
          args: ['serve'],
        }
        if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
        configs.push({ agent: 'antigravity', configPath, config: agConfig })
        break
      }

      case 'kiro': {
        const configPath = join(homedir(), '.kiro', 'mcp.json')
        let kiroConfig: any = { mcpServers: {} }
        if (existsSync(configPath)) {
          try { kiroConfig = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* silent */ }
        }
        kiroConfig.mcpServers = kiroConfig.mcpServers || {}
        kiroConfig.mcpServers['mini-codegraph'] = {
          type: 'stdio',
          command: 'mini-codegraph',
          args: ['serve'],
        }
        const configDir = join(homedir(), '.kiro')
        if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
        configs.push({ agent: 'kiro', configPath, config: kiroConfig })
        break
      }

      default:
        logError(`Unknown agent target: ${target}`)
    }
  }

  for (const { agent, configPath, config } of configs) {
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    logInfo(`Configured ${agent} at ${configPath}`)
  }

  if (configs.length > 0) {
    const projectRoot = process.cwd()
    if (!existsSync(join(projectRoot, '.mini-codegraph', 'mini-codegraph.db'))) {
      logError('Note: project not initialized. Run "mini-codegraph init" and "mini-codegraph index" first.')
    }
    logInfo('Done!')
  }
}

function ensureCliOnPath(): string | null {
  try {
    execFileSync('mini-codegraph', ['--version'], { stdio: 'pipe' })
    return 'mini-codegraph'
  } catch { /* silent */ }

  const distCli = join(process.cwd(), 'dist', 'cli.js')
  if (existsSync(distCli)) {
    return `node ${distCli}`
  }

  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf-8' }).trim()
    const npmCli = join(npmRoot, 'mini-codegraph', 'dist', 'cli.js')
    if (existsSync(npmCli)) {
      return `node ${npmCli}`
    }
  } catch { /* silent */ }

  return null
}
