import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../../db/queries.js'

export interface DroolsRule {
  id: string
  packageName: string
  ruleName: string
  dialect: string
  salience: number
  activationGroup: string
  agendaGroup: string
  noLoop: boolean
  lockOnActive: boolean
  autoFocus: boolean
  duration: number
  whenCondition: string
  thenAction: string
  filePath: string
}

export interface DroolsType {
  id: string
  packageName: string
  typeName: string
  fields: { name: string; type: string }[]
  filePath: string
}

export interface DroolsQuery {
  packageName: string
  queryName: string
  parameters: string[]
  expression: string
  filePath: string
}

export interface DroolsFunction {
  packageName: string
  functionName: string
  returnType: string
  parameters: string[]
  body: string
  filePath: string
}

export interface DroolsFileResult {
  rules: DroolsRule[]
  types: DroolsType[]
  queries: DroolsQuery[]
  functions: DroolsFunction[]
}

function extractPackageName(line: string): string | null {
  const m = /^package\s+([\w.]+)/.exec(line)
  return m ? m[1] : null
}

export function parseDrlFile(filePath: string): DroolsFileResult {
  const result: DroolsFileResult = {
    rules: [],
    types: [],
    queries: [],
    functions: [],
  }

  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    let packageName = ''

    for (const line of lines) {
      const pkg = extractPackageName(line)
      if (pkg) { packageName = pkg; break }
    }

    const ruleBlocks = content.match(/rule\s+"([^"]*)"[\s\S]*?end/g)
      || content.match(/rule\s+(\w+)[\s\S]*?end/g)

    if (ruleBlocks) {
      for (const block of ruleBlocks) {
        const rule = parseSingleRule(block, packageName, filePath)
        if (rule) result.rules.push(rule)
      }
    }

    const declareBlocks = content.match(/declare\s+([\w.]+)[\s\S]*?end/g)
    if (declareBlocks) {
      for (const block of declareBlocks) {
        const typeNameMatch = block.match(/declare\s+([\w.]+)/)
        if (typeNameMatch) {
          const typeName = typeNameMatch[1]
          const fieldRe = /\s+(\w+)\s+:\s+([\w<>,\[\]]+)/g
          const fields: { name: string; type: string }[] = []
          let fm: RegExpExecArray | null
          while ((fm = fieldRe.exec(block)) !== null) {
            if (fm[1] !== 'end' && fm[1] !== 'declare') {
              fields.push({ name: fm[1], type: fm[2] })
            }
          }
          result.types.push({
            id: `drools:${packageName}:${typeName}`,
            packageName,
            typeName,
            fields,
            filePath,
          })
        }
      }
    }

    const queryBlocks = content.match(/query\s+"([^"]*)"[\s\S]*?end/g)
      || content.match(/query\s+(\w+)[\s\S]*?end/g)
    if (queryBlocks) {
      for (const block of queryBlocks) {
        const qNameMatch = block.match(/query\s+"?([^"\s]+)"?/)
        if (qNameMatch) {
          const qName = qNameMatch[1]
          const paramRe = /\(([^)]*)\)/
          const paramMatch = block.match(paramRe)
          const parameters = paramMatch
            ? paramMatch[1].split(',').map(p => p.trim()).filter(Boolean)
            : []
          const bodyStart = block.indexOf('{')
          const bodyEnd = block.lastIndexOf('}')
          const expression = bodyStart !== -1 && bodyEnd !== -1
            ? block.substring(bodyStart + 1, bodyEnd).trim()
            : ''
          result.queries.push({
            packageName,
            queryName: qName,
            parameters,
            expression,
            filePath,
          })
        }
      }
    }

    const funcBlocks = content.match(/function\s+([\w<>[\],\s]+)\s+(\w+)\s*\([^)]*\)\s*\{[\s\S]*?\}/g)
    if (funcBlocks) {
      for (const block of funcBlocks) {
        const fMatch = block.match(/function\s+([\w<>[\],\s]+)\s+(\w+)\s*\(([^)]*)\)\s*\{/)
        if (fMatch) {
          const returnType = fMatch[1].trim()
          const funcName = fMatch[2]
          const params = fMatch[3].split(',').map(p => p.trim()).filter(Boolean)
          const bodyStart = block.indexOf('{')
          const bodyEnd = block.lastIndexOf('}')
          const body = bodyStart !== -1 && bodyEnd !== -1
            ? block.substring(bodyStart + 1, bodyEnd).trim()
            : ''
          result.functions.push({
            packageName,
            functionName: funcName,
            returnType,
            parameters: params,
            body,
            filePath,
          })
        }
      }
    }
  } catch { /* silent */ }

  return result
}

