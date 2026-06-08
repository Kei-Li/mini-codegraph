import type { ToolDefinition } from './shared.js'

export function createFrameworkTools(): ToolDefinition[] {
  return [
    {
      name: 'mini_cg_architecture',
      description: 'Show microservice topology and entry points',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async (_args, graph) => {
        const arch = graph.findMicroserviceArchitecture()
        return {
          modules: arch.modules.slice(0, 50),
          dependencies: arch.dependencies.slice(0, 100).map(d => `${d.from} → ${d.to}`),
          entryPoints: arch.entryPoints.slice(0, 50).map(ep => ({
            module: ep.module,
            endpoints: ep.endpoints,
          })),
          totalModules: arch.modules.length,
          totalDependencies: arch.dependencies.length,
          truncated: arch.modules.length > 50 || arch.dependencies.length > 100,
        }
      },
    },
    {
      name: 'mini_cg_feign',
      description: 'List FeignClient interfaces and their targets',
      inputSchema: {
        type: 'object',
        properties: {
          includeMethods: { type: 'boolean', description: 'Include method details (default: true)' },
          limit: { type: 'number', description: 'Max results (default: 50, max: 500)' },
        },
      },
      handler: async (args, graph) => {
        const { includeMethods = true, limit: rawLimit } = args
        const all = graph.getFeignClients(rawLimit)
        const safeLimit = Math.min(Math.max(1, rawLimit ?? 50), 500)
        const items = all.slice(0, safeLimit)
        return {
          clients: items.map(c => ({
            name: c.feignClient.name, filePath: c.feignClient.filePath,
            annotations: c.annotations.map(a => `${a.annotationName}(${a.value})`),
            methods: includeMethods ? c.feignMethods.map(m => ({
              name: m.name, signature: m.signature, line: m.startLine,
            })) : undefined,
          })),
          total: all.length, truncated: all.length > safeLimit,
        }
      },
    },
    {
      name: 'mini_cg_mybatis',
      description: 'List MyBatis mapper-to-SQL bindings',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (default: 50, max: 500)' },
        },
      },
      handler: async (args, graph) => {
        const { limit: rawLimit } = args
        const all = graph.getMyBatisMappings(rawLimit)
        const safeLimit = Math.min(Math.max(1, rawLimit ?? 50), 500)
        const items = all.slice(0, safeLimit)
        return {
          mappings: items.map(m => ({
            javaInterface: m.javaInterface, method: m.methodName,
            xmlFile: m.xmlPath, sqlId: m.sqlId,
          })),
          total: all.length, truncated: all.length > safeLimit,
        }
      },
    },
    {
      name: 'mini_cg_page_trace',
      description: 'Trace Vue page component to all API call chains',
      inputSchema: {
        type: 'object',
        properties: {
          pageFile: { type: 'string', description: 'Vue page component file path' },
          routePath: { type: 'string', description: 'Vue Router path (alternative to pageFile)' },
          maxDepth: { type: 'number', description: 'Component tree depth (default: 3)' },
        },
      },
      handler: async (args, graph) => {
        const { pageFile, routePath } = args
        if (!pageFile && !routePath) return { error: 'Either pageFile or routePath is required' }
        let result
        if (pageFile) {
          result = graph.getPageFanoutTraces(pageFile)
        } else {
          result = graph.getPageFanoutByRoute(routePath)
        }
        if (!result) return { error: `No fan-out trace found for ${pageFile ?? routePath}`, branches: [] }
        return {
          routePath: result.routePath,
          routeName: result.routeName,
          pageFile: result.pageFile,
          involvedServices: result.involvedServices,
          totalBranches: result.branches.length,
          branches: result.branches.map((b) => ({
            method: b.method,
            path: b.path,
            sourceComponent: b.sourceComponent,
            hops: b.trace.map((h) => ({
              kind: h.kind, name: h.name, moduleId: h.moduleId, filePath: h.filePath, detail: h.detail,
            })),
          })),
        }
      },
    },
    {
      name: 'mini_cg_service_trace',
      description: 'Trace a service: entry points, internal chains, cross-service calls',
      inputSchema: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Service/module name (e.g. order-service)' },
          includeExternal: { type: 'boolean', description: 'Include cross-service calls (default: true)' },
          maxEntryPoints: { type: 'number', description: 'Max entry points to return (default: 50)' },
        },
        required: ['service'],
      },
      handler: async (args, graph) => {
        const { service, includeExternal = true, maxEntryPoints = 50 } = args
        if (!service) return { error: 'service is required' }
        return graph.getServiceTrace(service, includeExternal, maxEntryPoints)
      },
    },
    {
      name: 'mini_cg_dispatch',
      description: 'Find dispatch/inference targets for a given interface or base class. Traces strategy pattern, AOP, factory method, and reflective dispatch.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Interface or base class name' },
        },
        required: ['symbol'],
      },
      handler: async () => {
        return { supported: true, note: 'Use mini_cg_callers and mini_cg_callees for direct call chain analysis' }
      },
    },
  ]
}
