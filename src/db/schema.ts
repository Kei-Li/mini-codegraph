export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  language TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL DEFAULT 0,
  end_column INTEGER NOT NULL DEFAULT 0,
  docstring TEXT DEFAULT '',
  signature TEXT DEFAULT '',
  visibility TEXT DEFAULT 'public',
  is_exported INTEGER DEFAULT 0,
  parent_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);

CREATE TABLE IF NOT EXISTS edges (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  line INTEGER DEFAULT 0,
  col INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (source, target, kind)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  modified_at INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0,
  node_count INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name,
  qualified_name,
  docstring,
  signature,
  content='nodes',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, qualified_name, docstring, signature)
  VALUES (new.rowid, new.name, new.qualified_name, new.docstring, new.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, docstring, signature)
  VALUES ('delete', old.rowid, old.name, old.qualified_name, old.docstring, old.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, docstring, signature)
  VALUES ('delete', old.rowid, old.name, old.qualified_name, old.docstring, old.signature);
  INSERT INTO nodes_fts(rowid, name, qualified_name, docstring, signature)
  VALUES (new.rowid, new.name, new.qualified_name, new.docstring, new.signature);
END;

CREATE TABLE IF NOT EXISTS project_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO project_metadata (key, value) VALUES ('version', '1');
INSERT OR IGNORE INTO project_metadata (key, value) VALUES ('created_at', datetime('now'));
`

export const DELETE_FILE_NODES = `DELETE FROM nodes WHERE file_path = ?`
export const DELETE_FILE_EDGES = `
  DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)
  OR target IN (SELECT id FROM nodes WHERE file_path = ?)
`
export const DELETE_FILE_RECORD = `DELETE FROM files WHERE path = ?`
export const UPSERT_FILE = `
  INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET
    content_hash = excluded.content_hash,
    size = excluded.size,
    modified_at = excluded.modified_at,
    indexed_at = excluded.indexed_at,
    node_count = excluded.node_count
`
export const INSERT_NODE = `
  INSERT OR REPLACE INTO nodes
    (id, kind, name, qualified_name, file_path, language, start_line, end_line,
     start_column, end_column, docstring, signature, visibility, is_exported, parent_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`
export const INSERT_EDGE = `
  INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col)
  VALUES (?, ?, ?, ?, ?, ?)
`
export const GET_FILE = `SELECT * FROM files WHERE path = ?`
export const GET_ALL_FILES = `SELECT * FROM files`
export const SEARCH_NODES = `
  SELECT n.* FROM nodes n
  INNER JOIN nodes_fts f ON n.rowid = f.rowid
  WHERE nodes_fts MATCH ?
  ORDER BY rank
  LIMIT ?
`
export const GET_NODE_BY_ID = `SELECT * FROM nodes WHERE id = ?`
export const GET_NODES_BY_FILE = `SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line`
export const GET_CALLERS = `
  SELECT DISTINCT n.* FROM nodes n
  INNER JOIN edges e ON e.source = n.id
  WHERE e.target = ? AND e.kind = 'calls'
`
export const GET_CALLEES = `
  SELECT DISTINCT n.* FROM nodes n
  INNER JOIN edges e ON e.target = n.id
  WHERE e.source = ? AND e.kind = 'calls'
`
export const GET_CHILDREN = `
  SELECT * FROM nodes WHERE parent_id = ? ORDER BY start_line
`
export const GET_PARENT = `SELECT * FROM nodes WHERE id = ?`
export const GET_CONTAINS_EDGES = `
  SELECT * FROM edges WHERE source = ? AND kind = 'contains'
`
export const GET_FILE_DEPENDENCIES = `
  SELECT DISTINCT n.file_path FROM nodes n
  INNER JOIN edges e ON e.target = n.id
  WHERE e.source = ? AND e.kind = 'imports'
`
export const COUNT_NODES = `SELECT COUNT(*) as count FROM nodes`
export const COUNT_EDGES = `SELECT COUNT(*) as count FROM edges`
export const COUNT_FILES = `SELECT COUNT(*) as count FROM files`
export const GET_METADATA = `SELECT value FROM project_metadata WHERE key = ?`
export const SET_METADATA = `INSERT OR REPLACE INTO project_metadata (key, value) VALUES (?, ?)`
