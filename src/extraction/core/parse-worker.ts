import { parentPort } from 'node:worker_threads'
import { readFileSync, statSync } from 'node:fs'
import { GrammarLoader } from './grammar-loader.js'
import { parseJavaFile } from '../languages/java.js'
import { parseTypeScriptFile } from '../languages/typescript.js'
import { parsePythonFile } from '../languages/python.js'
import { parseVueFile } from '../languages/vue.js'
import { parseKotlinFile } from '../languages/kotlin.js'
import { computeContentHash } from '../../utils.js'
import { logWarn } from '../../logger.js'
import type { WorkerRequest } from './worker-types.js'

process.on('uncaughtException', (err) => {
  parentPort?.postMessage({ type: 'worker-error', error: `UNCAUGHT: ${err.message}\n${err.stack}` })
})
process.on('unhandledRejection', (err) => {
  parentPort?.postMessage({ type: 'worker-error', error: `UNHANDLED: ${err}` })
})
process.on('exit', (code) => {
  // Synchronous write because async postMessage may not work during exit
  try { process.stderr.write(`[worker-exit] code=${code}\n`) } catch { /* best-effort */ }
})

const grammarLoader = new GrammarLoader()
let grammarInitialized = false

const parseCounts = new Map<string, number>()
const PARSER_RESET_INTERVAL = 500

setInterval(() => parentPort?.postMessage({ type: 'heartbeat' }), 5_000)

let processing = false
const pendingQueue: WorkerRequest[] = []

function processNext(): void {
  if (processing || pendingQueue.length === 0) return
  processing = true
  const msg = pendingQueue.shift()!
  handleMessage(msg).finally(() => {
    processing = false
    processNext()
  })
}

parentPort?.on('message', (msg: WorkerRequest) => {
  pendingQueue.push(msg)
  processNext()
})

async function handleMessage(msg: WorkerRequest): Promise<void> {
  if (msg.type === 'init') {
    try {
      await grammarLoader.init()
      grammarInitialized = true
      parentPort?.postMessage({ type: 'init-complete' })
    } catch (e) {
      parentPort?.postMessage({ type: 'init-error', error: String(e) })
    }
    return
  }

  if (msg.type === 'shutdown') {
    process.exit(0)
  }

  if (msg.type === 'parse') {
    if (!grammarInitialized) {
      parentPort?.postMessage({
        type: 'parse-result',
        id: msg.id,
        error: 'Grammar not initialized',
      })
      return
    }

    const count = (parseCounts.get(msg.grammarName) ?? 0) + 1
    parseCounts.set(msg.grammarName, count)
    if (count % PARSER_RESET_INTERVAL === 0) {
      grammarLoader.resetParser?.(msg.grammarName)
    }

    try {
      const stat = statSync(msg.absolutePath)
      const fileSizeMB = stat.size / 1024 / 1024
      if (stat.size > 10_485_760) {
        logWarn(`File exceeds size limit: ${msg.absolutePath} (${fileSizeMB.toFixed(1)}MB, limit 10MB)`)
        parentPort?.postMessage({
          type: 'parse-result',
          id: msg.id,
          error: `File exceeds 10MB size limit (${fileSizeMB.toFixed(1)}MB)`,
        })
        return
      }

      const source = readFileSync(msg.absolutePath, 'utf-8')
      const contentHash = computeContentHash(source)

      const parser = await grammarLoader.loadGrammar(msg.grammarName)
      const tree = parser.parse(source)

      if (!tree || !tree.rootNode) {
        parentPort?.postMessage({
          type: 'parse-result',
          id: msg.id,
          error: 'Failed to parse',
        })
        return
      }

      const parseResult = msg.language === 'java'
        ? parseJavaFile(tree, source, msg.filePath, msg.language)
        : msg.language === 'python'
          ? parsePythonFile(tree, source, msg.filePath, msg.language)
          : msg.language === 'vue'
            ? parseVueFile(parser, source, msg.filePath, msg.language)
            : msg.language === 'kotlin'
              ? parseKotlinFile(source, msg.filePath, parser, { language: 'kotlin', languageName: 'kotlin', namespaceDelimiter: '.', supportFullText: true })
              : parseTypeScriptFile(tree, source, msg.filePath, msg.language)

      parentPort?.postMessage({
        type: 'parse-result',
        id: msg.id,
        result: parseResult,
        contentHash,
        source,
        stat: { size: stat.size, mtimeMs: stat.mtimeMs },
      })
    } catch (e) {
      const isMemoryError = String(e).includes('memory access out of bounds') || String(e).includes('out of memory')
      parentPort?.postMessage({
        type: 'parse-result',
        id: msg.id,
        error: String(e),
        fatal: isMemoryError,
      })

      if (isMemoryError) {
        grammarLoader.resetParser(msg.grammarName)
      }
    }
  }
}
