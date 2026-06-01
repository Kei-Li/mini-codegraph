export interface ShimmerMessage {
  type: 'progress' | 'complete' | 'error'
  phase?: string
  percent?: number
  message?: string
}

export interface GlyphSet {
  rail: string
  bar: string
  pointer: string
}
