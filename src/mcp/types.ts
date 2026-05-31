export interface Transport {
  start(onMessage: (msg: any) => void, onClose: () => void): void
  send(response: any): void
  stop(): void
}
