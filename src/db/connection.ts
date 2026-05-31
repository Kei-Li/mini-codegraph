import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SCHEMA_SQL } from './schema.js'

export class DatabaseConnection {
  private db: DatabaseSync | null = null
  private dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  open(): void {
    if (this.db) return

    const dir = dirname(this.dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.exec('PRAGMA cache_size=-65536')
    this.db.exec('PRAGMA mmap_size=268435456')
    this.db.exec(SCHEMA_SQL)
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  get connection(): DatabaseSync {
    if (!this.db) throw new Error('Database not opened. Call open() first.')
    return this.db
  }

  exec(sql: string): void {
    this.connection.exec(sql)
  }

  prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
    return this.connection.prepare(sql)
  }

  transaction<T>(fn: () => T): T {
    const tx = this.connection.prepare('BEGIN')
    tx.run()
    try {
      const result = fn()
      this.connection.prepare('COMMIT').run()
      return result
    } catch (e) {
      this.connection.prepare('ROLLBACK').run()
      throw e
    }
  }
}
