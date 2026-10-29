# Samjha on Supabase

## Deploy (Vercel + Supabase, free tiers)

The app talks to Postgres through `src/lib/db.ts` and creates its own tables on the first request.

1. Create a Supabase project (free plan). Pick the region closest to your users.
2. Project Settings → Database → Connection string → **Transaction pooler** (port 6543). Put it in `DATABASE_URL`
   on Vercel together with `SAMJHA_SECRET`, `NEXT_PUBLIC_APP_URL` and any AI / voice / email keys from `.env.example`.
3. Set the Vercel functions region to the same region as the database, then deploy.
4. Open `/demo`: the first request creates the tables.

Local development needs no database: without `DATABASE_URL` the same code runs on SQLite (`node:sqlite`).

## `schema.sql`: Supabase-native schema

`schema.sql` is a separate, fully typed design for clients that use Supabase directly (Supabase Auth, `auth.uid()`
row-level security, pgvector). It uses native types (`boolean`, `timestamptz`, `vector`) and is meant for its own
project, not the database the app above writes to.

### What it creates

- Every table from the data model (spec 9.1) plus the extra columns the app uses (`is_demo`, `onboarded`, `in_exam`,
  `result_json`, `parent_attempt_id`, `settings`, `rate_limits`, `ai_cache`).
- `pgvector` with `chunks.embedding vector(256)` and an HNSW cosine index, plus `match_chunks(subject, query, k)` for retrieval.
- Row-level security on every table:
  - personal data (attempts, claim results, FSRS cards, buddy messages, preferences, settings, viva sessions, nudges)
    is readable and writable only by its owner (`auth.uid()`);
  - course material (sources, chunks, topics, claims, prerequisites) is readable by subject members and writable by the
    subject owner;
  - members see only their own membership row, never a classmate list.
- Class heatmap functions `class_topic_stats(subject)` and `class_claim_stats(subject)`: `SECURITY DEFINER`, return
  counts only, only to members, and only for topics/claims attempted by **at least 5 distinct students**.
- `cleanup_sample_users()` removes no-signup sample accounts after an hour.

### Applying it

1. Create a Supabase project.
2. SQL editor → paste `schema.sql` → Run (or `supabase db push` with the file in `supabase/migrations/`).
3. Optional: enable `pg_cron` and schedule the sample cleanup:
   ```sql
   select cron.schedule('samjha-sample-cleanup', '*/15 * * * *', $$select public.cleanup_sample_users()$$);
   ```
4. Create a private Storage bucket `sources` for uploaded files (`sources.storage_path` stores the object path).
5. In Vercel, set the env vars from `.env.example` plus `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
   `SUPABASE_SERVICE_ROLE_KEY`. Server routes that must aggregate across users (class heatmap, joining by code,
   nudges cron, sample cleanup) use the service role; everything else runs as the signed-in user so RLS applies.

## Mapping notes

| SQLite (local) | Postgres |
|---|---|
| `TEXT` ids from `newId()` | `uuid` (`gen_random_uuid()`) |
| `embedding TEXT` (JSON array) | `vector(256)` |
| JSON stored as `TEXT` | `jsonb` |
| `INTEGER` 0/1 flags | `boolean` |
| ISO timestamp strings | `timestamptz` |
