import type { QueryManager } from '../../db/queries.js'
import type { MiniCodeGraphNode } from '../../types.js'

export interface DataSource {
  kind: 'db_query' | 'service_call' | 'field_access' | 'parameter' | 'literal' | 'config_property' | 'http_request' | 'system_property'
  tableName?: string
  columnName?: string
  entityType?: string
  fieldName?: string
  methodName: string
  detail: string
}

export interface TracedVariable {
  variableName: string
  possibleKeys: string[]
  methodName: string
  steps: TraceStep[]
  dataSource?: DataSource
}

interface TraceStep {
  kind: 'assignment' | 'method_return' | 'parameter' | 'field' | 'literal' | 'switch_case'
  description: string
  nodeId: string
}

const DB_METHOD_PREFIXES = ['find', 'get', 'query', 'search', 'fetch', 'load', 'read', 'select']
const DB_METHOD_SUFFIXES = ['ById', 'ByKey', 'ByName', 'ByCode', 'ByType', 'All', 'One', 'List']

function isLikelyDbMethod(name: string): boolean {
  const lower = name.toLowerCase()
  // Pure 'get', 'find', 'load' alone are too generic (e.g., Map.get())
  if (lower === 'get' || lower === 'find' || lower === 'load' || lower === 'fetch') return false
  return DB_METHOD_PREFIXES.some(p => lower.startsWith(p)) &&
    (DB_METHOD_SUFFIXES.some(s => lower.includes(s.toLowerCase())) ||
     lower === 'find' || lower === 'get')
}

function isGetterMethod(name: string): boolean {
  return (name.startsWith('get') && name.length > 3) ||
         (name.startsWith('is') && name.length > 2)
}

function inferEntityFromMethod(methodName: string, parentClassName: string): string | undefined {
  // e.g., orderRepository.findById → entity = Order
  // e.g., configRepository.findByKey → entity = Config
  if (parentClassName) {
    let entity = parentClassName
      .replace(/Repository$/, '')
      .replace(/Service$/, '')
      .replace(/Mapper$/, '')
      .replace(/Dao$/i, '')
      .replace(/Client$/, '')
      .replace(/Manager$/, '')
    if (entity) return entity
  }
  // Try to extract from method: findByKey('payment.handler') → entity from context
  return undefined
}

function inferFieldFromGetter(getterName: string): string | undefined {
  if (getterName.startsWith('get')) {
    return getterName.charAt(3).toLowerCase() + getterName.slice(4)
  }
  if (getterName.startsWith('is')) {
    return getterName.charAt(2).toLowerCase() + getterName.slice(3)
  }
  return undefined
}

const HTTP_PARAM_METHODS = ['getParameter', 'getParameterValues', 'getParameterMap', 'getQueryString']
const HTTP_HEADER_METHODS = ['getHeader', 'getHeaders', 'getIntHeader', 'getDateHeader']
const HTTP_ATTR_METHODS = ['getAttribute', 'getSession']
const ENV_METHODS = ['getProperty', 'getenv', 'getEnv']
const REQUEST_BODY_METHODS = ['getBody', 'getReader', 'getInputStream']
const ANNOTATION_HTTP_SOURCES = ['RequestParam', 'PathVariable', 'RequestHeader', 'RequestAttribute', 'RequestPart']
const ANNOTATION_CONFIG_SOURCES = ['Value']

