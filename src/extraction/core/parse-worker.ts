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

const grammarLoader = new GrammarLoader()
let grammarInitialized = false

const parseCounts = new Map<string, number>()
const PARSER_RESET_INTERVAL = 5000
const HEARTBEAT_INTERVAL = 5000

setInterval(() => parentPort?.postMessage({ type: 'heartbeat' }), HEARTBEAT_INTERVAL)

parentPort?.on('message', async (msg: WorkerRequest) => {
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
      const source = readFileSync(msg.absolutePath, 'utf-8')
      const stat = statSync(msg.absolutePath)
      const contentHash = computeContentHash(source)

      if (source.length > 5_242_880) {
        logWarn(`File exceeds size limit: ${msg.absolutePath} (${(source.length / 1024 / 1024).toFixed(1)}MB, limit 5MB)`)
        parentPort?.postMessage({
          type: 'parse-result',
          id: msg.id,
          error: `File exceeds 5MB size limit (${(source.length / 1024 / 1024).toFixed(1)}MB)`,
        })
        return
      }

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
        stat: { size: stat.size, mtimeMs: stat.mtimeMs },
      })
    } catch (e) {
      parentPort?.postMessage({
        type: 'parse-result',
        id: msg.id,
        error: String(e),
        fatal: String(e).includes('memory access out of bounds') || String(e).includes('out of memory'),
      })

      if (String(e).includes('memory access out of bounds') || String(e).includes('out of memory')) {
        process.exit(1)
      }
    }
  }
})
