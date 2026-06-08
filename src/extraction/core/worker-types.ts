import type { NodeInfo, EdgeInfo } from '../languages/java.js'

export interface WorkerParseRequest {
  type: 'parse'
  id: number
  filePath: string
  absolutePath: string
  grammarName: string
  language: string
}

export interface WorkerHeartbeatRequest {
  type: 'heartbeat'
}

export interface WorkerInitRequest {
  type: 'init'
}

export interface WorkerShutdownRequest {
  type: 'shutdown'
}

export type WorkerRequest = WorkerParseRequest | WorkerHeartbeatRequest | WorkerInitRequest | WorkerShutdownRequest

export interface WorkerFileStat {
  size: number
  mtimeMs: number
}

export interface WorkerParseResult {
  nodes: NodeInfo[]
  edges: EdgeInfo[]
}

export interface WorkerParseResponse {
  type: 'parse-result'
  id: number
  result?: WorkerParseResult
  contentHash?: string
  stat?: WorkerFileStat
  error?: string
  fatal?: boolean
}

export interface WorkerInitResponse {
  type: 'init-complete' | 'init-error'
  error?: string
}

export interface WorkerHeartbeatResponse {
  type: 'heartbeat'
}

export type WorkerResponse = WorkerParseResponse | WorkerInitResponse | WorkerHeartbeatResponse
