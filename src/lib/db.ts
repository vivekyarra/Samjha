// Samjha local database. Uses Node's built-in SQLite (node:sqlite) so the app runs with zero setup.
// Production Postgres/Supabase schema (pgvector + RLS) lives in supabase/schema.sql and mirrors these tables.
import "server-only";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = process.env.SAMJHA_DATA_DIR || path.join(process.cwd(), ".data");

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, language TEXT DEFAULT 'English',
  is_demo INTEGER DEFAULT 0, onboarded INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS preferences (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id TEXT, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS preferences_uniq ON preferences(user_id, IFNULL(subject_id, ''), key);
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
  exam_date TEXT, is_shared INTEGER DEFAULT 0, join_code TEXT UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subject_members (
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (subject_id, user_id)
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL, storage_path TEXT, mime TEXT, pages INTEGER DEFAULT 1, url TEXT,
  content_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  page INTEGER NOT NULL, text TEXT NOT NULL, embedding TEXT
);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_id);
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, position INTEGER DEFAULT 0, in_exam INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS topics_subject ON topics(subject_id);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  text TEXT NOT NULL, source_id TEXT REFERENCES sources(id) ON DELETE SET NULL, page INTEGER, position INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS claims_topic ON claims(topic_id);
CREATE TABLE IF NOT EXISTS prerequisites (
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  depends_on_topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (topic_id, depends_on_topic_id)
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id TEXT REFERENCES topics(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  transcript TEXT NOT NULL DEFAULT '', result_json TEXT, parent_attempt_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_user ON attempts(user_id, created_at);
CREATE TABLE IF NOT EXISTS claim_results (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE, status TEXT NOT NULL,
  evidence TEXT, correction TEXT
);
CREATE INDEX IF NOT EXISTS claim_results_claim ON claim_results(claim_id);
CREATE TABLE IF NOT EXISTS claim_cards (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  fsrs_state TEXT, due_at TEXT, mastery TEXT NOT NULL DEFAULT 'red', updated_at TEXT,
  PRIMARY KEY (user_id, claim_id)
);
CREATE TABLE IF NOT EXISTS buddy_messages (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  role TEXT NOT NULL, text TEXT NOT NULL, intent TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS viva_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id TEXT, repo_url TEXT, mode TEXT NOT NULL, persona TEXT NOT NULL, duration_min INTEGER,
  state_json TEXT, scorecard TEXT, created_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS nudges (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, kind TEXT, body TEXT, link TEXT, status TEXT, sent_at TEXT, opened_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, props TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_cache (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

type G = typeof globalThis & { __samjhaDb?: DatabaseSync };

export function db(): DatabaseSync {
  const g = globalThis as G;
  if (!g.__samjhaDb) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const d = new DatabaseSync(path.join(DATA_DIR, "samjha.db"));
    d.exec(SCHEMA);
    g.__samjhaDb = d;
  }
  return g.__samjhaDb;
}

type Param = string | number | null | bigint | Uint8Array;
const norm = (p: unknown[]): Param[] =>
  p.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as Param)));

/** All rows. */
export function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return db().prepare(sql).all(...norm(params)) as T[];
}
/** First row or undefined. */
export function get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  return db().prepare(sql).get(...norm(params)) as T | undefined;
}
/** INSERT/UPDATE/DELETE. */
export function run(sql: string, ...params: unknown[]) {
  return db().prepare(sql).run(...norm(params));
}
/** Run fn inside a transaction. */
export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export const newId = (prefix = "") => prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
export const now = () => new Date().toISOString();
export const dataDir = () => DATA_DIR;

export function logEvent(userId: string | null, name: string, props: Record<string, unknown> = {}) {
  run("INSERT INTO events (id,user_id,name,props,created_at) VALUES (?,?,?,?,?)", newId("e_"), userId, name, JSON.stringify(props), now());
}
