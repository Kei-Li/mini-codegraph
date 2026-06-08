import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { QueryManager } from '../../db/queries.js'

export interface ProtoService {
  name: string
  rpcMethods: { name: string; inputType: string; outputType: string; clientStream: boolean; serverStream: boolean }[]
  filePath: string
  package: string
}

export interface ProtoMessage {
  name: string
  fields: { name: string; type: string; number: number; repeated: boolean }[]
  filePath: string
  package: string
}

export function parseProtoFile(filePath: string): { services: ProtoService[]; messages: ProtoMessage[] } {
  const content = readFileSync(filePath, 'utf-8')
  const services: ProtoService[] = []
  const messages: ProtoMessage[] = []

  const packageMatch = content.match(/^\s*package\s+([\w.]+)\s*;/m)
  const pkg = packageMatch?.[1] ?? ''

  const serviceRegex = /service\s+(\w+)\s*\{([^}]*)\}/g
  const messageRegex = /message\s+(\w+)\s*\{([^}]*)\}/g

  let sm: RegExpExecArray | null
  while ((sm = serviceRegex.exec(content)) !== null) {
    const svcName = sm[1]
    const svcBody = sm[2]
    const methods: { name: string; inputType: string; outputType: string; clientStream: boolean; serverStream: boolean }[] = []

      const rpcRegex = /rpc\s+(\w+)\s*\(\s*(stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(stream\s+)?(\w+)\s*\)/g
    let rm: RegExpExecArray | null
    while ((rm = rpcRegex.exec(svcBody)) !== null) {
      methods.push({
        name: rm[1],
        inputType: rm[3],
        outputType: rm[5],
        clientStream: !!rm[2],
        serverStream: !!rm[4],
      })
    }

    services.push({ name: svcName, rpcMethods: methods, filePath, package: pkg })
  }

  let mm: RegExpExecArray | null
  while ((mm = messageRegex.exec(content)) !== null) {
    const msgName = mm[1]
    const msgBody = mm[2]
    const fields: { name: string; type: string; number: number; repeated: boolean }[] = []

    const fieldRegex = /(?:repeated\s+)?(\w+(?:\.\w+)*)\s+(\w+)\s*=\s*(\d+)/g
    let fm: RegExpExecArray | null
    while ((fm = fieldRegex.exec(msgBody)) !== null) {
      const repeated = msgBody.substring(fm.index - 20, fm.index).includes('repeated')
      fields.push({ name: fm[2], type: repeated ? `repeated ${fm[1]}` : fm[1], number: parseInt(fm[3]), repeated })
    }

    messages.push({ name: msgName, fields, filePath, package: pkg })
  }

  return { services, messages }
}

