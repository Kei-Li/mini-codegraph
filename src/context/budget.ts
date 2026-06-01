export class OutputBudget {
  readonly totalBudget: number
  readonly perFileCap: number
  readonly nonProductionCap: number
  readonly maxFiles: number

  constructor(totalFiles: number) {
    this.totalBudget = this.computeBudget(totalFiles)
    this.perFileCap = Math.max(3, Math.floor(this.totalBudget / Math.max(1, Math.ceil(totalFiles / 10))))
    this.nonProductionCap = Math.max(2, Math.floor(this.totalBudget * 0.15))
    this.maxFiles = Math.max(5, Math.min(50, Math.ceil(totalFiles * 0.1)))
  }

  private computeBudget(totalFiles: number): number {
    if (totalFiles < 150) return 30
    if (totalFiles < 500) return 40
    if (totalFiles < 5000) return 50
    if (totalFiles < 15000) return 60
    return 70
  }

  isSufficientForRouting(): boolean {
    return this.totalBudget <= 40
  }

  isSmallRepo(): boolean {
    return this.totalBudget <= 40
  }

  shouldCollapse(): boolean {
    return this.totalBudget >= 50
  }

  getTier(): string {
    if (this.totalBudget <= 30) return 'tiny'
    if (this.totalBudget <= 40) return 'small'
    if (this.totalBudget <= 50) return 'medium'
    if (this.totalBudget <= 60) return 'large'
    return 'xlarge'
  }

  getMCPToolGating(): { exposeExplore: boolean; exposeTrace: boolean; exposeImpact: boolean } {
    const tier = this.getTier()
    return {
      exposeExplore: tier !== 'tiny',
      exposeTrace: tier !== 'tiny',
      exposeImpact: tier !== 'tiny' && tier !== 'small',
    }
  }
}

export function classifyFilePath(path: string): 'production' | 'test' | 'sample' | 'generated' {
  const lower = path.toLowerCase()
  if (lower.includes('test') || lower.includes('spec') || lower.includes('__test__')) return 'test'
  if (lower.includes('sample') || lower.includes('example') || lower.includes('demo')) return 'sample'
  if (lower.includes('generated') || lower.includes('.pb.') || lower.includes('mock') || lower.includes('_mock')) return 'generated'
  return 'production'
}
