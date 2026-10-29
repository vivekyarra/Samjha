-- Samjha: Postgres / Supabase schema (spec 9.1). Mirrors src/lib/db.ts (local SQLite) table for table.
-- Run in the Supabase SQL editor or with `supabase db push`. Idempotent where Postgres allows it.

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- users + preferences

create table if not exists public.users (
  id          uuid primary key default auth.uid(),   -- equals auth.users.id for signed-in users; sample accounts are created server-side
  name        text not null,
  email       text unique,
  language    text not null default 'English',
  is_demo     boolean not null default false,
  onboarded   boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.preferences (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  subject_id  uuid,                       -- null = global preference
  key         text not null,
  value       text not null,
  updated_at  timestamptz not null default now()
);
create unique index if not exists preferences_uniq
  on public.preferences (user_id, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

create table if not exists public.settings (
  user_id  uuid primary key references public.users(id) on delete cascade,
  json     jsonb not null default '{}'::jsonb
);

-- ---------------------------------------------------------------- subjects, sources, chunks

create table if not exists public.subjects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.users(id) on delete cascade,
  name        text not null,
  exam_date   date,
  is_shared   boolean not null default false,
  join_code   text unique,
  created_at  timestamptz not null default now()
);

create table if not exists public.subject_members (
  subject_id  uuid not null references public.subjects(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  role        text not null default 'member' check (role in ('owner', 'member')),
  primary key (subject_id, user_id)
);
create index if not exists subject_members_user on public.subject_members (user_id);

alter table public.preferences
  drop constraint if exists preferences_subject_fk,
  add constraint preferences_subject_fk foreign key (subject_id) references public.subjects(id) on delete cascade;

create table if not exists public.sources (
  id            uuid primary key default gen_random_uuid(),
  subject_id    uuid not null references public.subjects(id) on delete cascade,
  file_name     text not null,
  storage_path  text,                     -- Supabase Storage object path
  mime          text,
  pages         int not null default 1,
  url           text,
  content_hash  text,
  created_at    timestamptz not null default now()
);
create index if not exists sources_subject on public.sources (subject_id);

create table if not exists public.chunks (
  id         uuid primary key default gen_random_uuid(),
  source_id  uuid not null references public.sources(id) on delete cascade,
  page       int not null,
  text       text not null,
  embedding  vector(256)                  -- same 256-dim local embedding as src/lib/ingest/embed.ts
);
create index if not exists chunks_source on public.chunks (source_id);
create index if not exists chunks_embedding_hnsw on public.chunks using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------- concept graph

create table if not exists public.topics (
  id          uuid primary key default gen_random_uuid(),
  subject_id  uuid not null references public.subjects(id) on delete cascade,
  name        text not null,
  position    int not null default 0,
  in_exam     boolean not null default false
);
create index if not exists topics_subject on public.topics (subject_id);

create table if not exists public.claims (
  id         uuid primary key default gen_random_uuid(),
  topic_id   uuid not null references public.topics(id) on delete cascade,
  text       text not null,
  source_id  uuid references public.sources(id) on delete set null,
  page       int,
  position   int not null default 0
);
create index if not exists claims_topic on public.claims (topic_id);

create table if not exists public.prerequisites (
  topic_id             uuid not null references public.topics(id) on delete cascade,
  depends_on_topic_id  uuid not null references public.topics(id) on delete cascade,
  primary key (topic_id, depends_on_topic_id)
);

-- ---------------------------------------------------------------- study data (personal)

create table if not exists public.attempts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.users(id) on delete cascade,
  topic_id           uuid references public.topics(id) on delete cascade,
  kind               text not null check (kind in ('explain', 'explain_back', 'review', 'viva', 'exam_eve')),
  transcript         text not null default '',
  result_json        jsonb,
  parent_attempt_id  uuid references public.attempts(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists attempts_user on public.attempts (user_id, created_at);
create index if not exists attempts_topic on public.attempts (topic_id);

create table if not exists public.claim_results (
  id          uuid primary key default gen_random_uuid(),
  attempt_id  uuid not null references public.attempts(id) on delete cascade,
  claim_id    uuid not null references public.claims(id) on delete cascade,
  status      text not null check (status in ('covered', 'missing', 'wrong')),
  evidence    text,
  correction  text
);
create index if not exists claim_results_claim on public.claim_results (claim_id);
create index if not exists claim_results_attempt on public.claim_results (attempt_id);

create table if not exists public.claim_cards (
  user_id     uuid not null references public.users(id) on delete cascade,
  claim_id    uuid not null references public.claims(id) on delete cascade,
  fsrs_state  jsonb,
  due_at      timestamptz,
  mastery     text not null default 'red' check (mastery in ('red', 'amber', 'green')),
  updated_at  timestamptz,
  primary key (user_id, claim_id)
);
create index if not exists claim_cards_due on public.claim_cards (user_id, due_at);

create table if not exists public.buddy_messages (
  id          uuid primary key default gen_random_uuid(),
  attempt_id  uuid not null references public.attempts(id) on delete cascade,
  role        text not null check (role in ('buddy', 'student')),
  text        text not null,
  intent      text,
  created_at  timestamptz not null default now()
);

create table if not exists public.viva_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  subject_id    uuid references public.subjects(id) on delete cascade,
  repo_url      text,
  mode          text not null check (mode in ('viva', 'placement')),
  persona       text not null,
  duration_min  int,
  state_json    jsonb,
  scorecard     jsonb,
  created_at    timestamptz not null default now(),
  ended_at      timestamptz
);

create table if not exists public.nudges (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  channel    text not null,
  kind       text,
  body       text,
  link       text,
  status     text,
  sent_at    timestamptz,
  opened_at  timestamptz
);

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.users(id) on delete set null,
  name        text not null,
  props       jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists events_name on public.events (name, created_at);

-- Server-only tables (service role): rate limits and AI response cache.
create table if not exists public.rate_limits (
  key           text primary key,
  count         int not null,
  window_start  bigint not null
);
create table if not exists public.ai_cache (
  key         text primary key,
  value       text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- helper functions for RLS

-- SECURITY DEFINER so policies on subject_members don't recurse into themselves.
create or replace function public.is_subject_member(sid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.subject_members m where m.subject_id = sid and m.user_id = auth.uid());
$$;

create or replace function public.is_subject_owner(sid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.subjects s where s.id = sid and s.owner_id = auth.uid());
$$;

create or replace function public.topic_subject(tid uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select subject_id from public.topics where id = tid;
$$;

-- ---------------------------------------------------------------- row-level security

alter table public.users            enable row level security;
alter table public.preferences      enable row level security;
alter table public.settings         enable row level security;
alter table public.subjects         enable row level security;
alter table public.subject_members  enable row level security;
alter table public.sources          enable row level security;
alter table public.chunks           enable row level security;
alter table public.topics           enable row level security;
alter table public.claims           enable row level security;
alter table public.prerequisites    enable row level security;
alter table public.attempts         enable row level security;
alter table public.claim_results    enable row level security;
alter table public.claim_cards      enable row level security;
alter table public.buddy_messages   enable row level security;
alter table public.viva_sessions    enable row level security;
alter table public.nudges           enable row level security;
alter table public.events           enable row level security;
alter table public.rate_limits      enable row level security;  -- no policies: service role only
alter table public.ai_cache         enable row level security;  -- no policies: service role only

-- Owner-only personal tables.
drop policy if exists users_self on public.users;
create policy users_self on public.users for all using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists preferences_owner on public.preferences;
create policy preferences_owner on public.preferences for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists settings_owner on public.settings;
create policy settings_owner on public.settings for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists attempts_owner on public.attempts;
create policy attempts_owner on public.attempts for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists claim_cards_owner on public.claim_cards;
create policy claim_cards_owner on public.claim_cards for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists viva_owner on public.viva_sessions;
create policy viva_owner on public.viva_sessions for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists nudges_owner on public.nudges;
create policy nudges_owner on public.nudges for select using (user_id = auth.uid());

drop policy if exists events_owner on public.events;
create policy events_owner on public.events for insert with check (user_id = auth.uid());

drop policy if exists claim_results_owner on public.claim_results;
create policy claim_results_owner on public.claim_results for all
  using (exists (select 1 from public.attempts a where a.id = attempt_id and a.user_id = auth.uid()))
  with check (exists (select 1 from public.attempts a where a.id = attempt_id and a.user_id = auth.uid()));

drop policy if exists buddy_messages_owner on public.buddy_messages;
create policy buddy_messages_owner on public.buddy_messages for all
  using (exists (select 1 from public.attempts a where a.id = attempt_id and a.user_id = auth.uid()))
  with check (exists (select 1 from public.attempts a where a.id = attempt_id and a.user_id = auth.uid()));

-- Subjects: members read, owner writes. Joining by code goes through a server route (service role).
drop policy if exists subjects_read on public.subjects;
create policy subjects_read on public.subjects for select using (public.is_subject_member(id) or owner_id = auth.uid());
drop policy if exists subjects_insert on public.subjects;
create policy subjects_insert on public.subjects for insert with check (owner_id = auth.uid());
drop policy if exists subjects_write on public.subjects;
create policy subjects_write on public.subjects for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists subjects_delete on public.subjects;
create policy subjects_delete on public.subjects for delete using (owner_id = auth.uid());

-- Members see only their own membership row (no classmate list); owners manage membership.
drop policy if exists members_self on public.subject_members;
create policy members_self on public.subject_members for select using (user_id = auth.uid() or public.is_subject_owner(subject_id));
drop policy if exists members_owner_write on public.subject_members;
create policy members_owner_write on public.subject_members for all
  using (public.is_subject_owner(subject_id)) with check (public.is_subject_owner(subject_id));
drop policy if exists members_leave on public.subject_members;
create policy members_leave on public.subject_members for delete using (user_id = auth.uid());

-- Shared course material (sources, chunks, topics, claims, prerequisites): any member reads, owner writes.
drop policy if exists sources_read on public.sources;
create policy sources_read on public.sources for select using (public.is_subject_member(subject_id));
drop policy if exists sources_write on public.sources;
create policy sources_write on public.sources for all using (public.is_subject_owner(subject_id)) with check (public.is_subject_owner(subject_id));

drop policy if exists chunks_read on public.chunks;
create policy chunks_read on public.chunks for select
  using (exists (select 1 from public.sources s where s.id = source_id and public.is_subject_member(s.subject_id)));
drop policy if exists chunks_write on public.chunks;
create policy chunks_write on public.chunks for all
  using (exists (select 1 from public.sources s where s.id = source_id and public.is_subject_owner(s.subject_id)))
  with check (exists (select 1 from public.sources s where s.id = source_id and public.is_subject_owner(s.subject_id)));

drop policy if exists topics_read on public.topics;
create policy topics_read on public.topics for select using (public.is_subject_member(subject_id));
drop policy if exists topics_write on public.topics;
create policy topics_write on public.topics for all using (public.is_subject_owner(subject_id)) with check (public.is_subject_owner(subject_id));

drop policy if exists claims_read on public.claims;
create policy claims_read on public.claims for select using (public.is_subject_member(public.topic_subject(topic_id)));
drop policy if exists claims_write on public.claims;
create policy claims_write on public.claims for all
  using (public.is_subject_owner(public.topic_subject(topic_id))) with check (public.is_subject_owner(public.topic_subject(topic_id)));

drop policy if exists prereq_read on public.prerequisites;
create policy prereq_read on public.prerequisites for select using (public.is_subject_member(public.topic_subject(topic_id)));
drop policy if exists prereq_write on public.prerequisites;
create policy prereq_write on public.prerequisites for all
  using (public.is_subject_owner(public.topic_subject(topic_id))) with check (public.is_subject_owner(public.topic_subject(topic_id)));

-- ---------------------------------------------------------------- retrieval

create or replace function public.match_chunks(sid uuid, query vector(256), k int default 5)
returns table (id uuid, source_id uuid, file_name text, page int, text text, score float)
language sql stable security invoker set search_path = public as $$
  select c.id, c.source_id, s.file_name, c.page, c.text, 1 - (c.embedding <=> query) as score
  from public.chunks c join public.sources s on s.id = c.source_id
  where s.subject_id = sid and c.embedding is not null
  order by c.embedding <=> query
  limit k;
$$;

-- ---------------------------------------------------------------- class heatmap (F9): counts only, 5-student minimum

-- Per topic: how many distinct members attempted it and how many have each claim green.
-- SECURITY DEFINER reads across members' rows but returns aggregates only, and only to members of the subject.
create or replace function public.class_topic_stats(sid uuid)
returns table (topic_id uuid, topic_name text, students int, claims int, green_cards int, wrong_results int)
language sql stable security definer set search_path = public as $$
  select t.id, t.name,
         count(distinct a.user_id)::int as students,
         (select count(*) from public.claims c where c.topic_id = t.id)::int as claims,
         (select count(*) from public.claim_cards cc join public.claims c on c.id = cc.claim_id
            join public.subject_members m on m.user_id = cc.user_id and m.subject_id = sid
          where c.topic_id = t.id and cc.mastery = 'green' and (cc.due_at is null or cc.due_at > now()))::int as green_cards,
         (select count(*) from public.claim_results r join public.claims c on c.id = r.claim_id
            join public.attempts a2 on a2.id = r.attempt_id
            join public.subject_members m on m.user_id = a2.user_id and m.subject_id = sid
          where c.topic_id = t.id and r.status = 'wrong')::int as wrong_results
  from public.topics t
  join public.attempts a on a.topic_id = t.id
  join public.subject_members m on m.user_id = a.user_id and m.subject_id = sid
  where t.subject_id = sid and public.is_subject_member(sid)
  group by t.id, t.name
  having count(distinct a.user_id) >= 5;
$$;

-- Per claim, for topics that pass the 5-student minimum: share green and how often it was marked wrong.
create or replace function public.class_claim_stats(sid uuid)
returns table (claim_id uuid, topic_id uuid, claim_text text, students int, green int, wrong int)
language sql stable security definer set search_path = public as $$
  select c.id, c.topic_id, c.text,
         count(distinct a.user_id)::int as students,
         count(distinct case when cc.mastery = 'green' then cc.user_id end)::int as green,
         count(case when r.status = 'wrong' then 1 end)::int as wrong
  from public.claims c
  join public.topics t on t.id = c.topic_id and t.subject_id = sid
  join public.claim_results r on r.claim_id = c.id
  join public.attempts a on a.id = r.attempt_id
  join public.subject_members m on m.user_id = a.user_id and m.subject_id = sid
  left join public.claim_cards cc on cc.claim_id = c.id and cc.user_id = a.user_id
  where public.is_subject_member(sid)
  group by c.id, c.topic_id, c.text
  having count(distinct a.user_id) >= 5;
$$;

-- Same aggregates as views for dashboards (service role / professor report). Never exposes user ids.
create or replace view public.class_topic_overview with (security_barrier = true) as
  select t.subject_id, t.id as topic_id, t.name as topic_name, count(distinct a.user_id)::int as students
  from public.topics t
  join public.attempts a on a.topic_id = t.id
  join public.subject_members m on m.user_id = a.user_id and m.subject_id = t.subject_id
  group by t.subject_id, t.id, t.name
  having count(distinct a.user_id) >= 5;
revoke all on public.class_topic_overview from anon, authenticated;

revoke all on function public.class_topic_stats(uuid) from public, anon;
revoke all on function public.class_claim_stats(uuid) from public, anon;
grant execute on function public.class_topic_stats(uuid) to authenticated;
grant execute on function public.class_claim_stats(uuid) to authenticated;
grant execute on function public.match_chunks(uuid, vector, int) to authenticated;

-- ---------------------------------------------------------------- sample workspace housekeeping

-- Sample (no-signup) accounts are removed after an hour. Schedule with pg_cron:
--   select cron.schedule('samjha-sample-cleanup', '*/15 * * * *', $$select public.cleanup_sample_users()$$);
create or replace function public.cleanup_sample_users()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.users where is_demo and created_at < now() - interval '1 hour';
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.cleanup_sample_users() from public, anon, authenticated;
