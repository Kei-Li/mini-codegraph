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

    if (!existsSync(this.workspaceRoot)) return projects

    const entries = readdirSync(this.workspaceRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      const projectPath = join(this.workspaceRoot, entry.name)
      const project = this.detectProject(projectPath, entry.name)
      if (project) projects.push(project)
    }

    return projects
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
        if (deps.vue || deps.nuxt) { language = 'vue'; frameworks.push('vue') }
        else if (deps.react || deps['react-dom'] || deps.next) { language = 'typescript'; frameworks.push('react') }
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
