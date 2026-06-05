import type { QueryManager } from '../db/queries.js'

export interface CssClass {
  selector: string
  type: 'class' | 'id' | 'element' | 'mixin' | 'variable' | 'keyframe'
  filePath: string
  line: number
  moduleId: string
}

export interface HtmlElement {
  tag: string
  classes: string[]
  id: string
  filePath: string
  line: number
  moduleId: string
}

export function indexCssClasses(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): CssClass[] {
  const results: CssClass[] = []
  const lines = source.split('\n')
  const seen = new Set<string>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    let m: RegExpExecArray | null
    const classRe = /\.([\w-]+)\s*\{/g
    while ((m = classRe.exec(line)) !== null) {
      const key = `class:${m[1]}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push({ selector: m[1], type: 'class', filePath, line: i + 1, moduleId })
    }

    const idRe = /#([\w-]+)\s*\{/g
    while ((m = idRe.exec(line)) !== null) {
      const key = `id:${m[1]}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push({ selector: m[1], type: 'id', filePath, line: i + 1, moduleId })
    }

    if (filePath.endsWith('.scss') || filePath.endsWith('.less')) {
      const mixinRe = /@mixin\s+(\w+)/g
      while ((m = mixinRe.exec(line)) !== null) {
        const key = `mixin:${m[1]}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({ selector: m[1], type: 'mixin', filePath, line: i + 1, moduleId })
      }
      const varRe = /\$(\w+)\s*:/g
      while ((m = varRe.exec(line)) !== null) {
        const key = `var:${m[1]}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({ selector: m[1], type: 'variable', filePath, line: i + 1, moduleId })
      }
    }

    const keyframeRe = /@keyframes\s+(\w+)/g
    while ((m = keyframeRe.exec(line)) !== null) {
      const key = `keyframe:${m[1]}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push({ selector: m[1], type: 'keyframe', filePath, line: i + 1, moduleId })
    }
  }

  for (const c of results) {
    const nodeId = `${filePath}:${c.type}.${c.selector}`
    queries.insertAnnotation(nodeId, `Css${c.type.charAt(0).toUpperCase() + c.type.slice(1)}`,
      JSON.stringify({ selector: c.selector }), c.line, moduleId)
  }

  return results
}

export function indexHtmlElements(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): HtmlElement[] {
  const results: HtmlElement[] = []
  const lines = source.split('\n')
  const seen = new Set<string>()

  const tagRe = /<(\w+)([^>]*)>/g
  for (let i = 0; i < lines.length; i++) {
    let m: RegExpExecArray | null
    while ((m = tagRe.exec(lines[i])) !== null) {
      const tag = m[1]
      const attrs = m[2]
      const classMatch = attrs.match(/class\s*=\s*["']([^"']+)["']/)
      const idMatch = attrs.match(/id\s*=\s*["']([^"']+)["']/)
      const classes = classMatch ? classMatch[1].split(/\s+/) : []
      const id = idMatch ? idMatch[1] : ''

      const key = `${tag}:${id || classes.join('.')}`
      if (seen.has(key)) continue
      seen.add(key)

      results.push({ tag, classes, id, filePath, line: i + 1, moduleId })

      const nodeId = `${filePath}:${tag}:${i + 1}`
      queries.insertAnnotation(nodeId, 'HtmlElement',
        JSON.stringify({ tag, classes, id }), i + 1, moduleId)
    }
  }

  return results
}
