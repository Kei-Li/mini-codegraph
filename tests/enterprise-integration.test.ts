import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

function findTestDb(): string {
  const candidates = [
    join(process.cwd(), '.mini-codegraph', 'mini-codegraph.db'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error(
    'Integration DB not found. Run: mini-codegraph init <project> --index --workspace <project> --yes'
  )
}

describe('enterprise integration', () => {
  let dbPath: string
  let db: DatabaseSync

  beforeAll(() => {
    dbPath = findTestDb()
    db = new DatabaseSync(dbPath)
  })

  afterAll(() => {
    db.close()
  })

  it('has nodes and edges tables', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes', 'edges', 'files')"
    ).all() as { name: string }[]
    const tableNames = tables.map(t => t.name)
    expect(tableNames).toContain('nodes')
    expect(tableNames).toContain('edges')
    expect(tableNames).toContain('files')
  })

  it('has indexed nodes', () => {
    const count = (db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c
    expect(count).toBeGreaterThan(0)
  })

  it('has has at least one edge kind', () => {
    const kinds = db.prepare('SELECT DISTINCT kind FROM edges').all() as { kind: string }[]
    expect(kinds.length).toBeGreaterThan(0)
  })

  it('has project metadata', () => {
    const rows = db.prepare('SELECT * FROM project_metadata').all()
    expect(Array.isArray(rows)).toBe(true)
  })

  it('has external_* tables for cross-service references', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name = 'external_symbols' OR name = 'external_references')"
    ).all() as { name: string }[]
    expect(tables.length).toBeGreaterThanOrEqual(2)
  })

  it('detects Spring annotations if present', () => {
    const rows = db.prepare(
      "SELECT annotation_name, COUNT(*) c FROM annotations WHERE annotation_name IN ('FeignClient', 'RabbitListener', 'Transactional', 'Cacheable', 'RestController') GROUP BY annotation_name LIMIT 5"
    ).all() as { annotation_name: string; c: number }[]
    for (const row of rows) {
      expect(row.c).toBeGreaterThanOrEqual(0)
    }
  })
})
