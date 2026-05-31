import type { Transport } from './types.js'

export type MessageHandler = (msg: any) => void
export type CloseHandler = () => void

export class StdioTransport implements Transport {
  private buffer = ''
  private onMessage: MessageHandler | null = null
  private onClose: CloseHandler | null = null

  start(onMessage: MessageHandler, onClose: CloseHandler): void {
    this.onMessage = onMessage
    this.onClose = onClose

    process.stdin.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()

      let newlineIdx: number
      while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim()
        this.buffer = this.buffer.slice(newlineIdx + 1)

        if (!line) continue

        try {
          const msg = JSON.parse(line)
          if (this.onMessage) this.onMessage(msg)
        } catch {
          // Ignore malformed messages
        }
      }
    })

    process.stdin.on('end', () => {
      if (this.onClose) this.onClose()
    })

    process.stdin.on('error', () => {
      if (this.onClose) this.onClose()
    })
  }

  send(response: any): void {
    const json = JSON.stringify(response)
    process.stdout.write(json + '\n')
  }

  stop(): void {
    // stdin/stdout are managed by the process lifecycle
  }
}