function parseSingleRule(block: string, packageName: string, filePath: string): DroolsRule | null {
  const nameMatch = block.match(/rule\s+"?([^"\s]+)"?/)
  if (!nameMatch) return null
  const ruleName = nameMatch[1]

  const dialectMatch = block.match(/dialect\s+"?(\w+)"?/)
  const salienceMatch = block.match(/salience\s+(-?\d+)/)
  const activationGroupMatch = block.match(/activation-group\s+"([^"]+)"/)
  const agendaGroupMatch = block.match(/agenda-group\s+"([^"]+)"/)
  const noLoopMatch = block.match(/\bno-loop\b/)
  const lockOnActiveMatch = block.match(/\block-on-active\b/)
  const autoFocusMatch = block.match(/\bauto-focus\b/)
  const durationMatch = block.match(/duration\s+(\d+)/)

  const whenStart = block.search(/\bwhen\s*\n?/)
  const thenStart = block.search(/\bthen\s*\n?/)

  let whenCondition = ''
  let thenAction = ''

  if (whenStart !== -1 && thenStart !== -1) {
    whenCondition = block.substring(
      whenStart + 4,
      thenStart
    ).replace(/^[\s:]+/, '').replace(/[\s:]+$/, '').trim()
  }

  if (thenStart !== -1) {
    const endIdx = block.lastIndexOf('end')
    thenAction = block.substring(
      thenStart + 4,
      endIdx !== -1 ? endIdx : block.length
    ).trim()
  }

  const escapedId = ruleName.replace(/[^a-zA-Z0-9_-]/g, '_')
  return {
    id: `drools:${packageName}:${escapedId}`,
    packageName,
    ruleName,
    dialect: dialectMatch?.[1] ?? 'java',
    salience: salienceMatch ? parseInt(salienceMatch[1]) : 0,
    activationGroup: activationGroupMatch?.[1] ?? '',
    agendaGroup: agendaGroupMatch?.[1] ?? '',
    noLoop: !!noLoopMatch,
    lockOnActive: !!lockOnActiveMatch,
    autoFocus: !!autoFocusMatch,
    duration: durationMatch ? parseInt(durationMatch[1]) : 0,
    whenCondition,
    thenAction,
    filePath,
  }
}

export function findDrlFiles(projectRoot: string): string[] {
  const files: string[] = []
  const searchDirs = [
    join(projectRoot, 'src', 'main', 'resources'),
    join(projectRoot, 'src', 'main', 'resources', 'rules'),
    join(projectRoot, 'src', 'main', 'resources', 'drools'),
    join(projectRoot, 'rules'),
    join(projectRoot, 'drl'),
    projectRoot,
  ]

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue
    try {
      const entries = readdirSync(dir, { recursive: true }) as string[]
      for (const e of entries) {
        if (e.endsWith('.drl') || e.endsWith('.dlr')) {
          files.push(join(dir, e))
        }
      }
    } catch { /* silent */ }
  }
  return files
}

export function detectDrools(projectRoot: string): boolean {
  const pomPath = join(projectRoot, 'pom.xml')
  if (existsSync(pomPath)) {
    try {
      const content = readFileSync(pomPath, 'utf-8')
      if (content.includes('drools-core') || content.includes('drools-compiler') || content.includes('kie-api')) {
        return true
      }
    } catch { /* silent */ }
  }
  return findDrlFiles(projectRoot).length > 0
}

export function indexDroolsFiles(queries: QueryManager, projectRoot: string, moduleId: string): DroolsFileResult {
  const merged: DroolsFileResult = { rules: [], types: [], queries: [], functions: [] }
  const files = findDrlFiles(projectRoot)

  for (const f of files) {
    const fileResult = parseDrlFile(f)

    for (const rule of fileResult.rules) {
      queries.insertDroolsRule(
        rule.id, rule.packageName, rule.ruleName,
        rule.dialect, rule.salience, rule.activationGroup,
        rule.agendaGroup, rule.noLoop ? 1 : 0,
        rule.lockOnActive ? 1 : 0, rule.autoFocus ? 1 : 0,
        rule.duration, rule.whenCondition, rule.thenAction,
        rule.filePath, moduleId
      )
    }

    for (const type of fileResult.types) {
      queries.insertDroolsType(type.id, type.packageName, type.typeName, JSON.stringify(type.fields), type.filePath)
    }

    for (const query of fileResult.queries) {
      const id = `drools:query:${query.packageName}:${query.queryName}`
      queries.insertDroolsQuery(id, query.packageName, query.queryName, JSON.stringify(query.parameters), query.expression, query.filePath)
    }

    for (const func of fileResult.functions) {
      const id = `drools:func:${func.packageName}:${func.functionName}`
      queries.insertDroolsFunction(id, func.packageName, func.functionName, func.returnType, JSON.stringify(func.parameters), func.body, func.filePath)
    }

    merged.rules.push(...fileResult.rules)
    merged.types.push(...fileResult.types)
    merged.queries.push(...fileResult.queries)
    merged.functions.push(...fileResult.functions)
  }

  return merged
}