function detectDataSource(
  methodName: string,
  parentClassName: string,
  calleeEdges: { kind: string; targetId: string }[],
  allEdges: { kind: string; sourceId: string; targetId: string }[],
  queries: QueryManager,
): DataSource | undefined {
  // HTTP request parameters: request.getParameter("type")
  if (HTTP_PARAM_METHODS.includes(methodName)) {
    return {
      kind: 'http_request',
      methodName,
      detail: `HTTP 请求参数: ${methodName}()`,
      columnName: methodName,
    }
  }

  // HTTP headers: request.getHeader("X-Type")
  if (HTTP_HEADER_METHODS.includes(methodName)) {
    return {
      kind: 'http_request',
      methodName,
      detail: `HTTP 请求头: ${methodName}()`,
      columnName: methodName,
    }
  }

  // Session/request attributes: request.getAttribute("key")
  if (HTTP_ATTR_METHODS.includes(methodName)) {
    return {
      kind: 'http_request',
      methodName,
      detail: `HTTP Session/Attribute: ${methodName}()`,
      columnName: methodName,
    }
  }

  // Request body: request.getBody()
  if (REQUEST_BODY_METHODS.includes(methodName)) {
    return {
      kind: 'http_request',
      methodName,
      detail: 'HTTP 请求体 (RequestBody)',
      columnName: methodName,
    }
  }

  // System properties / environment variables
  if (ENV_METHODS.includes(methodName)) {
    return {
      kind: 'system_property',
      methodName,
      detail: `系统属性/环境变量: ${methodName}()`,
      columnName: methodName,
    }
  }

  if (isLikelyDbMethod(methodName)) {
    const entity = inferEntityFromMethod(methodName, parentClassName)
    const detail = entity
      ? `查询数据库 ${entity}`
      : `数据库查询: ${methodName}()`
    return {
      kind: 'db_query',
      entityType: entity,
      methodName,
      detail,
      tableName: entity,
    }
  }

  if (isGetterMethod(methodName)) {
    const field = inferFieldFromGetter(methodName)
    const entity = parentClassName || undefined
    return {
      kind: 'field_access',
      entityType: entity,
      fieldName: field || methodName,
      methodName,
      detail: entity && field
        ? `${entity}.${field} 字段值`
        : `getter: ${methodName}()`,
    }
  }

  return undefined
}

/**
 * Trace a variable's origin across method boundaries.
 *
 * Strategy:
 *  1. Look for assignments to this variable in the current method
 *  2. If the assignment is from a method call return, recurse into that method
 *  3. Detect data sources (DB queries, getters) along the chain
 *  4. If the source is a runtime data source with no possible literal keys,
 *     still return a TracedVariable with the dataSource field set
 */
