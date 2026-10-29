# Samjha

> **You don't know it until you can say it.**
> A study buddy you only talk to. You explain a topic out loud, Samjha finds exactly what you don't get, checked
> against your own notes, and explains only that, the way a friend would, in exactly the style you want.

**Try Samjha now, no signup:** run it locally and open [`/demo`](http://localhost:3000/demo), or use the hosted link
in the submission. Built for **No Hands: The Wispr Challenge** (WeMakeDevs × Wispr Flow), Builders track, entirely by
voice (Wispr Flow → Claude Code).

---

## The problem

You study a topic alone for five hours and still don't get it. Then, five minutes before the exam, a friend explains it
and it clicks. The friend doesn't know more than the textbook. Their five minutes work because:

1. **They know what you don't get.** They skip what you already understand.
2. **They talk like you.** "Think of it like…" instead of textbook language.
3. **They give only the essentials.** Five things that matter, not fifty pages.

Generic AI can't do this: it doesn't know what *you* are missing, so it gives you the textbook again. And re-reading
notes *feels* like learning but isn't. Explaining out loud (the Feynman technique) is the fastest way to find your
gaps, but typing an explanation is slow, so nobody does it. With voice, explaining takes as long as thinking.

## How it works

1. **You explain** a topic out loud (Wispr Flow, or type).
2. **Samjha diagnoses** each key idea from your notes as ✓ covered, ○ missing or ✕ wrong, quoting your own words as
   evidence and citing the page.
3. **The buddy explains only your gaps**, short and casual, in your saved style, and reads it aloud. Interrupt any
   time: "wait, why?", "give me an example", "shorter".
4. **You explain it back** and the ideas turn green. Spaced repetition keeps them green.

The diagnosis step is what makes the buddy different from a chatbot. It is never skipped.

## Features

| # | Feature | What it does | Status |
|---|---|---|---|
| F1 | Notes to concepts | PDF, text, Markdown, pasted text, photos of handwritten notes, syllabus → topics, 3–8 testable claims each with page citations, prerequisite links; review by voice ("merge these two") | Built |
| F2 | You explain, it grades | Per-claim covered / missing / wrong with verbatim evidence, corrections, misconceptions, "not in your notes", appeal ("this is right") | Built |
| F3 | The buddy | Explains only missing/wrong claims, starts from what you got right, cites pages, stays under the word limit, interruptible | Built |
| F4 | Your style | Language (English / Hinglish / Hindi), analogy world, length, level, format, tone, scope; change by voice, remembered, per-subject overrides, "just this time" | Built |
| F5 | Explain back + mastery | Red / amber / green per claim (always with icon + label), heatmap, "what should I study now?" | Built |
| F6 | Spaced repetition | FSRS (`ts-fsrs`) card per claim, today's review | Built |
| F7 | Exam-eve mode | 5/10/20-minute crash session over only red/amber claims, check questions, "last look" sheet | Built |
| F8 | Root-cause tracing | Follows prerequisites back up to 3 hops: "You're stuck on Backpropagation because the Chain rule is red." | Built |
| F9 | Class heatmap | Join link + QR, anonymous aggregates only, 5-student minimum, most-misunderstood claims, professor report (link + PDF) | Built |
| F10 | Viva + placement | Timed oral exam with personas; placement mode grills you on your own GitHub repo | Built |
| F11 | Chrome extension | "Teach this back" on any selection, slide or PDF, explain in the side panel | Built |
| F12 | Nudges + streaks | Email (Resend) / WhatsApp (Twilio) reminders, quiet hours, exam-week boost, one-tap unsubscribe | Built |
| F13 | Exports | Anki `.apkg`, gaps-only revision PDF, session transcript | Built |
| F14 | No-signup sample workspace | `/demo` opens a fresh "Intro to Machine Learning" workspace with a partly red heatmap, history, sample classmates and a "Suggested explanation" button | Built |

## Voice design (Wispr Flow)

Samjha does not build its own speech recognition. It is designed so Wispr Flow is the natural way to use it:

- **The Voice Box**: one large text field pinned to the bottom of every screen, focused by default. Hold the Wispr
  hotkey, speak, and the text lands there.
- **Auto-submit** after a configurable pause (default 1.5 s), or "submit only when I say *send*".
- **Long explanations** can arrive in pieces; they are joined until you say "done" or pause.
- **Intent classification**: fast rules for short commands, screen context next (long text while explaining is an
  explanation), a small model call last, and a confirm question when unsure.
- **Everything works by voice**: navigation ("open backprop", "show my heatmap", "exam tomorrow"), style ("cricket
  analogy", "in Hinglish", "like I'm 12"), interrupts ("wait, why?"), controls ("stop", "slower", "repeat").
- **Output**: Web Speech API (English + Hindi voices), sentence-by-sentence highlight, stops within 300 ms on any new
  input. Optional premium voice via ElevenLabs.
- Typing always works too, for accessibility and noisy places.

## Architecture

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind v4 |
| Database | One async data layer (`src/lib/db.ts`) with two drivers: Supabase / any Postgres when `DATABASE_URL` is set, otherwise SQLite via Node's built-in `node:sqlite` with zero setup. Tables are created on first run. |
| Retrieval | 256-dim local embeddings for every chunk; cosine search (pgvector HNSW in Postgres) |
| AI | Claude / Gemini / Groq via one client, plus a built-in offline engine (`src/lib/ai.ts`) |
| Spaced repetition | `ts-fsrs` |
| Voice | Wispr Flow in, Web Speech API out, optional ElevenLabs |
| PDF | `unpdf` text extraction with page numbers; model vision for images |
| Graph view | `@xyflow/react` |
| Exports | `pdf-lib`, Anki collection built with `node:sqlite` + `jszip` |
| Nudges | Resend (email), Twilio WhatsApp, Vercel cron |
| Extension | Chrome Manifest V3 side panel (`extension/`) |
| Analytics | `events` table (powers the real results below) |

Every AI path validates JSON against a zod schema with one retry, and falls back to the built-in engine on any error,
so the full explain → grade → buddy → explain-back loop works with no key at all.

### Code map

| Area | Where |
|---|---|
| Ingestion (F1) | `src/lib/ingest`, `src/app/api/subjects`, `src/app/(app)/subjects` |
| Grading (F2) + evaluation | `src/lib/grading`, `src/app/api/grade`, `eval/` |
| Buddy + style (F3, F4) | `src/lib/buddy`, `src/lib/prefs`, `src/app/(app)/style` |
| Voice system | `src/components/voice`, `src/lib/intent`, `src/lib/voice` |
| Session flow | `src/app/(app)/session`, `src/app/(app)/topics`, `src/components/session` |
| Mastery, FSRS, heatmap (F5, F6) | `src/lib/mastery`, `src/app/(app)/home`, `src/app/(app)/review` |
| Exam-eve, graph, root cause (F7, F8) | `src/lib/exameve`, `src/lib/graph`, `src/app/(app)/exam-eve`, `src/app/(app)/graph` |
| Class heatmap (F9) | `src/lib/class`, `src/app/(app)/class`, `src/app/report` |
| Viva + placement (F10) | `src/lib/viva`, `src/app/(app)/viva` |
| Chrome extension (F11) | `extension/`, `src/app/api/ext`, `src/app/ext` |
| Settings, nudges, exports (F12, F13) | `src/lib/settings`, `src/lib/nudges`, `src/lib/exports` |
| Onboarding, sign-in, sample workspace (F14) | `src/app/(app)/onboarding`, `src/app/login`, `src/app/demo`, `src/lib/demo` |

## Data model

```
users            id, name, email, language, is_demo, onboarded, created_at
preferences      id, user_id, subject_id (null = global), key, value, updated_at
settings         user_id, json
subjects         id, owner_id, name, exam_date, is_shared, join_code
subject_members  subject_id, user_id, role (owner | member)
sources          id, subject_id, file_name, storage_path, mime, pages, url
chunks           id, source_id, page, text, embedding vector(256)
topics           id, subject_id, name, position, in_exam
claims           id, topic_id, text, source_id, page, position
prerequisites    topic_id, depends_on_topic_id
attempts         id, user_id, topic_id, kind (explain | explain_back | review | viva | exam_eve), transcript, result_json
claim_results    id, attempt_id, claim_id, status (covered | missing | wrong), evidence, correction
claim_cards      user_id, claim_id, fsrs_state, due_at, mastery (red | amber | green)
buddy_messages   id, attempt_id, role, text, intent
viva_sessions    id, user_id, subject_id | repo_url, mode, persona, state_json, scorecard
nudges           id, user_id, channel, kind, status, sent_at, opened_at
events           id, user_id, name, props, created_at
```

**Privacy:** personal tables are owner-only (RLS on `auth.uid()` in Postgres). Class views return counts only and
hide any topic until at least 5 distinct students have attempted it. One student's data never goes into another
student's prompt.

## Run it

Requires Node 24 (for `node:sqlite`).

```bash
npm install
cp .env.example .env.local   # optional: every key is optional
npm run dev
```

Open <http://localhost:3000/demo> for the sample workspace, or <http://localhost:3000> to sign in with a name and email.

Other scripts: `npm run typecheck`, `npm run lint`, `npm run eval` (grader evaluation), `npm run eval:blind`
(independent blind set), `npm run stats` (usage numbers), `npm run e2e` (215 end-to-end API checks against
`BASE_URL`, default `http://localhost:3000`).

### Environment variables

See [`.env.example`](.env.example). Everything is optional.

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio free key ([get one](https://aistudio.google.com/apikey)) |
| `GROQ_API_KEY` | Groq free key ([get one](https://console.groq.com/keys)) |
| `LLM_BASE_URL` + `LLM_API_KEY` | Any OpenAI-compatible endpoint (OpenRouter, local Ollama, …) |
| `ANTHROPIC_API_KEY` | Claude API |
| `SAMJHA_MODEL_STRONG` / `SAMJHA_MODEL_FAST` | Override model names for the active provider |
| `SAMJHA_OFFLINE=1` | Force the built-in engine even when a key is set |
| `SAMJHA_SECRET` | Signs session cookies and share links (set a long random value in production) |
| `NEXT_PUBLIC_APP_URL` | Public URL for nudge links, QR codes and the extension |
| `DATABASE_URL` | Postgres connection string (Supabase: use the transaction pooler URL, port 6543). Unset = SQLite |
| `SAMJHA_DATA_DIR` | Folder for the SQLite database (default `./.data`) |
| `ELEVENLABS_API_KEY` (+ `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`) | Optional premium voice |
| `RESEND_API_KEY`, `RESEND_FROM` | Email nudges |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` | WhatsApp nudges |
| `CRON_SECRET` | Protects `/api/cron/nudges` |
| `GITHUB_TOKEN` | Higher GitHub API limits for placement mode |

The first AI provider that is configured wins (Claude → Gemini → Groq → custom). With none, Samjha uses its built-in
engine: semantic-overlap grading with negation and contradiction detection, templated buddy explanations from your
own notes, rule-based intent classification. That is how the whole product is tested end to end.

## Sample workspace (`/demo`)

- One click creates a private sandbox account with **Intro to Machine Learning**: 10 pages of lecture notes,
  10 topics (Gradient Descent, Backpropagation, Chain rule, Loss functions, Overfitting, …), 5–6 claims each with
  page citations, prerequisites, a week of study history (partly red / amber / green) and six sample classmates so the
  class heatmap has data.
- It lands on a Gradient Descent session. The **Suggested explanation** button inserts an explanation with one wrong
  idea and two missing ones, so the full loop is visible in one click.
- Sample accounts are removed after an hour; `/demo` is capped at 20 new workspaces per IP per hour to protect API costs.
- New users can load the same notes during onboarding ("use sample notes").

## Grader accuracy

Method (spec §8.5): hand-labelled explanations of the sample ML topics (including Hinglish), every claim labelled
covered / missing / wrong, split into dev and held-out test sets. `npm run eval` grades each one and reports agreement
per status, for the built-in engine and, when a key is set, the model grader.

Results and version history: [`eval/RESULTS.md`](eval/RESULTS.md).

Two checks on explanations the grader was never tuned on:

- **Held-out test split** of the main set (`npm run eval`).
- **Independent blind set** (`eval/blind.json`, `npm run eval:blind`): 30 explanations written separately from the grader,
  with 8 in Hinglish, and never used for tuning.

| Built-in engine (`builtin-v6`, no API key) | Agreement with human labels |
|---|---|
| **Independent blind set** (126 claim labels) | **86.5%** |
| Held-out test split (83 labels) | 84.3% |
| Both unseen sets combined (209 labels) | **85.6%** |
| Hinglish explanations (main set) | 89.6% |
| Precision when it marks a claim *covered* (held-out) | 100% |

The spec's target (F2) is 85% agreement. Grading is deterministic, so a rerun gives exactly these numbers.
`npx tsx eval/samples.test.ts` also checks that every sample-workspace explanation grades as designed.
With `GEMINI_API_KEY`, `GROQ_API_KEY` or `ANTHROPIC_API_KEY` set, `npm run eval` adds a row for the model grader.

## Measured performance

Measured on a laptop with the production build (`npm run build && npm start`), built-in engine.

| Spec target | Measured |
|---|---|
| Grading a 300-word explanation in under 6 s (F2) | **0.17 s** |
| Buddy reply starts within 3 s (F3) | **0.06 s** to first words, streamed |
| 30-page PDF to a topic grid in under 60 s (F1) | **0.7 s** (9 topics, 37 cited claims) |
| One-click sample workspace for judges (F14) | **under 2 s** from click to the first session |
| Concurrency | 15 students × 8 parallel explain → grade → buddy → heatmap loops: **120/120 succeeded, 0 errors** |
| Privacy (F9) | Every subject, heatmap, class, export, transcript, grade and buddy route returns 403 to other accounts |
| End-to-end (`npm run e2e`) | **215/215** checks pass on SQLite and on Postgres 17: guest flow, upload, grading, buddy, exports, viva, class, isolation, bad input |

## Real results

`npm run stats` prints live usage numbers from the database: explanations given, words and minutes explained out
loud, claims fixed on explain-back, topics mastered, study days, viva sessions and classmates who joined
(`npm run stats -- you@example.com` for one account).

## Chrome extension

1. `npm run dev`, then sign in (or open `/demo`).
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → choose the `extension/` folder.
3. Extension **Options** → set the Samjha URL if not `http://localhost:3000` → **Connect extension**.
4. Select text on any page, slide or PDF and press **Ctrl+Shift+Y** (⌘⇧Y on Mac), or right-click → **Teach this back
   with Samjha**.

Details: [`extension/README.md`](extension/README.md).

## Deploy

- **Self-host / single server:** `npm run build && npm start`. SQLite lives in `SAMJHA_DATA_DIR`; put it on a
  persistent disk (Railway, Fly.io volume, a VPS).
- **Vercel + Supabase (free tiers):** create a Supabase project, copy its transaction-pooler connection string
  (Project Settings → Database, port 6543) into `DATABASE_URL` on Vercel, and deploy. Tables are created on the first
  request. Put the Vercel functions in the same region as the database. `vercel.json` runs the nudges cron daily;
  set `CRON_SECRET`. Steps: [`supabase/README.md`](supabase/README.md).
- Set `SAMJHA_SECRET` and `NEXT_PUBLIC_APP_URL` in every deployment.
