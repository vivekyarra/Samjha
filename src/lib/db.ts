// Samjha database. Two drivers behind one async API:
//  - DATABASE_URL set (Supabase / any Postgres) → Postgres via the `postgres` driver. Used in production on Vercel.
//  - otherwise → Node's built-in SQLite (node:sqlite) in ./.data, so the app runs locally with zero setup.
// Queries are written once in SQLite dialect; toPg() rewrites the few differences for Postgres.
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import postgres, { type Sql, type TransactionSql } from "postgres";

const DATA_DIR = process.env.SAMJHA_DATA_DIR || path.join(process.cwd(), ".data");
const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";

// Shared table list. SQLite-flavoured; pgSchema() adapts it.
const TABLES = `
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
  page INTEGER NOT NULL, text TEXT NOT NULL, embedding TEXT /*ROWID*/
);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_id);
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, position INTEGER DEFAULT 0, in_exam INTEGER DEFAULT 0 /*ROWID*/
);
CREATE INDEX IF NOT EXISTS topics_subject ON topics(subject_id);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  text TEXT NOT NULL, source_id TEXT REFERENCES sources(id) ON DELETE SET NULL, page INTEGER, position INTEGER DEFAULT 0 /*ROWID*/
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
CREATE INDEX IF NOT EXISTS claim_results_attempt ON claim_results(attempt_id);
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
  key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_cache (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

const sqliteSchema = () =>
  `PRAGMA journal_mode = WAL;\nPRAGMA foreign_keys = ON;\nPRAGMA busy_timeout = 5000;\n` + TABLES.replaceAll("/*ROWID*/", "");

// Postgres has no implicit rowid; a BIGSERIAL column named rowid keeps "ORDER BY position, rowid" working.
// RLS on with no policies: Supabase's public REST API sees nothing; the app's owner connection is unaffected.
const pgSchema = () => {
  const ddl = TABLES.replaceAll("/*ROWID*/", ", rowid BIGSERIAL").replaceAll("IFNULL(", "COALESCE(");
  const tables = [...ddl.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  return ddl + tables.map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join("\n");
};

/** Rewrite the SQLite dialect used across the app into Postgres. */
export function toPg(sql: string): string {
  let out = sql
    .replace(/\bIFNULL\(/gi, "COALESCE(")
    .replace(/\bLIKE\b/g, "ILIKE")
    // camelCase aliases would be folded to lowercase by Postgres
    .replace(/\bAS\s+([a-z_]*[A-Z]\w*)/g, 'AS "$1"');
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(out)) {
    out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO").replace(/;?\s*$/, " ON CONFLICT DO NOTHING");
  }
  let n = 0;
  return out.replace(/\?/g, () => `$${++n}`);
}

type G = typeof globalThis & { __samjhaDb?: DatabaseSync; __samjhaPg?: Sql; __samjhaPgReady?: Promise<void> };
const g = globalThis as G;
export const usingPostgres = () => !!PG_URL;

function sqlite(): DatabaseSync {
  if (!g.__samjhaDb) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const d = new DatabaseSync(path.join(DATA_DIR, "samjha.db"));
    d.exec(sqliteSchema());
    g.__samjhaDb = d;
  }
  return g.__samjhaDb;
}

async function pg(): Promise<Sql> {
  if (!g.__samjhaPg) {
    const num = { to: 0, from: [20, 1700], serialize: (v: unknown) => String(v), parse: (v: string) => Number(v) };
    const s = postgres(PG_URL, {
      max: Number(process.env.SAMJHA_PG_POOL || 5),
      prepare: false, // works through Supabase's transaction pooler
      idle_timeout: 20,
      connect_timeout: 15,
      onnotice: () => {},
      types: { num },
    });
    g.__samjhaPg = s;
    // Create tables on first use. Skipped when the schema is already there (one round trip per cold start).
    // No advisory lock: Supabase's transaction pooler can't hold session locks, and every statement is IF NOT EXISTS.
    g.__samjhaPgReady = (async () => {
      const [row] = await s.unsafe(`SELECT to_regclass('public.ai_cache') AS t, to_regclass('public.claim_results_attempt') AS i`);
      if (row?.t && row?.i) return;
      for (const stmt of pgSchema().split(";").map((x) => x.trim()).filter(Boolean)) {
        await s.unsafe(stmt).catch((e: { code?: string }) => {
          if (e.code !== "42P07" && e.code !== "23505" && e.code !== "42710") throw e; // already created by a concurrent cold start
        });
      }
    })();
    g.__samjhaPgReady.catch(() => { g.__samjhaPg = undefined; });
  }
  await g.__samjhaPgReady;
  return g.__samjhaPg!;
}

type Param = string | number | null | bigint | Uint8Array;
const norm = (p: unknown[]): Param[] =>
  p.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as Param)));

// Inside tx(), queries run on the transaction's connection.
const txStore = new AsyncLocalStorage<TransactionSql>();

async function pgQuery(sql: string, params: unknown[]) {
  const conn = txStore.getStore() ?? (await pg());
  return conn.unsafe(toPg(sql), norm(params) as never[]);
}

export interface RunResult { changes: number }

/** All rows. */
export async function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  if (PG_URL) return [...(await pgQuery(sql, params))] as T[];
  return sqlite().prepare(sql).all(...norm(params)) as T[];
}
/** First row or undefined. */
export async function get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
  if (PG_URL) return (await pgQuery(sql, params))[0] as T | undefined;
  return sqlite().prepare(sql).get(...norm(params)) as T | undefined;
}
/** INSERT/UPDATE/DELETE. */
export async function run(sql: string, ...params: unknown[]): Promise<RunResult> {
  if (PG_URL) return { changes: (await pgQuery(sql, params)).count ?? 0 };
  return { changes: Number(sqlite().prepare(sql).run(...norm(params)).changes) };
}

// SQLite has one connection, so transactions are queued to keep them from interleaving across awaits.
let sqliteQueue: Promise<unknown> = Promise.resolve();
const sqliteTx = new AsyncLocalStorage<boolean>();

/** Run fn inside a transaction. Keep AI and network calls outside fn. */
export async function tx<T>(fn: () => Promise<T> | T): Promise<T> {
  if (PG_URL) {
    if (txStore.getStore()) return fn();
    const s = await pg();
    return (await s.begin((t) => txStore.run(t, fn))) as T;
  }
  if (sqliteTx.getStore()) return fn();
  const work = () => sqliteTx.run(true, async () => {
    const d = sqlite();
    d.exec("BEGIN IMMEDIATE");
    try {
      const r = await fn();
      d.exec("COMMIT");
      return r;
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  });
  const p = sqliteQueue.then(work, work);
  sqliteQueue = p.catch(() => {});
  return p;
}

/** Multi-row INSERT in chunks (fewer round trips). Table and column names come from code, never from input. */
export async function insertMany(table: string, cols: string[], rows: unknown[][]) {
  const per = Math.max(1, Math.floor(900 / cols.length));
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    const values = part.map(() => `(${cols.map(() => "?").join(",")})`).join(",");
    await run(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values}`, ...part.flat());
  }
}

export const newId = (prefix = "") => prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
export const now = () => new Date().toISOString();
export const dataDir = () => DATA_DIR;

export async function logEvent(userId: string | null, name: string, props: Record<string, unknown> = {}) {
  await run("INSERT INTO events (id,user_id,name,props,created_at) VALUES (?,?,?,?,?)", newId("e_"), userId, name, JSON.stringify(props), now());
}
