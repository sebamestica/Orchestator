/** Esquema SQLite del núcleo. Cada versión se aplica una sola vez (PRAGMA user_version). */
export const MIGRATIONS: readonly string[] = [
  // v1
  `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    quota_method TEXT,
    last_probe_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    text TEXT NOT NULL,
    warnings_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    plan_id TEXT,
    state TEXT NOT NULL,
    agent_id TEXT,
    brief_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_project ON tasks(project_id, state);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    task_id TEXT,
    parent_session_id TEXT,
    state TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT,
    last_seq INTEGER NOT NULL DEFAULT -1
  );
  CREATE INDEX sessions_task ON sessions(task_id);
  CREATE INDEX sessions_parent ON sessions(parent_session_id);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    parent_session_id TEXT,
    type TEXT NOT NULL,
    ts TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE (session_id, seq)
  );
  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    model TEXT,
    day TEXT NOT NULL,
    ts TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER NOT NULL,
    cost_usd REAL
  );
  CREATE INDEX usage_agent_day ON usage(agent_id, day);
  CREATE INDEX usage_session ON usage(session_id);
  CREATE TABLE quota_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    method TEXT NOT NULL,
    taken_at TEXT NOT NULL,
    stale INTEGER NOT NULL,
    error TEXT,
    snapshot_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX quota_agent ON quota_snapshots(agent_id, id);
  `,
  // v2: configuración de worktrees por proyecto (enlaces, postCreate y gate); NULL en los proyectos anteriores.
  `
  ALTER TABLE projects ADD COLUMN workspace_json TEXT;
  `,
  // v3: motivo del último cambio de estado de cada tarea (p. ej. por qué falló) y veces que la flota la empezó.
  `
  ALTER TABLE tasks ADD COLUMN detail TEXT;
  ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  `,
  // v4: índice por día para el resumen de uso y GET /usage con rango y sin agente (usage_agent_day empieza por agent_id).
  `
  CREATE INDEX usage_day ON usage(day);
  `,
];
