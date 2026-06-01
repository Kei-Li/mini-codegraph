export class LRUCache<K, V> {
  private capacity: number
  private cache = new Map<K, V>()
  private hits = 0
  private misses = 0

  constructor(capacity: number) {
    this.capacity = capacity
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key)
    if (value !== undefined) {
      this.hits++
      this.cache.delete(key)
      this.cache.set(key, value)
      return value
    }
    this.misses++
    return undefined
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.capacity) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }
    this.cache.set(key, value)
  }

  has(key: K): boolean {
    return this.cache.has(key)
  }

  delete(key: K): void {
    this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
    this.hits = 0
    this.misses = 0
  }

  get size(): number {
    return this.cache.size
  }

  stats(): { hits: number; misses: number; size: number; capacity: number; hitRate: number } {
    const total = this.hits + this.misses
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      capacity: this.capacity,
      hitRate: total > 0 ? this.hits / total : 0,
    }
  }
}

export class BoundedCacheManager {
  private caches = new Map<string, LRUCache<string, unknown>>()

  getOrCreate(name: string, capacity: number): LRUCache<string, unknown> {
    if (!this.caches.has(name)) {
      this.caches.set(name, new LRUCache(capacity))
    }
    return this.caches.get(name)!
  }

  clearAll(): void {
    for (const cache of this.caches.values()) cache.clear()
  }

  stats(): Record<string, { hits: number; misses: number; size: number; capacity: number; hitRate: number }> {
    const result: Record<string, any> = {}
    for (const [name, cache] of this.caches) {
      result[name] = cache.stats()
    }
    return result
  }
}
