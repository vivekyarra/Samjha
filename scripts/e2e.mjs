#!/usr/bin/env node
// End-to-end check of the Samjha HTTP API. Dependency-free (Node 24, global fetch).
//
//   BASE_URL=http://localhost:3000 node scripts/e2e.mjs      (or: npm run e2e)
//
// Prints one line per check ("ok - ..." / "FAIL - ..."), then "N passed, M failed" and the slowest requests.
// Exits 1 if any check fails. Each user keeps its own cookie jar (redirect: "manual").

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 120_000);
const COOKIE_NAME = "samjha_uid";
const SAMPLE_SUBJECT = "Intro to Machine Learning";
const SAMPLE_TOPIC = "Gradient Descent";

// ---------------------------------------------------------------- reporting

let passed = 0;
let failed = 0;
const failures = [];
const timings = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`ok - ${name}`);
  } else {
    failed++;
    const line = detail ? `${name} :: ${detail}` : name;
    failures.push(line);
    console.log(`FAIL - ${line}`);
  }
  return !!cond;
}

function skip(name, why) {
  console.log(`ok - ${name} # skipped: ${why}`);
}

const short = (v, n = 300) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** Human summary of a response for failure lines. */
const desc = (r) => (r.networkError ? `network error: ${r.networkError}` : `HTTP ${r.status} ${short(r.json ?? r.text, 300)}`);

// ---------------------------------------------------------------- HTTP client with cookie jar

class Client {
  constructor(label) {
    this.label = label;
    this.jar = new Map();
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(res) {
    const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const sc of list) {
      const [pair, ...attrs] = sc.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => {
        const [k, v] = a.split("=").map((x) => x?.trim());
        if (/^max-age$/i.test(k)) return Number(v) <= 0;
        if (/^expires$/i.test(k)) return Date.parse(v) < Date.now();
        return false;
      });
      if (!value || expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  get signedIn() {
    return this.jar.has(COOKIE_NAME);
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ json?: unknown, rawBody?: string, form?: FormData, headers?: Record<string,string> }} [opts]
   */
  async req(method, path, opts = {}) {
    const headers = { ...(opts.headers ?? {}) };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    let body;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers["content-type"] = "application/json";
    } else if (opts.rawBody !== undefined) {
      body = opts.rawBody;
      headers["content-type"] ??= "application/json";
    } else if (opts.form) {
      body = opts.form;
    }
    const label = `${this.label} ${method} ${path.split("?")[0]}`;
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(BASE_URL + path, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      const ms = performance.now() - t0;
      timings.push({ label, ms });
      const cause = e?.cause?.code || e?.cause?.message || e?.message || String(e);
      return { status: 0, ok: false, headers: new Headers(), text: "", json: null, bytes: new Uint8Array(), ms, networkError: cause };
    }
    this.absorb(res);
    let bytes = new Uint8Array();
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      timings.push({ label, ms: performance.now() - t0 });
      return { status: res.status, ok: false, headers: res.headers, text: "", json: null, bytes, ms: performance.now() - t0, networkError: `body read failed: ${e?.message || e}` };
    }
    const ms = performance.now() - t0;
    timings.push({ label, ms });
    const text = new TextDecoder().decode(bytes);
    let json = null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("json")) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, headers: res.headers, text, json, bytes, ms };
  }

  get(path, opts) { return this.req("GET", path, opts); }
  post(path, json, opts = {}) { return this.req("POST", path, { ...opts, json }); }
  put(path, json, opts = {}) { return this.req("PUT", path, { ...opts, json }); }
  patch(path, json, opts = {}) { return this.req("PATCH", path, { ...opts, json }); }
  del(path, opts) { return this.req("DELETE", path, opts); }
}

const startsWith = (bytes, ascii) => bytes.length >= ascii.length && [...ascii].every((ch, i) => bytes[i] === ch.charCodeAt(0));
const hasJsonError = (r) => !!r.json && typeof r.json.error === "string" && r.json.error.trim().length > 0;
const enc = encodeURIComponent;
const countStatus = (claims, s) => claims.filter((c) => c.status === s).length;