export function indexGrpcProtoFiles(
  queries: QueryManager,
  rootPath: string,
  protoDir: string,
  moduleId: string
): { services: ProtoService[]; messages: ProtoMessage[] } {
  const allServices: ProtoService[] = []
  const allMessages: ProtoMessage[] = []

  if (!existsSync(protoDir)) return { services: [], messages: [] }

  const entries = readdirRecursive(protoDir)
  const protoFiles = entries.filter(f => f.endsWith('.proto'))

  for (const pf of protoFiles) {
    try {
      const { services, messages } = parseProtoFile(join(protoDir, pf))
      const relPath = relative(rootPath, join(protoDir, pf)).replace(/\\/g, '/')

      for (const svc of services) {
        const svcId = `grpc:${relPath}:${svc.name}`

        queries.insertNode({
          id: svcId,
          kind: 'interface',
          name: svc.name,
          qualifiedName: `${svc.package}.${svc.name}`,
          filePath: relPath,
          language: 'protobuf',
          startLine: 1, endLine: 1,
          startColumn: 0, endColumn: 0,
          docstring: `gRPC service from ${relPath}`,
          signature: `service ${svc.name} { ${svc.rpcMethods.length} RPC methods }`,
          visibility: 'public',
          isExported: true,
          parentId: null,
          moduleId,
        })

        for (const method of svc.rpcMethods) {
          const methodId = `grpc:${relPath}:${svc.name}:${method.name}`
          queries.insertNode({
            id: methodId,
            kind: 'method',
            name: method.name,
            qualifiedName: `${svc.package}.${svc.name}.${method.name}`,
            filePath: relPath,
            language: 'protobuf',
            startLine: 1, endLine: 1,
            startColumn: 0, endColumn: 0,
            docstring: `gRPC method ${method.name}`,
            signature: `rpc ${method.name}(${method.clientStream ? 'stream ' : ''}${method.inputType}) returns (${method.serverStream ? 'stream ' : ''}${method.outputType})`,
            visibility: 'public',
            isExported: true,
            parentId: svcId,
            moduleId,
          })
          queries.insertEdge(svcId, methodId, 'contains', '{}', 0, 0)
        }

        const javaStubName = `${svc.name}Grpc`
        const stubNodes = queries.searchNodes(javaStubName, 10)
        for (const stub of stubNodes) {
          if (stub.moduleId === moduleId && (stub.kind === 'class' || stub.kind === 'interface')) {
            queries.insertEdge(svcId, stub.id, 'grpc_stub', JSON.stringify({ protoService: svc.name, stubClass: stub.name }), 0, 0)
            queries.insertEdge(stub.id, svcId, 'grpc_implements', JSON.stringify({ protoService: svc.name, stubClass: stub.name }), 0, 0)

            const stubMethods = queries.getChildren(stub.id)
            for (const sm of stubMethods) {
              const matchingMethod = svc.rpcMethods.find(m =>
                m.name.toLowerCase() === sm.name.toLowerCase() ||
                m.name.toLowerCase() === sm.name.replace(/^(get|call)/, '').toLowerCase()
              )
              if (matchingMethod) {
                const protoMethodId = `grpc:${relPath}:${svc.name}:${matchingMethod.name}`
                queries.insertEdge(sm.id, protoMethodId, 'grpc_call', JSON.stringify({ rpcMethod: matchingMethod.name }), 0, 0)
              }
            }
          }
        }

        allServices.push(svc)
      }

      for (const msg of messages) {
        const msgId = `grpc:msg:${relPath}:${msg.name}`
        queries.insertNode({
          id: msgId,
          kind: 'type_alias',
          name: msg.name,
          qualifiedName: `${msg.package}.${msg.name}`,
          filePath: relPath,
          language: 'protobuf',
          startLine: 1, endLine: 1,
          startColumn: 0, endColumn: 0,
          docstring: `Protobuf message from ${relPath}`,
          signature: `message ${msg.name} { ${msg.fields.length} fields }`,
          visibility: 'public',
          isExported: true,
          parentId: null,
          moduleId,
        })

        for (const svc of services) {
          for (const rpc of svc.rpcMethods) {
            if (rpc.inputType === msg.name || rpc.outputType === msg.name) {
              queries.insertEdge(msgId, `grpc:${relPath}:${svc.name}:${rpc.name}`, 'grpc_message',
                JSON.stringify({ direction: rpc.inputType === msg.name ? 'input' : 'output', rpcMethod: rpc.name }), 0, 0)
            }
          }
        }
      }

      allMessages.push(...messages)
    } catch { /* silent */ }
  }

  return { services: allServices, messages: allMessages }
}

function readdirRecursive(dir: string): string[] {
  const result: string[] = []
  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          result.push(...readdirRecursive(fullPath))
        } else {
          result.push(fullPath)
        }
      } catch { /* silent */ }
    }
  } catch { /* silent */ }
  return result
}

export function findProtoDir(projectRoot: string): string | null {
  const candidates = [
    join(projectRoot, 'src', 'main', 'proto'),
    join(projectRoot, 'src', 'main', 'protobuf'),
    join(projectRoot, 'proto'),
    join(projectRoot, 'protobuf'),
    join(projectRoot, 'src', 'main', 'resources', 'proto'),
  ]

  for (const c of candidates) {
    if (existsSync(c)) return c
  }

  if (existsSync(join(projectRoot, 'pom.xml'))) {
    try {
      const pom = readFileSync(join(projectRoot, 'pom.xml'), 'utf-8')
      const protoDirMatch = pom.match(/<protoSourceDir>([^<]+)<\/protoSourceDir>/)
      if (protoDirMatch) {
        const customDir = join(projectRoot, protoDirMatch[1].trim())
        if (existsSync(customDir)) return customDir
      }
    } catch { /* silent */ }
  }

  return null
}