export function traceVariable(
  varName: string,
  methodId: string,
  queries: QueryManager,
  depth = 0,
  visitedMethods = new Set<string>(),
): TracedVariable | null {
  if (depth > 3 || visitedMethods.has(methodId)) return null
  visitedMethods.add(methodId)

  const methodNode = queries.getNode(methodId)
  if (!methodNode) return null

  const methodParent = methodNode.parentId ? queries.getNode(methodNode.parentId) : null
  const parentClassName = methodParent?.name ?? ''

  const allNodes = queries.getAllNodes()
  const allEdges = queries.getAllEdges()
  const children = allNodes.filter(n => n.parentId === methodId)

  const possibleKeys: string[] = []
  const steps: TraceStep[] = []
  let dataSource: DataSource | undefined

  // 1. Direct assignments (variable declaration with literal)
  const varDeclarations = children.filter(n =>
    (n.kind === 'variable' || n.kind === 'assignment') &&
    (n.name === varName || (n as any).declaredName === varName)
  )

  for (const decl of varDeclarations) {
    const refs = allEdges.filter(e => e.sourceId === decl.id && e.kind === 'references')
    for (const ref of refs) {
      const target = queries.getNode(ref.targetId)
      if (!target) continue
      if (target.kind === 'string_literal' || target.kind === 'literal') {
        const val = target.name.replace(/['"]/g, '')
        possibleKeys.push(val)
        steps.push({ kind: 'literal', description: `${varName} = "${val}"`, nodeId: target.id })
      }
      if (target.kind === 'method' || target.kind === 'function') {
        const targetParent = target.parentId ? queries.getNode(target.parentId) : null
        const ds = detectDataSource(target.name, targetParent?.name ?? '', [], allEdges, queries)
        if (ds) {
          dataSource = ds
          steps.push({ kind: 'method_return', description: ds.detail, nodeId: target.id })
        }
        const subTrace = traceVariableValueOfMethod(target.id, queries, depth + 1, visitedMethods)
        if (subTrace) {
          possibleKeys.push(...subTrace.possibleKeys)
          steps.push({ kind: 'method_return', description: `${target.name} → ${subTrace.possibleKeys.join(', ')}`, nodeId: target.id })
        }
      }
    }
  }

  // 2. Assignment from method call return value
  const callEdges = allEdges.filter(e =>
    e.kind === 'calls' && e.sourceId === methodId
  )
  for (const call of callEdges) {
    const targetMethod = queries.getNode(call.targetId)
    if (!targetMethod) continue

    const targetParent = targetMethod.parentId ? queries.getNode(targetMethod.parentId) : null
    const ds = detectDataSource(targetMethod.name, targetParent?.name ?? '', callEdges, allEdges, queries)
    if (ds && !dataSource) {
      dataSource = ds
      steps.push({ kind: 'method_return', description: ds.detail, nodeId: targetMethod.id })
    }

    const resultRefs = allEdges.filter(e =>
      e.sourceId === call.targetId && e.kind === 'returns'
    )
    for (const rr of resultRefs) {
      const returnNode = queries.getNode(rr.targetId)
      if (!returnNode) continue

      if (returnNode.kind === 'literal' || returnNode.kind === 'string_literal') {
        const val = returnNode.name.replace(/['"]/g, '')
        possibleKeys.push(val)
        steps.push({ kind: 'method_return', description: `${targetMethod.name} returns "${val}"`, nodeId: returnNode.id })
      }
    }

    const subTrace = traceVariableValueOfMethod(targetMethod.id, queries, depth + 1, visitedMethods)
    if (subTrace) {
      possibleKeys.push(...subTrace.possibleKeys)
      steps.push(...subTrace.steps.map(s => ({
        ...s,
        description: `${targetMethod.name} → ${s.description}`,
      })))
    }
  }

  // 3. Variable passed as parameter — trace from caller perspective
  const paramNodes = children.filter(n =>
    n.kind === 'parameter' && (n.name === varName || (n as any).declaredName === varName)
  )
  if (paramNodes.length > 0 && !dataSource) {
    for (const pn of paramNodes) {
      const pnAnns = queries.getAnnotationsByNode(pn.id)
      // HTTP source annotations
      const httpAnn = pnAnns.find(a => ANNOTATION_HTTP_SOURCES.includes(a.annotationName))
      if (httpAnn) {
        const annValue = httpAnn.value || varName
        dataSource = {
          kind: 'http_request',
          methodName: varName,
          detail: `HTTP ${httpAnn.annotationName}: ${annValue}`,
          columnName: annValue,
        }
        steps.push({ kind: 'parameter', description: dataSource.detail, nodeId: pn.id })
        break
      }
      // Config property annotation
      const configAnn = pnAnns.find(a => ANNOTATION_CONFIG_SOURCES.includes(a.annotationName))
      if (configAnn) {
        const annValue = configAnn.value || varName
        dataSource = {
          kind: 'config_property',
          methodName: varName,
          detail: `配置属性 @Value: ${annValue}`,
          columnName: annValue,
        }
        steps.push({ kind: 'parameter', description: dataSource.detail, nodeId: pn.id })
        break
      }
    }
  }
  if (paramNodes.length > 0) {
    const callersOfMethod = queries.getCallers(methodId)
    for (const caller of callersOfMethod) {
      const callerChildren = allNodes.filter(n => n.parentId === caller.id)
      const argNodes = callerChildren.filter(n =>
        n.kind === 'argument' || n.kind === 'expression'
      )
      for (const arg of argNodes) {
        const subTrace = traceVariable(arg.name, caller.id, queries, depth + 1, visitedMethods)
        if (subTrace) {
          possibleKeys.push(...subTrace.possibleKeys)
          if (subTrace.dataSource && !dataSource) dataSource = subTrace.dataSource
          steps.push({
            kind: 'parameter',
            description: `caller ${caller.name} passes arg → ${subTrace.possibleKeys.join(', ')}`,
            nodeId: caller.id,
          })
        }

        if (arg.kind === 'literal' || arg.kind === 'string_literal') {
          const val = arg.name.replace(/['"]/g, '')
          possibleKeys.push(val)
          steps.push({ kind: 'literal', description: `caller passes "${val}" as argument`, nodeId: arg.id })
        }
      }
    }
  }

  // 4. Switch/case that uses this variable
  const switchNodes = children.filter(n =>
    n.kind === 'switch' || n.kind === 'switch_block'
  )
  for (const sw of switchNodes) {
    const switchRefs = allEdges.filter(e =>
      e.sourceId === methodId && e.targetId === sw.id
    )
    if (switchRefs.length === 0) continue

    const caseLabels = allNodes
      .filter(n => (n.kind === 'case' || n.kind === 'switch_case') && n.parentId === sw.id)
      .map(n => n.name.replace(/^case\s+/, '').replace(/['"]/g, '').trim())
      .filter(Boolean)

    if (caseLabels.length > 0) {
      possibleKeys.push(...caseLabels)
      steps.push({ kind: 'switch_case', description: `switch labels: ${caseLabels.join(', ')}`, nodeId: sw.id })
    }
  }

  // 5. Field access — trace the field assignment + detect object origin
  for (const node of children) {
    if (node.kind === 'field_access' && node.name.endsWith(varName)) {
      const fieldRefs = allEdges.filter(e => e.sourceId === node.id && e.kind === 'references')
      for (const fr of fieldRefs) {
        const fieldNode = queries.getNode(fr.targetId)
        if (!fieldNode) continue

        // Detect field access as data source
        const fieldParent = fieldNode.parentId ? queries.getNode(fieldNode.parentId) : null
        if (!dataSource) {
          dataSource = {
            kind: 'field_access',
            entityType: fieldParent?.name,
            fieldName: fieldNode.name,
            methodName: methodNode.name,
            detail: fieldParent
              ? `${fieldParent.name}.${fieldNode.name} 字段`
              : `字段 ${fieldNode.name}`,
          }
        }

        // Trace where this field is assigned
        const assignEdges = allEdges.filter(e =>
          e.kind === 'references' && e.targetId === fieldNode.id
        )
        for (const ae of assignEdges) {
          const assigner = queries.getNode(ae.sourceId)
          if (!assigner) continue
          const assignerChildren = allNodes.filter(n => n.parentId === assigner.id)
          const literals = assignerChildren.filter(n =>
            n.kind === 'literal' || n.kind === 'string_literal'
          )
          for (const lit of literals) {
            const val = lit.name.replace(/['"]/g, '')
            possibleKeys.push(val)
            steps.push({
              kind: 'field',
              description: `field ${fieldNode.name} = "${val}" in ${assigner.name}`,
              nodeId: lit.id,
            })
          }
        }
      }
    }
  }

  const uniqueKeys = [...new Set(possibleKeys)]

  // If no literal keys found but we have a data source, still return useful info
  if (uniqueKeys.length === 0 && !dataSource) return null

  return {
    variableName: varName,
    possibleKeys: uniqueKeys,
    methodName: methodNode.name,
    steps,
    dataSource,
  }
}

/**
 * Trace all possible return values from a method body.
 * Also detects data sources within the method body.
 */
function traceVariableValueOfMethod(
  methodId: string,
  queries: QueryManager,
  depth: number,
  visitedMethods: Set<string>,
): TracedVariable | null {
  if (depth > 3 || visitedMethods.has(methodId)) return null

  const methodNode = queries.getNode(methodId)
  if (!methodNode) return null

  const allNodes = queries.getAllNodes()
  const allEdges = queries.getAllEdges()
  const children = allNodes.filter(n => n.parentId === methodId)

  const possibleKeys: string[] = []
  const steps: TraceStep[] = []

  const returnNodes = children.filter(n => n.kind === 'return_statement' || n.kind === 'return')
  for (const ret of returnNodes) {
    const returnRefs = allEdges.filter(e => e.sourceId === ret.id && (e.kind === 'references' || e.kind === 'returns'))
    for (const rr of returnRefs) {
      const target = queries.getNode(rr.targetId)
      if (!target) continue
      if (target.kind === 'literal' || target.kind === 'string_literal') {
        const val = target.name.replace(/['"]/g, '')
        possibleKeys.push(val)
        steps.push({ kind: 'literal', description: `return "${val}"`, nodeId: target.id })
      }
    }
  }

  const ifNodes = children.filter(n => n.kind === 'if' || n.kind === 'ternary')
  for (const ifn of ifNodes) {
    const branchChildren = allNodes.filter(n => n.parentId === ifn.id)
    const literalChildren = branchChildren.filter(n =>
      n.kind === 'literal' || n.kind === 'string_literal'
    )
    for (const lit of literalChildren) {
      const val = lit.name.replace(/['"]/g, '')
      possibleKeys.push(val)
      steps.push({ kind: 'literal', description: `branch literal "${val}"`, nodeId: lit.id })
    }
  }

  if (possibleKeys.length === 0) return null

  return {
    variableName: methodNode.name,
    possibleKeys: [...new Set(possibleKeys)],
    methodName: methodNode.name,
    steps,
  }
}