/** Every covered/wrong claim quotes the explanation verbatim; missing claims carry no evidence. */
function evidenceProblems(claims, explanation) {
  const problems = [];
  for (const c of claims) {
    if (c.status === "missing") {
      if (c.evidence) problems.push(`${c.claim_id} missing but has evidence "${short(c.evidence, 80)}"`);
    } else if (!c.evidence || !explanation.includes(c.evidence)) {
      problems.push(`${c.claim_id} ${c.status} evidence not a verbatim substring: "${short(c.evidence, 80)}"`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- state shared between sections

const A = new Client("guest");
const B = new Client("student");
const anon = new Client("signed-out");

const ctx = {
  a: { subjectId: null, topicId: null, topicName: null, claims: [], sourceId: null, attemptId: null, attempt2Id: null, vivaId: null, reportToken: null, otherTopicId: null },
  b: { subjectId: null, sourceId: null, topicId: null, topic: null, attemptId: null },
};

// ---------------------------------------------------------------- 0. reachability

async function reachability() {
  const r = await anon.get("/");
  if (r.networkError) {
    check(`server reachable at ${BASE_URL}`, false, `${r.networkError}. Start the app (npm run dev / npm start) or set BASE_URL.`);
    return false;
  }
  return check(`server reachable at ${BASE_URL}`, r.status > 0 && r.status < 500, desc(r));
}

// ---------------------------------------------------------------- 1. guest flow

async function guestFlow() {
  console.log("\n# guest workspace");
  const d = await A.get("/demo");
  const loc = d.headers.get("location") ?? "";
  check("GET /demo redirects", d.status >= 300 && d.status < 400, desc(d));
  check("GET /demo sets the samjha_uid cookie", A.signedIn, `set-cookie: ${short(d.headers.get("set-cookie") ?? "(none)")}`);
  check("GET /demo lands on a session page", /\/session\/[^/?]+/.test(loc), `location: ${loc || "(none)"}`);
  const redirectTopic = loc.match(/\/session\/([^/?#]+)/)?.[1] ?? null;
  if (!A.signedIn) return false;

  // the subject list the home page uses
  const list = await A.get("/api/subjects");
  check("GET /api/subjects (guest) returns 200", list.status === 200, desc(list));
  const subj = list.json?.subjects?.find((s) => s.name === SAMPLE_SUBJECT);
  check(`guest has the "${SAMPLE_SUBJECT}" subject`, !!subj, short(list.json?.subjects?.map((s) => s.name)));
  if (!subj) return false;
  ctx.a.subjectId = subj.id;
  check("sample subject lists topics, claims and a source", subj.topic_count > 0 && subj.claim_count > 0 && subj.source_count > 0, short(subj));

  const g = await A.get(`/api/subjects/${subj.id}`);
  check("GET /api/subjects/:id returns 200", g.status === 200, desc(g));
  const topics = g.json?.topics ?? [];
  const gd = topics.find((t) => t.name === SAMPLE_TOPIC);
  check(`sample subject has the "${SAMPLE_TOPIC}" topic with claims`, !!gd && gd.claims?.length > 0, short(topics.map((t) => t.name)));
  if (!gd) return false;
  check("/demo redirect points at the Gradient Descent topic", redirectTopic === gd.id, `redirect ${redirectTopic} vs ${gd.id}`);
  check("subject graph includes prerequisites", Array.isArray(g.json?.prerequisites) && g.json.prerequisites.length > 0, short(g.json?.prerequisites));
  ctx.a.topicId = gd.id;
  ctx.a.topicName = gd.name;
  ctx.a.claims = gd.claims;
  ctx.a.sourceId = g.json?.sources?.[0]?.id ?? null;
  ctx.a.otherTopicId = topics.find((t) => t.name === "Backpropagation")?.id ?? topics.find((t) => t.id !== gd.id)?.id ?? null;
  check("subject lists its source", !!ctx.a.sourceId, short(g.json?.sources));

  const t = await A.get(`/api/topics/${gd.id}`);
  check("GET /api/topics/:id returns the topic with claims", t.status === 200 && t.json?.topic?.claims?.length === gd.claims.length, desc(t));

  if (ctx.a.sourceId) {
    const p = await A.get(`/api/sources/${ctx.a.sourceId}/page/2`);
    check("GET /api/sources/:id/page/2 returns page text", p.status === 200 && typeof p.json?.text === "string" && p.json.text.length > 20, desc(p));
  }

  // suggested explanation → grade (expect 1 wrong + 2 missing, verbatim evidence)
  const s = await A.get(`/api/demo/suggestion?topicId=${enc(gd.id)}`);
  const suggestion = s.json?.text ?? "";
  check("GET /api/demo/suggestion returns a suggested explanation", s.status === 200 && suggestion.length > 40, desc(s));
  if (suggestion) {
    const gr = await A.post("/api/grade", { topicId: gd.id, explanation: suggestion, kind: "explain" });
    const claims = gr.json?.result?.claims ?? [];
    check("POST /api/grade (suggested explanation) returns 200", gr.status === 200 && !!gr.json?.attemptId, desc(gr));
    ctx.a.attemptId = gr.json?.attemptId ?? null;
    check("grade verdict covers every claim exactly once", claims.length === gd.claims.length && new Set(claims.map((c) => c.claim_id)).size === gd.claims.length, `${claims.length} verdicts for ${gd.claims.length} claims`);
    const wrong = countStatus(claims, "wrong");
    const missing = countStatus(claims, "missing");
    check("suggested explanation grades as exactly 1 wrong + 2 missing", wrong === 1 && missing === 2, `wrong=${wrong} missing=${missing} covered=${countStatus(claims, "covered")} engine=${gr.json?.result?.meta?.engine ?? "?"}`);
    const probs = evidenceProblems(claims, suggestion);
    check("grade evidence is quoted verbatim from the explanation", probs.length === 0, probs.join("; "));
    const wrongClaim = claims.find((c) => c.status === "wrong");
    check("the wrong claim carries a correction", !!wrongClaim?.correction, short(wrongClaim));
    check("grade returns mastery for the graded claims", gr.json?.mastery && Object.keys(gr.json.mastery).length === claims.length, short(gr.json?.mastery));
  }

  // buddy (streamed text)
  if (ctx.a.attemptId) {
    const bd = await A.post("/api/buddy", { topicId: gd.id, attemptId: ctx.a.attemptId, mode: "gaps" });
    check("POST /api/buddy (gaps) streams a non-empty reply", bd.status === 200 && bd.text.trim().length > 20, desc(bd));
    const bq = await A.post("/api/buddy", { topicId: gd.id, attemptId: ctx.a.attemptId, mode: "question", question: "Why do we subtract the gradient?" });
    check("POST /api/buddy (question) streams a non-empty reply", bq.status === 200 && bq.text.trim().length > 20, desc(bq));
  }

  // style preferences by voice command
  const pc = await A.post("/api/prefs/command", { text: "explain in Hinglish with cricket analogies", subjectId: ctx.a.subjectId });
  check("POST /api/prefs/command applies the style change", pc.status === 200 && pc.json?.applied === true, desc(pc));
  check("style command sets language to Hinglish", /hinglish/i.test(pc.json?.prefs?.language ?? ""), short(pc.json?.prefs));
  check("style command sets cricket analogies", /cricket/i.test(pc.json?.prefs?.analogy ?? ""), short(pc.json?.prefs));
  check("style command returns a confirmation line", typeof pc.json?.confirmation === "string" && pc.json.confirmation.length > 0, short(pc.json?.confirmation));
  const pg = await A.get(`/api/prefs?subjectId=${enc(ctx.a.subjectId)}`);
  check("GET /api/prefs reflects Hinglish + cricket", pg.status === 200 && /hinglish/i.test(pg.json?.effective?.language ?? "") && /cricket/i.test(pg.json?.effective?.analogy ?? ""), desc(pg));

  // intent classification
  const utterances = [
    { text: "stop", mode: "explain", hasTopic: true, expect: "control" },
    { text: "show my heatmap", mode: "browse", hasTopic: false, expect: "navigation" },
    { text: "explain in Hinglish with cricket analogies", mode: "explain", hasTopic: true, expect: "style" },
    { text: "Gradient descent keeps nudging the weights against the gradient, scaled by the learning rate, until the loss stops going down.", mode: "explain", hasTopic: true, expect: "explanation" },
  ];
  for (const u of utterances) {
    const r = await A.post("/api/intent", { text: u.text, mode: u.mode, hasTopic: u.hasTopic });
    check(`POST /api/intent "${short(u.text, 40)}" → ${u.expect}`, r.status === 200 && r.json?.intent === u.expect, desc(r));
  }

  // explain-back with a strong explanation built from the claim texts
  const strong = gd.claims.map((c) => c.text).join(" ");
  const eb = await A.post("/api/grade", { topicId: gd.id, explanation: strong, kind: "explain_back", parentAttemptId: ctx.a.attemptId, afterBuddy: true });
  const ebClaims = eb.json?.result?.claims ?? [];
  check("POST /api/grade (explain_back) returns 200", eb.status === 200, desc(eb));
  ctx.a.attempt2Id = eb.json?.attemptId ?? null;
  check("strong explain-back covers every claim", ebClaims.length === gd.claims.length && ebClaims.every((c) => c.status === "covered"),
    short(ebClaims.filter((c) => c.status !== "covered").map((c) => `${c.claim_id}:${c.status}`)));
  const ebProbs = evidenceProblems(ebClaims, strong);
  check("explain-back evidence is verbatim", ebProbs.length === 0, ebProbs.join("; "));

  // review / heatmap / graph
  const due = await A.get("/api/review/due");
  check("GET /api/review/due returns topics and totals", due.status === 200 && Array.isArray(due.json?.topics) && typeof due.json?.total === "number", desc(due));
  check("guest workspace has reviews due", (due.json?.total ?? 0) > 0, short(due.json));

  const hmAll = await A.get("/api/heatmap");
  check("GET /api/heatmap lists the sample subject", hmAll.status === 200 && hmAll.json?.subjects?.some((s) => s.subject?.id === ctx.a.subjectId), desc(hmAll));
  const hm = await A.get(`/api/heatmap?subjectId=${enc(ctx.a.subjectId)}`);
  check("GET /api/heatmap?subjectId returns one tile per topic", hm.status === 200 && hm.json?.topics?.length === topics.length, desc(hm));

  const gv = await A.get(`/api/graph/${ctx.a.subjectId}`);
  check("GET /api/graph/:subjectId returns nodes and edges", gv.status === 200 && gv.json?.nodes?.length === topics.length && gv.json?.edges?.length > 0, desc(gv));
  const traceTopic = ctx.a.otherTopicId ?? gd.id;
  const tr = await A.get(`/api/graph/trace?topicId=${enc(traceTopic)}`);
  check("GET /api/graph/trace returns a path and message", tr.status === 200 && Array.isArray(tr.json?.path) && tr.json.path.length > 0 && typeof tr.json?.message === "string", desc(tr));

  // exam eve
  const ee = await A.get(`/api/exam-eve/plan?subjectId=${enc(ctx.a.subjectId)}&budget=10`);
  check("GET /api/exam-eve/plan (10 min) returns a plan", ee.status === 200 && ee.json?.budgetMin === 10 && ee.json?.topics?.length > 0, desc(ee));
  check("exam-eve plan fits the time budget", typeof ee.json?.totalSec === "number" && ee.json.totalSec <= 10 * 60, `totalSec=${ee.json?.totalSec}`);
  const ee5 = await A.post("/api/exam-eve/plan", { subjectId: ctx.a.subjectId, budgetMin: 5 });
  check("POST /api/exam-eve/plan (5 min) returns a plan", ee5.status === 200 && ee5.json?.budgetMin === 5 && Array.isArray(ee5.json?.topics), desc(ee5));

  // exports
  const anki = await A.get(`/api/export/anki?subjectId=${enc(ctx.a.subjectId)}`);
  check("GET /api/export/anki returns an .apkg zip (PK)", anki.status === 200 && startsWith(anki.bytes, "PK"), `HTTP ${anki.status} ${anki.headers.get("content-type")} ${anki.bytes.length} bytes`);
  check("anki export reports a card count", Number(anki.headers.get("x-samjha-cards")) > 0, `x-samjha-cards=${anki.headers.get("x-samjha-cards")}`);
  const gaps = await A.get(`/api/export/gaps.pdf?subjectId=${enc(ctx.a.subjectId)}`);
  check("GET /api/export/gaps.pdf?subjectId returns a PDF", gaps.status === 200 && startsWith(gaps.bytes, "%PDF"), `HTTP ${gaps.status} ${gaps.headers.get("content-type")} ${gaps.bytes.length} bytes`);
  const gapsAll = await A.get("/api/export/gaps.pdf");
  check("GET /api/export/gaps.pdf (all subjects) returns a PDF", gapsAll.status === 200 && startsWith(gapsAll.bytes, "%PDF"), `HTTP ${gapsAll.status} ${gapsAll.bytes.length} bytes`);
  if (ctx.a.attemptId) {
    const tx = await A.get(`/api/export/transcript?attemptId=${enc(ctx.a.attemptId)}`);
    check("GET /api/export/transcript returns markdown", tx.status === 200 && /markdown/.test(tx.headers.get("content-type") ?? "") && tx.text.length > 50, desc(tx));
    check("transcript contains the explanation", tx.text.includes(suggestion.slice(0, 40)), short(tx.text, 200));
  }

  // settings
  const st = await A.get("/api/settings");
  check("GET /api/settings returns settings", st.status === 200 && typeof st.json?.theme === "string" && typeof st.json?.autoSubmitMs === "number", desc(st));
  const nextTheme = st.json?.theme === "dark" ? "light" : "dark";
  const sp = await A.put("/api/settings", { theme: nextTheme, voiceRate: 1.25 });
  check("PUT /api/settings saves", sp.status === 200 && sp.json?.theme === nextTheme && sp.json?.voiceRate === 1.25, desc(sp));
  const st2 = await A.get("/api/settings");
  check("saved settings persist", st2.json?.theme === nextTheme && st2.json?.voiceRate === 1.25, desc(st2));

  // viva
  const vs = await A.post("/api/viva", { mode: "viva", subjectId: ctx.a.subjectId, durationMin: 5, persona: "strict professor" });
  const view = vs.json?.view;
  check("POST /api/viva starts a session", vs.status === 200 && !!view?.id, desc(vs));
  check('viva persona "strict professor" maps to strict', view?.persona === "strict", short(view?.persona));
  check("viva asks a first question", typeof view?.current?.text === "string" && view.current.text.length > 5, short(view?.current));
  if (view?.id) {
    ctx.a.vivaId = view.id;
    const va = await A.post(`/api/viva/${view.id}/answer`, { text: strong });
    check("POST /api/viva/:id/answer returns feedback", va.status === 200 && typeof va.json?.feedbackLine === "string" && !!va.json?.view, desc(va));
    check("viva counts the answer", (va.json?.view?.answered ?? 0) >= 1, short(va.json?.view?.answered));
    const vg = await A.get(`/api/viva/${view.id}`);
    check("GET /api/viva/:id returns the session", vg.status === 200 && vg.json?.view?.id === view.id, desc(vg));
    const ve = await A.post(`/api/viva/${view.id}/end`, {});
    check("POST /api/viva/:id/end returns a scorecard", ve.status === 200 && !!ve.json?.scorecard, desc(ve));
    check("ended viva is done", ve.json?.view?.done === true, short(ve.json?.view?.done));
    const vh = await A.get("/api/viva");
    check("GET /api/viva history includes the session", vh.status === 200 && Array.isArray(vh.json?.history) && vh.json.history.some((h) => h.id === view.id), desc(vh));
  }

  // class view for the shared sample subject
  const cv = await A.get(`/api/class/${ctx.a.subjectId}`);
  check("GET /api/class/:subjectId returns the class heatmap", cv.status === 200 && !!cv.json?.heatmap && Array.isArray(cv.json?.misunderstood), desc(cv));
  check("sample subject is shared with classmates", cv.json?.subject?.isShared === true, short(cv.json?.subject));
  check("class view lists most-misunderstood claims", (cv.json?.misunderstood?.length ?? 0) > 0, short(cv.json?.misunderstood));
  ctx.a.reportToken = cv.json?.reportToken ?? null;
  const rp = await A.get(`/api/class/${ctx.a.subjectId}/report.pdf`);
  check("GET /api/class/:subjectId/report.pdf returns a PDF", rp.status === 200 && startsWith(rp.bytes, "%PDF"), `HTTP ${rp.status} ${rp.bytes.length} bytes ${short(rp.json ?? "")}`);
  if (ctx.a.reportToken) {
    const rt = await anon.get(`/api/class/${ctx.a.subjectId}/report.pdf?token=${enc(ctx.a.reportToken)}`);
    check("report.pdf with the report token works signed out", rt.status === 200 && startsWith(rt.bytes, "%PDF"), `HTTP ${rt.status} ${rt.bytes.length} bytes`);
  }
  const sh = await A.post(`/api/class/${ctx.a.subjectId}/share`, {});
  check("POST /api/class/:subjectId/share returns a join code + QR", sh.status === 200 && typeof sh.json?.code === "string" && /^data:image\/png/.test(sh.json?.qrDataUrl ?? ""), desc(sh));
  return true;
}

// ---------------------------------------------------------------- 2. signed-in flow

const NOTES_MD = `# Cell Biology Basics

## Mitochondria
Mitochondria are the organelles that produce most of the cell's ATP through cellular respiration.
They have a double membrane, and the inner membrane is folded into cristae to increase surface area.
Mitochondria contain their own circular DNA, which is inherited from the mother.

## Ribosomes
Ribosomes are the sites of protein synthesis, where messenger RNA is translated into a chain of amino acids.
Free ribosomes float in the cytoplasm, while bound ribosomes are attached to the rough endoplasmic reticulum.
Each ribosome is made of a large subunit and a small subunit built from ribosomal RNA and proteins.

## Cell Membrane
The cell membrane is a phospholipid bilayer with hydrophilic heads facing outward and hydrophobic tails facing inward.
It is selectively permeable, so small non-polar molecules cross easily while ions need transport proteins.
Membrane proteins act as channels, carriers, receptors and enzymes.
`;

async function signedInFlow() {
  console.log("\n# signed-in student");
  const email = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const lg = await B.post("/api/auth/login", { name: "E2E Student", email });
  check("POST /api/auth/login signs in a new student", lg.status === 200 && lg.json?.ok === true, desc(lg));
  check("login sets the samjha_uid cookie", B.signedIn, `set-cookie: ${short(lg.headers.get("set-cookie") ?? "(none)")}`);
  check("new student is sent to onboarding", lg.json?.redirect === "/onboarding", short(lg.json));
  if (!B.signedIn) return false;

  const empty = await B.get("/api/subjects");
  check("new student starts with no subjects", empty.status === 200 && Array.isArray(empty.json?.subjects) && empty.json.subjects.length === 0, desc(empty));

  const cs = await B.post("/api/subjects", { name: "Cell Biology (e2e)", examDate: "2026-12-15" });
  check("POST /api/subjects creates a subject (201)", cs.status === 201 && !!cs.json?.subject?.id, desc(cs));
  ctx.b.subjectId = cs.json?.subject?.id ?? null;
  if (!ctx.b.subjectId) return false;

  const form = new FormData();
  form.append("file", new Blob([NOTES_MD], { type: "text/markdown" }), "cell-biology.md");
  form.append("mode", "notes");
  const up = await B.req("POST", `/api/subjects/${ctx.b.subjectId}/sources`, { form });
  check("multipart upload of a markdown file returns 201", up.status === 201 && !!up.json?.sourceId, desc(up));
  check("upload creates at least 3 topics", (up.json?.topicsCreated ?? 0) >= 3, short(up.json));
  check("upload creates claims", (up.json?.claimsCreated ?? 0) >= 3, short(up.json));
  ctx.b.sourceId = up.json?.sourceId ?? null;

  const again = new FormData();
  again.append("file", new Blob([NOTES_MD], { type: "text/markdown" }), "cell-biology.md");
  const dup = await B.req("POST", `/api/subjects/${ctx.b.subjectId}/sources`, { form: again });
  check("re-uploading the same file is recognised as a duplicate", (dup.status === 200 || dup.status === 201) && dup.json?.duplicate === true, desc(dup));

  const g = await B.get(`/api/subjects/${ctx.b.subjectId}`);
  const topics = g.json?.topics ?? [];
  check("GET /api/subjects/:id returns the new topics", g.status === 200 && topics.length >= 3, desc(g));
  const withClaims = topics.filter((t) => t.claims?.length > 0);
  check("at least 3 topics have claims", withClaims.length >= 3, short(topics.map((t) => `${t.name}:${t.claims?.length ?? 0}`)));
  const names = topics.map((t) => t.name.toLowerCase()).join(" | ");
  check("topics follow the markdown headings", ["mitochondria", "ribosome", "membrane"].every((h) => names.includes(h)), names);
  check("subject lists the uploaded source", g.json?.sources?.length === 1 && g.json.sources[0].id === ctx.b.sourceId, short(g.json?.sources));

  if (ctx.b.sourceId) {
    const p = await B.get(`/api/sources/${ctx.b.sourceId}/page/1`);
    check("GET /api/sources/:id/page/1 returns the uploaded text", p.status === 200 && /mitochondria|ribosome|membrane/i.test(p.json?.text ?? ""), desc(p));
  }

  const topic = withClaims.find((t) => /mitochondria/i.test(t.name)) ?? withClaims[0];
  if (!topic) return false;
  ctx.b.topicId = topic.id;
  ctx.b.topic = topic;

  const partial = topic.claims[0].text;
  const gp = await B.post("/api/grade", { topicId: topic.id, explanation: partial });
  const gpClaims = gp.json?.result?.claims ?? [];
  check(`POST /api/grade on "${topic.name}" (one claim) returns 200`, gp.status === 200, desc(gp));
  if (topic.claims.length > 1)
    check("partial explanation leaves some claims missing", countStatus(gpClaims, "missing") >= 1, short(gpClaims.map((c) => c.status)));
  const gpProbs = evidenceProblems(gpClaims, partial);
  check("partial grade evidence is verbatim", gpProbs.length === 0, gpProbs.join("; "));

  const full = topic.claims.map((c) => c.text).join(" ");
  const gf = await B.post("/api/grade", { topicId: topic.id, explanation: full });
  const gfClaims = gf.json?.result?.claims ?? [];
  check(`POST /api/grade on "${topic.name}" (all claims) returns 200`, gf.status === 200 && !!gf.json?.attemptId, desc(gf));
  check("full explanation covers every claim", gfClaims.length === topic.claims.length && gfClaims.every((c) => c.status === "covered"),
    short(gfClaims.filter((c) => c.status !== "covered").map((c) => `${c.claim_id}:${c.status}`)));
  ctx.b.attemptId = gf.json?.attemptId ?? gp.json?.attemptId ?? null;

  const hm = await B.get(`/api/heatmap?subjectId=${enc(ctx.b.subjectId)}`);
  check("student heatmap includes the new subject's topics", hm.status === 200 && hm.json?.topics?.length === topics.length, desc(hm));
  return true;
}

// ---------------------------------------------------------------- 3. isolation

async function isolation() {
  console.log("\n# isolation");
  const a = ctx.a;
  const b = ctx.b;

  if (a.subjectId && B.signedIn) {
    const bList = await B.get("/api/subjects");
    check("student's subject list excludes the guest's subject", bList.status === 200 && !bList.json?.subjects?.some((s) => s.id === a.subjectId), desc(bList));
    const bHeat = await B.get("/api/heatmap");
    check("student's heatmap excludes the guest's subject", bHeat.status === 200 && !bHeat.json?.subjects?.some((s) => s.subject?.id === a.subjectId), desc(bHeat));
  }

  const probe = async (client, who, label, method, path, json) => {
    const r = await client.req(method, path, json === undefined ? {} : { json });
    check(`${who}: ${label} → 403/404`, r.status === 403 || r.status === 404, desc(r));
    return r;
  };

  if (a.subjectId && B.signedIn) {
    const S = a.subjectId;
    const T = a.topicId;
    const claimId = a.claims[0]?.id ?? "c_none";
    const list = [
      ["GET subject", "GET", `/api/subjects/${S}`],
      ["PATCH subject", "PATCH", `/api/subjects/${S}`, { name: "renamed by another student" }],
      ["GET subject sources", "GET", `/api/subjects/${S}/sources`],
      ["POST subject source", "POST", `/api/subjects/${S}/sources`, { text: "# Heading\nSome notes that should not land here." }],
      ["GET topic", "GET", `/api/topics/${T}`],
      ["PATCH topic", "PATCH", `/api/topics/${T}`, { inExam: true }],
      ["DELETE topic", "DELETE", `/api/topics/${T}`],
      ...(a.sourceId ? [["GET source page", "GET", `/api/sources/${a.sourceId}/page/1`]] : []),
      ["GET suggestion", "GET", `/api/demo/suggestion?topicId=${enc(T)}`],
      ["POST grade", "POST", "/api/grade", { topicId: T, explanation: "Gradient descent moves downhill." }],
      ["POST buddy", "POST", "/api/buddy", { topicId: T, mode: "gaps" }],
      ...(a.attemptId && b.topicId ? [["POST buddy with guest attempt", "POST", "/api/buddy", { topicId: b.topicId, attemptId: a.attemptId, mode: "gaps" }]] : []),
      ...(a.attemptId ? [["POST grade appeal", "POST", "/api/grade/appeal", { attemptId: a.attemptId, claimId, note: "this is right" }]] : []),
      ["GET heatmap", "GET", `/api/heatmap?subjectId=${enc(S)}`],
      ["GET graph", "GET", `/api/graph/${S}`],
      ["GET graph trace", "GET", `/api/graph/trace?topicId=${enc(T)}`],
      ["POST graph diagnostic", "POST", "/api/graph/diagnostic", { topicId: T, answer: "It is the slope of the loss." }],
      ["GET exam-eve plan", "GET", `/api/exam-eve/plan?subjectId=${enc(S)}&budget=5`],
      ["GET prefs", "GET", `/api/prefs?subjectId=${enc(S)}`],
      ["POST prefs command", "POST", "/api/prefs/command", { text: "use cricket analogies", subjectId: S }],
      ["GET anki export", "GET", `/api/export/anki?subjectId=${enc(S)}`],
      ["GET gaps.pdf export", "GET", `/api/export/gaps.pdf?subjectId=${enc(S)}`],
      ...(a.attemptId ? [["GET transcript export", "GET", `/api/export/transcript?attemptId=${enc(a.attemptId)}`]] : []),
      ["GET class view", "GET", `/api/class/${S}`],
      ["GET class report.pdf", "GET", `/api/class/${S}/report.pdf`],
      ["POST class share", "POST", `/api/class/${S}/share`, {}],
      ["POST viva on guest subject", "POST", "/api/viva", { mode: "viva", subjectId: S, durationMin: 5, persona: "friendly" }],
      ...(a.vivaId
        ? [
            ["GET viva", "GET", `/api/viva/${a.vivaId}`],
            ["POST viva answer", "POST", `/api/viva/${a.vivaId}/answer`, { text: "an answer" }],
            ["POST viva persona", "POST", `/api/viva/${a.vivaId}/persona`, { persona: "friendly" }],
            ["POST viva end", "POST", `/api/viva/${a.vivaId}/end`, {}],
          ]
        : []),
      ["DELETE subject", "DELETE", `/api/subjects/${S}`],
    ];
    for (const [label, method, path, json] of list) await probe(B, "student → guest", label, method, path, json);

    // the guest's data is still intact afterwards
    const still = await A.get(`/api/subjects/${S}`);
    check("guest subject is unchanged after the other student's attempts", still.status === 200 && still.json?.subject?.name === SAMPLE_SUBJECT && still.json?.topics?.some((t) => t.id === T), desc(still));
  } else skip("student → guest probes", "guest or student setup did not complete");

  if (b.subjectId && A.signedIn) {
    const list = [
      ["GET subject", "GET", `/api/subjects/${b.subjectId}`],
      ...(b.topicId ? [["GET topic", "GET", `/api/topics/${b.topicId}`]] : []),
      ...(b.sourceId ? [["GET source page", "GET", `/api/sources/${b.sourceId}/page/1`]] : []),
      ["GET anki export", "GET", `/api/export/anki?subjectId=${enc(b.subjectId)}`],
      ["GET gaps.pdf export", "GET", `/api/export/gaps.pdf?subjectId=${enc(b.subjectId)}`],
      ...(b.attemptId ? [["GET transcript export", "GET", `/api/export/transcript?attemptId=${enc(b.attemptId)}`]] : []),
      ["GET class view", "GET", `/api/class/${b.subjectId}`],
      ["GET class report.pdf", "GET", `/api/class/${b.subjectId}/report.pdf`],
      ["POST class share", "POST", `/api/class/${b.subjectId}/share`, {}],
      ["POST source upload", "POST", `/api/subjects/${b.subjectId}/sources`, { text: "# Heading\nNotes." }],
    ];
    for (const [label, method, path, json] of list) await probe(A, "guest → student", label, method, path, json);
  } else skip("guest → student probes", "guest or student setup did not complete");

  // signed out
  const S = a.subjectId ?? "s_missing";
  const T = a.topicId ?? "t_missing";
  const anonList = [
    ["GET", "/api/subjects"],
    ["POST", "/api/subjects", { name: "x" }],
    ["GET", `/api/subjects/${S}`],
    ["GET", `/api/subjects/${S}/sources`],
    ["POST", `/api/subjects/${S}/sources`, { text: "notes" }],
    ["GET", `/api/topics/${T}`],
    ["GET", `/api/sources/${a.sourceId ?? "src_missing"}/page/1`],
    ["GET", `/api/demo/suggestion?topicId=${enc(T)}`],
    ["POST", "/api/demo/sample", {}],
    ["POST", "/api/grade", { topicId: T, explanation: "x" }],
    ["POST", "/api/grade/appeal", { attemptId: "a_x", claimId: "c_x" }],
    ["POST", "/api/buddy", { topicId: T }],
    ["GET", "/api/prefs"],
    ["POST", "/api/prefs/command", { text: "use cricket analogies" }],
    ["POST", "/api/intent", { text: "stop" }],
    ["GET", "/api/review/due"],
    ["GET", "/api/heatmap"],
    ["GET", `/api/graph/${S}`],
    ["GET", `/api/graph/trace?topicId=${enc(T)}`],
    ["GET", "/api/exam-eve/plan"],
    ["GET", `/api/export/anki?subjectId=${enc(S)}`],
    ["GET", "/api/export/gaps.pdf"],
    ["GET", `/api/export/transcript?attemptId=${enc(a.attemptId ?? "a_x")}`],
    ["GET", "/api/settings"],
    ["PUT", "/api/settings", { theme: "dark" }],
    ["GET", "/api/viva"],
    ["POST", "/api/viva", { subjectId: S }],
    ["GET", `/api/viva/${a.vivaId ?? "v_x"}`],
    ["GET", `/api/class/${S}`],
    ["GET", `/api/class/${S}/report.pdf`],
    ["POST", "/api/class/join", { code: "ABCDEF" }],
  ];
  for (const [method, path, json] of anonList) {
    const r = await anon.req(method, path, json === undefined ? {} : { json });
    check(`signed out: ${method} ${path.split("?")[0]} → 401 with JSON error`, r.status === 401 && hasJsonError(r), desc(r));
  }
}

// ---------------------------------------------------------------- 4. bad input

async function badInput() {
  console.log("\n# bad input");
  const b = ctx.b;
  const BS = b.subjectId ?? "s_missing";
  const BT = b.topicId ?? "t_missing";

  /** [client, label, method, path, opts, expectedStatus?] */
  const cases = [
    [anon, "login with malformed JSON", "POST", "/api/auth/login", { rawBody: "{name:" }, 400],
    [anon, "login without email", "POST", "/api/auth/login", { json: { name: "E2E" } }, 400],
    [anon, "login with an invalid email", "POST", "/api/auth/login", { json: { name: "E2E", email: "not-an-email" } }, 400],
    [B, "create subject with malformed JSON", "POST", "/api/subjects", { rawBody: "{" }, 400],
    [B, "create subject without a name", "POST", "/api/subjects", { json: {} }, 400],
    [B, "create subject with a bad exam date", "POST", "/api/subjects", { json: { name: "x", examDate: "tomorrow" } }, 400],
    [B, "patch subject with malformed JSON", "PATCH", `/api/subjects/${BS}`, { rawBody: "nope" }, 400],
    [B, "source upload with empty JSON", "POST", `/api/subjects/${BS}/sources`, { json: {} }, 400],
    [B, "source upload with malformed JSON", "POST", `/api/subjects/${BS}/sources`, { rawBody: "{]" }, 400],
    [B, "multipart upload without a file", "POST", `/api/subjects/${BS}/sources`, { form: (() => { const f = new FormData(); f.append("mode", "notes"); return f; })() }, 400],
    [B, "multipart upload of an empty file", "POST", `/api/subjects/${BS}/sources`, { form: (() => { const f = new FormData(); f.append("file", new Blob([], { type: "text/markdown" }), "empty.md"); return f; })() }, 400],
    [B, "multipart upload of an unsupported file type", "POST", `/api/subjects/${BS}/sources`, { form: (() => { const f = new FormData(); f.append("file", new Blob([new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3])], { type: "application/x-msdownload" }), "tool.exe"); return f; })() }],
    [B, "patch topic with malformed JSON", "PATCH", `/api/topics/${BT}`, { rawBody: "{" }, 400],
    [B, "patch topic with a negative position", "PATCH", `/api/topics/${BT}`, { json: { position: -1 } }, 400],
    [B, "get a topic that does not exist", "GET", "/api/topics/t_does_not_exist", {}, 404],
    [B, "source page that is not a number", "GET", `/api/sources/${b.sourceId ?? "src_missing"}/page/abc`, {}, b.sourceId ? 400 : undefined],
    [B, "grade with malformed JSON", "POST", "/api/grade", { rawBody: "{oops" }, 400],
    [B, "grade without fields", "POST", "/api/grade", { json: {} }, 400],
    [B, "grade with a blank explanation", "POST", "/api/grade", { json: { topicId: BT, explanation: "   " } }, 400],
    [B, "grade with an over-long explanation", "POST", "/api/grade", { json: { topicId: BT, explanation: "word ".repeat(2000) } }, 400],
    [B, "grade with an unknown kind", "POST", "/api/grade", { json: { topicId: BT, explanation: "x", kind: "quiz" } }, 400],
    [B, "grade an unknown topic", "POST", "/api/grade", { json: { topicId: "t_does_not_exist", explanation: "Some explanation." } }, 404],
    [B, "appeal without fields", "POST", "/api/grade/appeal", { json: {} }, 400],
    [B, "appeal for an unknown attempt", "POST", "/api/grade/appeal", { json: { attemptId: "a_does_not_exist", claimId: "c_x" } }, 404],
    [B, "buddy with malformed JSON", "POST", "/api/buddy", { rawBody: "{" }, 400],
    [B, "buddy with an unknown mode", "POST", "/api/buddy", { json: { topicId: BT, mode: "dance" } }, 400],
    [B, "buddy for an unknown topic", "POST", "/api/buddy", { json: { topicId: "t_does_not_exist" } }, 404],
    [B, "prefs command without text", "POST", "/api/prefs/command", { json: {} }, 400],
    [B, "prefs command with malformed JSON", "POST", "/api/prefs/command", { rawBody: "{" }, 400],
    [B, "set an unknown preference", "POST", "/api/prefs", { json: { key: "colour", value: "blue" } }, 400],
    [B, "intent without text", "POST", "/api/intent", { json: {} }, 400],
    [B, "intent with malformed JSON", "POST", "/api/intent", { rawBody: "{" }, 400],
    [B, "suggestion without topicId", "GET", "/api/demo/suggestion", {}, 400],
    [B, "graph trace without topicId", "GET", "/api/graph/trace", {}, 400],
    [B, "graph trace for an unknown topic", "GET", "/api/graph/trace?topicId=t_does_not_exist", {}, 404],
    [B, "graph diagnostic without fields", "POST", "/api/graph/diagnostic", { json: {} }, 400],
    [B, "exam-eve plan with a 7 minute budget (GET)", "GET", "/api/exam-eve/plan?budget=7", {}, 400],
    [B, "exam-eve plan with a 7 minute budget (POST)", "POST", "/api/exam-eve/plan", { json: { budgetMin: 7 } }, 400],
    [B, "anki export without subjectId", "GET", "/api/export/anki", {}, 400],
    [B, "transcript export without attemptId", "GET", "/api/export/transcript", {}, 400],
    [B, "transcript export for an unknown attempt", "GET", "/api/export/transcript?attemptId=a_does_not_exist", {}, 404],
    [B, "settings with malformed JSON", "PUT", "/api/settings", { rawBody: "{" }, 400],
    [B, "settings with an array body", "PUT", "/api/settings", { json: [] }, 400],
    [B, "settings with an unknown theme", "PUT", "/api/settings", { json: { theme: "purple" } }, 400],
    [B, "settings with an out-of-range auto submit", "PUT", "/api/settings", { json: { autoSubmitMs: 50 } }, 400],
    [B, "settings with an empty name", "PUT", "/api/settings", { json: { name: "" } }, 400],
    [B, "viva without a subject", "POST", "/api/viva", { json: {} }, 400],
    [B, "viva answer for an unknown session", "POST", "/api/viva/v_does_not_exist/answer", { json: { text: "x" } }, 404],
    ...(ctx.a.vivaId ? [[A, "viva persona with an unknown persona", "POST", `/api/viva/${ctx.a.vivaId}/persona`, { json: { persona: "grumpy" } }, 400]] : []),
    [B, "class join without a code", "POST", "/api/class/join", { json: {} }, 400],
    [B, "class join with an unknown code", "POST", "/api/class/join", { json: { code: "QQQQQQ" } }, 404],
  ];

  for (const [client, label, method, path, opts, expected] of cases) {
    if (!client.signedIn && client !== anon) {
      skip(`bad input: ${label}`, `${client.label} is not signed in`);
      continue;
    }
    const r = await client.req(method, path, opts);
    const statusOk = expected ? r.status === expected : r.status >= 400 && r.status < 500;
    check(`bad input: ${label} → ${expected ?? "4xx"} with JSON error`, statusOk && hasJsonError(r), desc(r));
  }
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`Samjha e2e against ${BASE_URL}`);
  const up = await reachability();
  if (up) {
    const sections = [
      ["guest workspace", guestFlow],
      ["signed-in student", signedInFlow],
      ["isolation", isolation],
      ["bad input", badInput],
    ];
    for (const [name, fn] of sections) {
      try {
        await fn();
      } catch (e) {
        check(`${name} section ran to completion`, false, e?.stack || String(e));
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (timings.length) {
    console.log("\nslowest requests:");
    for (const t of [...timings].sort((x, y) => y.ms - x.ms).slice(0, 5)) console.log(`  ${t.ms.toFixed(0).padStart(6)} ms  ${t.label}`);
  }
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.log(`FAIL - e2e script crashed :: ${e?.stack || e}`);
  console.log(`\n${passed} passed, ${failed + 1} failed`);
  process.exit(1);
});
