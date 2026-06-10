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
  module_id TEXT DEFAULT '',
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_module ON nodes(module_id);

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
  node_count INTEGER NOT NULL DEFAULT 0,
  module_id TEXT DEFAULT ''
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

CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  build_system TEXT DEFAULT 'unknown',
  language TEXT DEFAULT 'java',
  indexed_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS unresolved_refs (
  id TEXT PRIMARY KEY,
  source_node_id TEXT NOT NULL,
  reference_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER DEFAULT 0,
  col INTEGER DEFAULT 0,
  file_path TEXT NOT NULL,
  module_id TEXT DEFAULT '',
  metadata TEXT DEFAULT '{}',
  resolved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_unresolved_refs_name ON unresolved_refs(reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_refs_file ON unresolved_refs(file_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_refs_module ON unresolved_refs(module_id);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  annotation_name TEXT NOT NULL,
  value TEXT DEFAULT '',
  line INTEGER DEFAULT 0,
  module_id TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_annotations_node ON annotations(node_id);
CREATE INDEX IF NOT EXISTS idx_annotations_name ON annotations(annotation_name);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  language TEXT NOT NULL,
  component_refs TEXT DEFAULT '[]',
  event_bindings TEXT DEFAULT '[]',
  slot_usages TEXT DEFAULT '[]',
  directives TEXT DEFAULT '[]',
  module_id TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_templates_file ON templates(file_path);

CREATE TABLE IF NOT EXISTS project_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO project_metadata (key, value) VALUES ('version', '3');
INSERT OR IGNORE INTO project_metadata (key, value) VALUES ('created_at', datetime('now'));

CREATE TABLE IF NOT EXISTS external_symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  providing_service TEXT NOT NULL,
  definition_file TEXT DEFAULT '',
  signature TEXT DEFAULT '',
  metadata JSON DEFAULT '{}',
  version INTEGER DEFAULT 0,
  changed_at TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS external_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_location TEXT NOT NULL,
  external_symbol_id TEXT NOT NULL REFERENCES external_symbols(id),
  reference_type TEXT NOT NULL,
  target_service TEXT DEFAULT '',
  source_service TEXT DEFAULT '',
  metadata JSON DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ext_ref_symbol ON external_references(external_symbol_id);
CREATE INDEX IF NOT EXISTS idx_ext_ref_location ON external_references(source_location);
CREATE INDEX IF NOT EXISTS idx_ext_ref_src_svc ON external_references(source_service);
CREATE INDEX IF NOT EXISTS idx_ext_sym_service ON external_symbols(providing_service);

CREATE TABLE IF NOT EXISTS entry_points (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  service TEXT NOT NULL,
  method TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line INTEGER DEFAULT 0,
  signature TEXT DEFAULT '',
  http_method TEXT DEFAULT '',
  path TEXT DEFAULT '',
  queue_name TEXT DEFAULT '',
  cron_expr TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entry_points_service ON entry_points(service);

/* Enterprise Java additions (ADR-013) */
CREATE TABLE IF NOT EXISTS service_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_service TEXT NOT NULL,
  target_service TEXT NOT NULL,
  dependency_type TEXT DEFAULT 'compile',
  optional INTEGER DEFAULT 0,
  detected_from TEXT DEFAULT 'pom.xml',
  module_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_svc_dep_source ON service_dependencies(source_service);
CREATE INDEX IF NOT EXISTS idx_svc_dep_target ON service_dependencies(target_service);

CREATE TABLE IF NOT EXISTS flowable_processes (
  id TEXT PRIMARY KEY,
  process_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_executable INTEGER DEFAULT 1,
  version TEXT DEFAULT '',
  target_namespace TEXT DEFAULT '',
  file_path TEXT NOT NULL,
  module_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flowable_nodes (
  id TEXT PRIMARY KEY,
  process_id TEXT NOT NULL REFERENCES flowable_processes(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  implementation TEXT DEFAULT '',
  async INTEGER DEFAULT 0,
  documentation TEXT DEFAULT '',
  module_id TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_flowable_nodes_process ON flowable_nodes(process_id);

CREATE TABLE IF NOT EXISTS flowable_flows (
  id TEXT PRIMARY KEY,
  process_id TEXT NOT NULL,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  condition_expression TEXT DEFAULT '',
  condition_language TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_flowable_flows_process ON flowable_flows(process_id);

CREATE TABLE IF NOT EXISTS drools_rules (
  id TEXT PRIMARY KEY,
  package_name TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  dialect TEXT DEFAULT 'java',
  salience INTEGER DEFAULT 0,
  activation_group TEXT DEFAULT '',
  agenda_group TEXT DEFAULT '',
  no_loop INTEGER DEFAULT 0,
  lock_on_active INTEGER DEFAULT 0,
  auto_focus INTEGER DEFAULT 0,
  duration INTEGER DEFAULT 0,
  when_condition TEXT NOT NULL,
  then_action TEXT NOT NULL,
  file_path TEXT NOT NULL,
  module_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drools_rules_module ON drools_rules(module_id);

CREATE TABLE IF NOT EXISTS drools_types (
  id TEXT PRIMARY KEY,
  package_name TEXT NOT NULL,
  type_name TEXT NOT NULL,
  fields TEXT DEFAULT '[]',
  file_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drools_queries (
  id TEXT PRIMARY KEY,
  package_name TEXT NOT NULL,
  query_name TEXT NOT NULL,
  parameters TEXT DEFAULT '[]',
  expression TEXT DEFAULT '',
  file_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drools_functions (
  id TEXT PRIMARY KEY,
  package_name TEXT NOT NULL,
  function_name TEXT NOT NULL,
  return_type TEXT DEFAULT 'void',
  parameters TEXT DEFAULT '[]',
  body TEXT DEFAULT '',
  file_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS maven_properties (
  id TEXT PRIMARY KEY,
  pom_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  resolved_value TEXT DEFAULT '',
  provenance TEXT DEFAULT 'direct'
);
CREATE INDEX IF NOT EXISTS idx_maven_props_pom ON maven_properties(pom_id);

CREATE TABLE IF NOT EXISTS maven_dependency_management (
  id TEXT PRIMARY KEY,
  pom_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  version TEXT NOT NULL,
  scope TEXT DEFAULT 'compile'
);
CREATE INDEX IF NOT EXISTS idx_maven_dep_mgmt_pom ON maven_dependency_management(pom_id);

CREATE TABLE IF NOT EXISTS enterprise_annotations (
  id TEXT PRIMARY KEY,
  framework_name TEXT NOT NULL,
  annotation_name TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  kind TEXT NOT NULL,
  description TEXT DEFAULT '',
  file_path TEXT NOT NULL,
  module_id TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ent_ann_framework ON enterprise_annotations(framework_name);
CREATE INDEX IF NOT EXISTS idx_ent_ann_module ON enterprise_annotations(module_id);

CREATE TABLE IF NOT EXISTS container_images (
  id TEXT PRIMARY KEY,
  service_name TEXT NOT NULL,
  image_name TEXT NOT NULL,
  registry_url TEXT DEFAULT '',
  base_image TEXT DEFAULT '',
  ports TEXT DEFAULT '[]',
  jvm_flags TEXT DEFAULT '',
  build_tool TEXT DEFAULT 'jib',
  file_path TEXT NOT NULL,
  module_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_container_images_service ON container_images(service_name);

CREATE TABLE IF NOT EXISTS cicd_pipelines (
  id TEXT PRIMARY KEY,
  pipeline_type TEXT NOT NULL,
  trigger_branches TEXT DEFAULT '[]',
  vm_image TEXT DEFAULT '',
  stages TEXT DEFAULT '[]',
  file_path TEXT NOT NULL,
  module_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cicd_pipelines_module ON cicd_pipelines(module_id);

/* === 0.3.0 schema: graph_nodes (cross-file graph only, no source derivatives) === */
CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  language TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}',
  module_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_file ON graph_nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind ON graph_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_name ON graph_nodes(name);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_qname ON graph_nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_module ON graph_nodes(module_id);

CREATE TABLE IF NOT EXISTS graph_edges (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  line INTEGER DEFAULT 0,
  col INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (source, target, kind)
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target);
CREATE INDEX IF NOT EXISTS idx_graph_edges_kind ON graph_edges(kind);

CREATE TABLE IF NOT EXISTS node_locations (
  file_path TEXT NOT NULL,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  modified_at INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0,
  module_id TEXT DEFAULT '',
  PRIMARY KEY (file_path, module_id)
);
CREATE INDEX IF NOT EXISTS idx_node_locations_module ON node_locations(module_id);

CREATE TABLE IF NOT EXISTS node_docs (
  node_id TEXT NOT NULL,
  docstring TEXT DEFAULT '',
  signature TEXT DEFAULT '',
  PRIMARY KEY (node_id)
);

CREATE TABLE IF NOT EXISTS dispatch_candidates (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  interface_name TEXT DEFAULT '',
  impl_name TEXT DEFAULT '',
  dispatch_type TEXT NOT NULL DEFAULT 'direct',
  confidence REAL NOT NULL DEFAULT 0.0,
  metadata TEXT DEFAULT '{}',
  file_path TEXT DEFAULT '',
  module_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dispatch_candidates_source ON dispatch_candidates(source);
CREATE INDEX IF NOT EXISTS idx_dispatch_candidates_target ON dispatch_candidates(target);
CREATE INDEX IF NOT EXISTS idx_dispatch_candidates_module ON dispatch_candidates(module_id);
`

/* === 0.3.0 graph tables === */
export const INSERT_GRAPH_NODE = `
  INSERT OR REPLACE INTO graph_nodes
    (id, kind, name, qualified_name, file_path, language,
     start_line, end_line, metadata, module_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`
export const INSERT_GRAPH_EDGE = `
  INSERT OR IGNORE INTO graph_edges (source, target, kind, metadata, line, col)
  VALUES (?, ?, ?, ?, ?, ?)
`
export const UPSERT_NODE_LOCATION = `
  INSERT OR REPLACE INTO node_locations
    (file_path, language, content_hash, size, modified_at, indexed_at, module_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`
export const UPSERT_NODE_DOC = `
  INSERT OR REPLACE INTO node_docs (node_id, docstring, signature)
  VALUES (?, ?, ?)
`
export const INSERT_DISPATCH_CANDIDATE = `
  INSERT OR IGNORE INTO dispatch_candidates
    (id, source, target, interface_name, impl_name, dispatch_type,
     confidence, metadata, file_path, module_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

export const DELETE_FILE_NODES = `DELETE FROM nodes WHERE file_path = ?`
export const DELETE_FILE_EDGES = `
  DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)
  OR target IN (SELECT id FROM nodes WHERE file_path = ?)
`
export const DELETE_FILE_RECORD = `DELETE FROM files WHERE path = ?`
export const UPSERT_FILE = `
  INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, module_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
     start_column, end_column, docstring, signature, visibility, is_exported, parent_id, module_id, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`
export const INSERT_EDGE = `
  INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col)
  VALUES (?, ?, ?, ?, ?, ?)
`
export const GET_FILE = `SELECT * FROM files WHERE path = ?`
export const GET_ALL_FILES = `SELECT * FROM files`
export const GET_FILES_BY_MODULE = `SELECT * FROM files WHERE module_id = ?`
export const SEARCH_NODES = `
  SELECT n.*, rank FROM nodes n
  INNER JOIN nodes_fts f ON n.rowid = f.rowid
  WHERE nodes_fts MATCH ?
  ORDER BY rank
  LIMIT ?
`
export const SEARCH_NODES_BY_MODULE = `
  SELECT n.*, rank FROM nodes n
  INNER JOIN nodes_fts f ON n.rowid = f.rowid
  WHERE nodes_fts MATCH ? AND n.module_id = ?
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
export const GET_IMPORTS = `
  SELECT DISTINCT n.* FROM nodes n
  INNER JOIN edges e ON e.target = n.id
  WHERE e.source = ? AND e.kind = 'imports'
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
export const GET_ALL_NODES = `SELECT * FROM nodes`
export const GET_NODES_BY_KIND = `SELECT * FROM nodes WHERE kind = ?`
export const GET_NODES_BY_QUALIFIED_NAME = `SELECT * FROM nodes WHERE qualified_name = ?`
export const GET_NODES_BY_ID_PREFIX = `SELECT * FROM nodes WHERE id LIKE ? || '%'`
export const GET_NODES_BY_ID_PREFIX_LIMIT = `SELECT * FROM nodes WHERE id LIKE ? || '%' LIMIT ?`
export const COUNT_NODES = `SELECT COUNT(*) as count FROM nodes`
export const COUNT_EDGES = `SELECT COUNT(*) as count FROM edges`
export const COUNT_FILES = `SELECT COUNT(*) as count FROM files`
export const GET_METADATA = `SELECT value FROM project_metadata WHERE key = ?`
export const SET_METADATA = `INSERT OR REPLACE INTO project_metadata (key, value) VALUES (?, ?)`
export const RESOLVE_CALL_EDGES = `
  UPDATE edges SET target = (
    SELECT id FROM nodes WHERE name = edges.target AND kind IN ('function','method','constructor') LIMIT 1
  )
  WHERE kind = 'calls'
    AND target NOT LIKE '%:%'
    AND EXISTS (SELECT 1 FROM nodes WHERE name = edges.target AND kind IN ('function','method','constructor'));

  UPDATE edges SET target = (
    SELECT id FROM nodes WHERE id LIKE '%' || edges.target || ':%' LIMIT 1
  )
  WHERE kind = 'calls'
    AND target NOT LIKE ':%'
    AND target LIKE '%:%'
    AND target NOT LIKE '%:%:%'
    AND EXISTS (SELECT 1 FROM nodes WHERE id LIKE '%' || edges.target || ':%')
`

export const SYNC_GRAPH_EDGES = `
  UPDATE graph_edges SET target = (
    SELECT target FROM edges
    WHERE edges.source = graph_edges.source
      AND edges.kind = graph_edges.kind
      AND edges.target LIKE graph_edges.target || ':%'
      AND edges.target LIKE '%:%:%'
    LIMIT 1
  )
  WHERE kind = 'calls'
    AND target NOT LIKE '%:%:%'
    AND EXISTS (
      SELECT 1 FROM edges
      WHERE edges.source = graph_edges.source
        AND edges.kind = graph_edges.kind
        AND edges.target LIKE graph_edges.target || ':%'
        AND edges.target LIKE '%:%:%'
    )
`

export const INSERT_UNRESOLVED_REF = `
  INSERT OR IGNORE INTO unresolved_refs (id, source_node_id, reference_name, kind, line, col, file_path, module_id, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`
export const GET_UNRESOLVED_REFS = `
  SELECT * FROM unresolved_refs WHERE resolved = 0 ORDER BY created_at
`
export const MARK_REF_RESOLVED = `UPDATE unresolved_refs SET resolved = 1 WHERE id = ?`
export const DELETE_UNRESOLVED_REFS_BY_FILE = `DELETE FROM unresolved_refs WHERE file_path = ?`

export const INSERT_MODULE = `
  INSERT OR REPLACE INTO modules (id, name, root_path, build_system, language, indexed_at)
  VALUES (?, ?, ?, ?, ?, ?)
`
export const GET_ALL_MODULES = `SELECT * FROM modules`
export const GET_ALL_EDGES = `SELECT * FROM edges`

export const INSERT_ANNOTATION = `
  INSERT OR REPLACE INTO annotations (id, node_id, annotation_name, value, line, module_id)
  VALUES (?, ?, ?, ?, ?, ?)
`
export const GET_ANNOTATIONS_BY_NODE = `SELECT * FROM annotations WHERE node_id = ?`
export const GET_NODES_BY_ANNOTATION = `SELECT n.* FROM nodes n INNER JOIN annotations a ON n.id = a.node_id WHERE a.annotation_name = ?`

export const INSERT_TEMPLATE = `
  INSERT OR REPLACE INTO templates (id, file_path, language, component_refs, event_bindings, slot_usages, directives, module_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`
export const GET_TEMPLATES_BY_MODULE = `SELECT * FROM templates WHERE module_id = ?`

/* External cross-service tables */
export const INSERT_EXTERNAL_SYMBOL = "INSERT OR REPLACE INTO external_symbols (id, name, kind, providing_service, definition_file, signature, metadata, version, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
export const INSERT_EXTERNAL_REFERENCE = "INSERT INTO external_references (source_location, external_symbol_id, reference_type, target_service, source_service, metadata) VALUES (?, ?, ?, ?, ?, ?)"
export const GET_EXTERNAL_SYMBOLS_BY_SERVICE = "SELECT * FROM external_symbols WHERE providing_service = ?"
export const GET_EXTERNAL_SYMBOL_BY_ID = "SELECT * FROM external_symbols WHERE id = ?"
export const GET_EXTERNAL_REFS_BY_SYMBOL = "SELECT * FROM external_references WHERE external_symbol_id = ?"
export const GET_EXTERNAL_REFS_BY_SYMBOL_NAME = "SELECT r.*, s.name as symbol_name, s.providing_service as service_name, s.signature FROM external_references r JOIN external_symbols s ON r.external_symbol_id = s.id WHERE s.name = ?"
export const GET_EXTERNAL_REFS_BY_SOURCE_NAME = "SELECT r.*, s.name as symbol_name, s.providing_service as service_name, s.signature FROM external_references r JOIN external_symbols s ON r.external_symbol_id = s.id WHERE r.source_location LIKE ?"
export const GET_ALL_EXTERNAL_SYMBOLS = "SELECT * FROM external_symbols"
export const GET_ALL_EXTERNAL_REFERENCES = "SELECT * FROM external_references"
export const DELETE_EXTERNAL_SYMBOLS_BY_SERVICE = "DELETE FROM external_symbols WHERE providing_service = ?"
export const UPDATE_EXTERNAL_SYMBOL = "UPDATE external_symbols SET name=?, kind=?, providing_service=?, signature=?, version=?, changed_at=? WHERE id=?"
export const DELETE_EXTERNAL_SYMBOL_BY_ID = "DELETE FROM external_symbols WHERE id=?"
export const DELETE_EXTERNAL_REFERENCE_BY_ID = "DELETE FROM external_references WHERE id=?"
export const DELETE_EXTERNAL_REFS_BY_SERVICE = "DELETE FROM external_references WHERE target_service = ? OR external_symbol_id IN (SELECT id FROM external_symbols WHERE providing_service = ?)"

/** P1: Drop FTS triggers before bulk insert to avoid per-row trigger overhead */
export const DROP_FTS_TRIGGERS = `
  DROP TRIGGER IF EXISTS nodes_ai;
  DROP TRIGGER IF EXISTS nodes_ad;
  DROP TRIGGER IF EXISTS nodes_au;
`

/** P1: Recreate FTS triggers after bulk insert */
export const CREATE_FTS_TRIGGERS = `
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
`

/** P1: Rebuild FTS index after bulk insert */
export const REBUILD_FTS = `INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`

/* Entry points */
export const INSERT_ENTRY_POINT = `INSERT OR REPLACE INTO entry_points (id, kind, service, method, file_path, line, signature, http_method, path, queue_name, cron_expr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
export const DELETE_ENTRY_POINTS_BY_SERVICE = `DELETE FROM entry_points WHERE service = ?`

/* ============ Enterprise Java additions (ADR-013) ============ */

/* Service build dependencies (from pom.xml / build.gradle) */
export const INSERT_SERVICE_DEPENDENCY = `INSERT OR IGNORE INTO service_dependencies (source_service, target_service, dependency_type, optional, detected_from, module_id) VALUES (?, ?, ?, ?, ?, ?)`
export const GET_SERVICE_DEPENDENCIES_BY_SERVICE = `SELECT * FROM service_dependencies WHERE source_service = ?`
export const GET_SERVICE_DEPENDENCIES_BY_TARGET = `SELECT * FROM service_dependencies WHERE target_service = ?`
export const DELETE_SERVICE_DEPENDENCIES_BY_SERVICE = `DELETE FROM service_dependencies WHERE source_service = ?`

/* Flowable BPMN process tables */
export const INSERT_FLOWABLE_PROCESS = `INSERT OR REPLACE INTO flowable_processes (id, process_id, name, is_executable, version, target_namespace, file_path, module_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
export const GET_FLOWABLE_PROCESSES_BY_MODULE = `SELECT * FROM flowable_processes WHERE module_id = ?`
export const GET_ALL_FLOWABLE_PROCESSES = `SELECT * FROM flowable_processes`
export const GET_FLOWABLE_PROCESS_BY_ID = `SELECT * FROM flowable_processes WHERE id = ?`

export const INSERT_FLOWABLE_NODE = `INSERT OR REPLACE INTO flowable_nodes (id, process_id, name, type, implementation, async, documentation, module_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
export const GET_FLOWABLE_NODES_BY_PROCESS = `SELECT * FROM flowable_nodes WHERE process_id = ? ORDER BY rowid`

export const INSERT_FLOWABLE_FLOW = `INSERT OR REPLACE INTO flowable_flows (id, process_id, from_node, to_node, condition_expression, condition_language) VALUES (?, ?, ?, ?, ?, ?)`
export const GET_FLOWABLE_FLOWS_BY_PROCESS = `SELECT * FROM flowable_flows WHERE process_id = ? ORDER BY rowid`

/* Drools/KIE rule tables */
export const INSERT_DROOLS_RULE = `INSERT OR REPLACE INTO drools_rules (id, package_name, rule_name, dialect, salience, activation_group, agenda_group, no_loop, lock_on_active, auto_focus, duration, when_condition, then_action, file_path, module_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
export const SEARCH_DROOLS_RULES = `SELECT * FROM drools_rules WHERE when_condition LIKE ? OR rule_name LIKE ? OR then_action LIKE ?`
export const SEARCH_DROOLS_RULES_FTS = `SELECT * FROM drools_rules WHERE module_id = ? AND (when_condition LIKE ? OR rule_name LIKE ? OR then_action LIKE ?)`
export const GET_DROOLS_RULES_BY_MODULE = `SELECT * FROM drools_rules WHERE module_id = ?`
export const GET_ALL_DROOLS_RULES = `SELECT * FROM drools_rules`
export const GET_DROOLS_RULE_BY_ID = `SELECT * FROM drools_rules WHERE id = ?`

export const INSERT_DROOLS_TYPE = `INSERT OR REPLACE INTO drools_types (id, package_name, type_name, fields, file_path) VALUES (?, ?, ?, ?, ?)`
export const GET_DROOLS_TYPES_BY_MODULE = `SELECT * FROM drools_types WHERE id LIKE ?`

export const INSERT_DROOLS_QUERY = `INSERT OR REPLACE INTO drools_queries (id, package_name, query_name, parameters, expression, file_path) VALUES (?, ?, ?, ?, ?, ?)`

export const INSERT_DROOLS_FUNCTION = `INSERT OR REPLACE INTO drools_functions (id, package_name, function_name, return_type, parameters, body, file_path) VALUES (?, ?, ?, ?, ?, ?, ?)`

/* Maven property inheritance chain */
export const INSERT_MAVEN_PROPERTY = `INSERT OR REPLACE INTO maven_properties (id, pom_id, key, value, resolved_value, provenance) VALUES (?, ?, ?, ?, ?, ?)`
export const GET_MAVEN_PROPERTIES_BY_POM = `SELECT * FROM maven_properties WHERE pom_id = ?`

export const INSERT_MAVEN_DEP_MGMT = `INSERT OR IGNORE INTO maven_dependency_management (id, pom_id, group_id, artifact_id, version, scope) VALUES (?, ?, ?, ?, ?, ?)`
export const GET_MAVEN_DEP_MGMT_BY_POM = `SELECT * FROM maven_dependency_management WHERE pom_id = ?`

/* Enterprise framework annotations */
export const INSERT_ENTERPRISE_ANNOTATION = `INSERT OR REPLACE INTO enterprise_annotations (id, framework_name, annotation_name, node_id, kind, description, file_path, module_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
export const GET_ENTERPRISE_ANNOTATIONS_BY_FRAMEWORK = `SELECT * FROM enterprise_annotations WHERE framework_name = ?`
export const GET_ENTERPRISE_ANNOTATIONS_BY_MODULE = `SELECT * FROM enterprise_annotations WHERE module_id = ?`

/* Container images (Jib / Dockerfile) */
export const INSERT_CONTAINER_IMAGE = `INSERT OR REPLACE INTO container_images (id, service_name, image_name, registry_url, base_image, ports, jvm_flags, build_tool, file_path, module_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
export const GET_CONTAINER_IMAGES_BY_SERVICE = `SELECT * FROM container_images WHERE service_name = ?`
export const GET_ALL_CONTAINER_IMAGES = `SELECT * FROM container_images`

/* CI/CD pipelines */
export const INSERT_CICD_PIPELINE = `INSERT OR REPLACE INTO cicd_pipelines (id, pipeline_type, trigger_branches, vm_image, stages, file_path, module_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
export const GET_CICD_PIPELINES_BY_MODULE = `SELECT * FROM cicd_pipelines WHERE module_id = ?`
