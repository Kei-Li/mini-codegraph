import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'

interface MigrationFile {
  path: string
  version: string
  description: string
  type: 'flyway' | 'liquibase'
}

export class DatabaseMigrationExtractor implements IExtractor {
  name = 'database-migration'

  async extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    const migrations = this.scanMigrations(projectRoot)
    for (const m of migrations) {
      provides.push({
        id: `db.migration.${m.type}.${m.version}`,
        name: m.description || m.version,
        kind: 'db_migration',
        signature: `${m.type}:${m.version} ${m.description}`,
      })
    }

    return { provides, consumes }
  }

  private scanMigrations(projectRoot: string): MigrationFile[] {
    const migrations: MigrationFile[] = []

    for (const dir of this.findMigrationDirs(projectRoot)) {
      try {
        const entries = readdirSync(dir)
        for (const e of entries) {
          const full = join(dir, e)
          if (!statSync(full).isFile()) continue
          if (e.endsWith('.sql') || e.endsWith('.xml') || e.endsWith('.yaml') || e.endsWith('.yml')) {
            const migration = this.parseMigrationFile(e)
            if (migration) {
              migration.path = full
              migrations.push(migration)
            }
          }
        }
      } catch { /* silent */ }
    }

    return migrations
  }

  private findMigrationDirs(projectRoot: string): string[] {
    const dirs: string[] = []
    const candidates = [
      // Flyway
      join('src', 'main', 'resources', 'db', 'migration'),
      // Liquibase
      join('src', 'main', 'resources', 'db', 'changelog'),
      // Alternative common paths
      join('db', 'migration'),
      join('db', 'changelog'),
    ]
    for (const c of candidates) {
      const full = join(projectRoot, c)
      if (existsSync(full)) dirs.push(full)
    }
    return dirs
  }

  private parseMigrationFile(filename: string): MigrationFile | null {
    const flywayMatch = filename.match(/^V(\d+(?:_\d+)*)__(.+)\.(sql|csv)$/)
    if (flywayMatch) {
      return {
        path: '',
        version: flywayMatch[1].replace(/_/g, '.'),
        description: flywayMatch[2].replace(/_/g, ' '),
        type: 'flyway',
      }
    }

    const liquibaseMatch = filename.match(/^(\d{14})[_\-](.+)\.(sql|xml|yaml|yml)$/)
    if (liquibaseMatch) {
      return {
        path: '',
        version: liquibaseMatch[1],
        description: liquibaseMatch[2].replace(/[_\-]/g, ' '),
        type: 'liquibase',
      }
    }

    return null
  }
}
