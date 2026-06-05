import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface ScannedProject {
  name: string
  rootPath: string
  language: string
  buildSystem: string
  frameworks: string[]
}

export class WorkspaceScanner {
  private workspaceRoot: string

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot)
  }

  scan(): ScannedProject[] {
    const projects: ScannedProject[] = []
    const seenPaths = new Set<string>()

    if (!existsSync(this.workspaceRoot)) return projects

    const entries = readdirSync(this.workspaceRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      const projectPath = join(this.workspaceRoot, entry.name)
      if (seenPaths.has(projectPath)) continue
      seenPaths.add(projectPath)

      // Detect top-level project
      const project = this.detectProject(projectPath, entry.name)
      if (project) {
        projects.push(project)
      }

      // Recursively discover Maven/Gradle sub-modules inside monorepo
      const subModules = this.discoverSubModules(projectPath, seenPaths)
      for (const sm of subModules) {
        const smProject = this.detectProject(sm.path, sm.name)
        if (smProject) projects.push(smProject)
      }
    }

    return projects
  }

  private discoverSubModules(rootPath: string, seenPaths: Set<string>): { name: string; path: string }[] {
    const modules: { name: string; path: string }[] = []

    // Maven multi-module: read <modules> from pom.xml
    const pomPath = join(rootPath, 'pom.xml')
    if (existsSync(pomPath)) {
      try {
        const content = readFileSync(pomPath, 'utf-8')
        const moduleRegex = /<module>([^<]+)<\/module>/g
        let m: RegExpExecArray | null
        while ((m = moduleRegex.exec(content)) !== null) {
          const modDir = join(rootPath, m[1])
          if (!seenPaths.has(modDir) && existsSync(modDir)) {
            seenPaths.add(modDir)
            modules.push({ name: m[1], path: modDir })
            // Nested: sub-module may have its own sub-modules
            modules.push(...this.discoverSubModules(modDir, seenPaths))
          }
        }
      } catch { /* silent */ }
    }

    // Gradle multi-project: read settings.gradle[.kts] for include statements
    for (const settingsFile of ['settings.gradle', 'settings.gradle.kts']) {
      const settingsPath = join(rootPath, settingsFile)
      if (existsSync(settingsPath)) {
        try {
          const content = readFileSync(settingsPath, 'utf-8')
          const includeRegex = /include\s+(?:"([^"]+)"|'([^']+)')/g
          let im: RegExpExecArray | null
          while ((im = includeRegex.exec(content)) !== null) {
            const modPath = im[1] || im[2]
            const modDir = join(rootPath, modPath)
            if (!seenPaths.has(modDir) && existsSync(modDir)) {
              seenPaths.add(modDir)
              const modName = modPath.split('/').pop() || modPath
              modules.push({ name: modName, path: modDir })
              modules.push(...this.discoverSubModules(modDir, seenPaths))
            }
          }
        } catch { /* silent */ }
      }
    }

    return modules
  }

  private detectProject(projectPath: string, name: string): ScannedProject | null {
    if (!existsSync(projectPath)) return null

    const hasPom = existsSync(join(projectPath, 'pom.xml'))
    const hasGradle = existsSync(join(projectPath, 'build.gradle')) || existsSync(join(projectPath, 'build.gradle.kts'))
    const hasPackageJson = existsSync(join(projectPath, 'package.json'))
    const hasGit = existsSync(join(projectPath, '.git'))
    const hasRequirements = existsSync(join(projectPath, 'requirements.txt')) || existsSync(join(projectPath, 'setup.py')) || existsSync(join(projectPath, 'pyproject.toml'))
    const hasCargo = existsSync(join(projectPath, 'Cargo.toml'))
    const hasGoMod = existsSync(join(projectPath, 'go.mod'))

    let language = 'unknown'
    let buildSystem = 'unknown'
    const frameworks: string[] = []

    if (hasPom) {
      buildSystem = 'maven'
      language = 'java'
      try {
        const pomContent = readFileSync(join(projectPath, 'pom.xml'), 'utf-8')
        if (pomContent.includes('spring-boot') || pomContent.includes('spring-cloud')) {
          frameworks.push('spring')
        }
      } catch { /* silent */ }
    } else if (hasGradle) {
      buildSystem = 'gradle'
      language = 'java'
    } else if (hasPackageJson) {
      buildSystem = 'npm'
      try {
        const pkg = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf-8'))
        const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>
        if (deps.vue || deps.nuxt) {
          language = 'vue'; frameworks.push('vue')
          if (deps.nuxt || deps['nuxt3']) frameworks.push('ssr-nuxt')
          if (existsSync(join(projectPath, 'server'))) frameworks.push('ssr-nuxt-server')
        } else if (deps.react || deps['react-dom'] || deps.next) {
          language = 'typescript'; frameworks.push('react')
          if (deps.next) {
            frameworks.push('ssr-next')
            if (existsSync(join(projectPath, 'app'))) frameworks.push('ssr-next-app-router')
            if (existsSync(join(projectPath, 'pages'))) frameworks.push('ssr-next-pages-router')
          }
        } else if (deps['@angular/core'] || deps['@angular/common'] || deps.angular) { language = 'typescript'; frameworks.push('angular') }
        else language = 'typescript'
      } catch { language = 'typescript' }
    } else if (hasRequirements || hasPythonProject(projectPath)) {
      buildSystem = 'pip'
      language = 'python'
    } else if (hasCargo) {
      buildSystem = 'cargo'
      language = 'rust'
    } else if (hasGoMod) {
      buildSystem = 'go-modules'
      language = 'go'
    }

    if (language === 'unknown' && hasGit) {
      language = 'unknown'
      buildSystem = 'git'
    }

    if (language === 'unknown') return null

    return { name, rootPath: projectPath, language, buildSystem, frameworks }
  }
}

function hasPythonProject(dir: string): boolean {
  try {
    const entries = readdirSync(dir)
    for (const e of entries) {
      if (e.endsWith('.py')) return true
    }
    const subdirs = entries.filter(e => {
      try { return statSync(join(dir, e)).isDirectory() && !e.startsWith('.') && e !== 'node_modules' && e !== '__pycache__' }
      catch { return false }
    })
    for (const sub of subdirs) {
      if (hasPythonProject(join(dir, sub))) return true
    }
  } catch { /* silent */ }
  return false
}
