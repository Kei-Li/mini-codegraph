import { parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { GrammarLoader } from './grammar-loader.js'
import { parseJavaFile } from './languages/java.js'
import { parseTypeScriptFile } from './languages/typescript.js'
import { parsePythonFile } from './languages/python.js'
import { parseVueFile } from './languages/vue.js'
import { languageForFile } from '../utils.js'
import type { NodeInfo, EdgeInfo } from './languages/java.js'

const grammarLoader = new GrammarLoader()
let grammarInitialized = false

interface ParseRequest {
  type: 'parse'
  id: number
  filePath: string
  content: string
  grammarName: string
  language: string
}

interface InitRequest {
  type: 'init'
}

interface ShutdownRequest {
  type: 'shutdown'
}

type WorkerMessage = ParseRequest | InitRequest | ShutdownRequest

let parseCount = 0
const PARSER_RESET_INTERVAL = 250

parentPort?.on('message', async (msg: WorkerMessage) => {
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

    if (parseCount > 0 && parseCount % PARSER_RESET_INTERVAL === 0) {
      grammarLoader.resetParser?.(msg.grammarName)
    }

    try {
      const parser = await grammarLoader.loadGrammar(msg.grammarName)
      const tree = parser.parse(msg.content)

      if (!tree || !tree.rootNode) {
        parentPort?.postMessage({
          type: 'parse-result',
          id: msg.id,
          error: 'Failed to parse',
        })
        return
      }

      const parseResult = msg.language === 'java'
        ? parseJavaFile(tree, msg.content, msg.filePath, msg.language)
        : msg.language === 'python'
          ? parsePythonFile(tree, msg.content, msg.filePath, msg.language)
          : msg.language === 'vue'
            ? parseVueFile(parser, msg.content, msg.filePath, msg.language)
            : parseTypeScriptFile(tree, msg.content, msg.filePath, msg.language)

      parseCount++

      parentPort?.postMessage({
        type: 'parse-result',
        id: msg.id,
        result: parseResult,
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
