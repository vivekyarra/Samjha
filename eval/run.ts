// Samjha grader evaluation (spec §8.5). Run: npx tsx eval/run.ts [--label "note"] [--engine builtin|model|both] [--verbose]
// Always runs the built-in engine; also runs the model grader as a separate row when an AI key is set
// (ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY or LLM_BASE_URL + LLM_API_KEY).
// --verbose lists disagreements on the dev split only (the held-out test split is scored, never inspected).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GRADER_VERSION, TUNING, builtinGrade, buildGradingPrompt, finalizeResult, gradeResponseSchema, type GradeInput } from "../src/lib/grading/core";
import type { ClaimStatus, GradeResult } from "../src/lib/types";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATUSES: ClaimStatus[] = ["covered", "missing", "wrong"];

interface TopicDef { id: string; name: string; claims: { id: string; text: string; page: number }[]; notes: { page: number; text: string }[] }
interface Item { id: string; split: "dev" | "test"; hinglish: boolean; topic: string; quality: string; explanation: string; labels: Record<string, ClaimStatus> }
interface Stats { agreement: number; total: number; perStatus: Record<ClaimStatus, { precision: number; recall: number; n: number }>; conf: Record<string, number> }
interface RunScore { engine: string; version: string; date: string; label: string; dev: Stats; test: Stats; hinglish: Stats; all: Stats; msPerItem: number }
interface Row { item: Item; cid: string; gold: ClaimStatus; pred: ClaimStatus; evidence: string }

const args = process.argv.slice(2);
const argVal = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const label = argVal("--label") ?? "";
const engineArg = argVal("--engine") ?? "both";
const verbose = args.includes("--verbose");

const claimsFile = JSON.parse(fs.readFileSync(path.join(DIR, "claims.json"), "utf8")) as { subject: string; topics: TopicDef[] };
const dataset = JSON.parse(fs.readFileSync(path.join(DIR, "dataset.json"), "utf8")) as { items: Item[] };
const topics = new Map(claimsFile.topics.map((t) => [t.id, t]));

function inputFor(item: Item): GradeInput {
  const t = topics.get(item.topic);
  if (!t) throw new Error(`Unknown topic ${item.topic} in ${item.id}`);
  return {
    topic: t.name,
    claims: t.claims.map((c) => ({ id: c.id, text: c.text, page: c.page })),
    chunks: t.notes.map((n) => ({ text: n.text, page: n.page, fileName: "ml-notes.pdf" })),
    explanation: item.explanation,
  };
}

/* ---- model grader (runs outside Next, so it talks to the provider directly) ---- */
function modelProvider(): { name: string; call: (system: string, user: string) => Promise<string> } | null {
  const sys = (s: string) => `${s}\n\nRespond with ONLY a single JSON object. No prose, no markdown fences.`;
  if (process.env.SAMJHA_OFFLINE === "1") return null;
  if (process.env.ANTHROPIC_API_KEY) {
    const model = process.env.SAMJHA_MODEL_STRONG || "claude-sonnet-5-5";
    return {
      name: `claude (${model})`,
      call: async (system, user) => {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const res = await client.messages.create({ model, max_tokens: 2500, system: sys(system), messages: [{ role: "user", content: user }] });
        return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      },
    };
  }
  const oa: [string, string, string, string][] = [
    ["GEMINI_API_KEY", "gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash"],
    ["GROQ_API_KEY", "groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"],
    ["LLM_API_KEY", "custom", (process.env.LLM_BASE_URL ?? "").replace(/\/$/, ""), "gpt-4o-mini"],
  ];
  for (const [env, name, base, def] of oa) {
    const key = process.env[env];
    if (!key || !base) continue;
    const model = process.env.SAMJHA_MODEL_STRONG || def;
    return {
      name: `${name} (${model})`,
      call: async (system, user) => {
        const r = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, max_tokens: 2500, temperature: 0, messages: [{ role: "system", content: sys(system) }, { role: "user", content: user }] }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { choices: { message: { content: string } }[] };
        return j.choices[0]?.message?.content ?? "";
      },
    };
  }
  return null;
}

function parseJson(raw: string): unknown {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s);
}

/* ---- scoring ---- */
function stats(rows: Row[]): Stats {
  const conf: Record<string, number> = {};
  let agree = 0;
  for (const r of rows) {
    const k = `${r.gold}>${r.pred}`;
    conf[k] = (conf[k] ?? 0) + 1;
    if (r.gold === r.pred) agree++;
  }
  const perStatus = {} as Stats["perStatus"];
  for (const s of STATUSES) {
    const tp = conf[`${s}>${s}`] ?? 0;
    const predN = STATUSES.reduce((n, g) => n + (conf[`${g}>${s}`] ?? 0), 0);
    const goldN = STATUSES.reduce((n, p) => n + (conf[`${s}>${p}`] ?? 0), 0);
    perStatus[s] = { precision: predN ? tp / predN : 0, recall: goldN ? tp / goldN : 0, n: goldN };
  }
  return { agreement: rows.length ? agree / rows.length : 0, total: rows.length, perStatus, conf };
}

function printStats(name: string, st: Stats) {
  const agree = Math.round(st.agreement * st.total);
  const per = STATUSES.map((s) => `${s} P${(100 * st.perStatus[s].precision).toFixed(0)}/R${(100 * st.perStatus[s].recall).toFixed(0)}`).join("  ");
  console.log(`  ${name.padEnd(9)} ${agree}/${st.total} = ${(100 * st.agreement).toFixed(1)}%   ${per}`);
}

async function evaluate(engine: string, grade: (inp: GradeInput) => Promise<GradeResult>): Promise<RunScore> {
  const rows: Row[] = [];
  const t0 = Date.now();
  for (const item of dataset.items) {
    const res = await grade(inputFor(item));
    const got = new Map(res.claims.map((c) => [c.claim_id, c]));
    for (const [cid, gold] of Object.entries(item.labels)) {
      const g = got.get(cid);
      if (g && g.status !== "missing" && !item.explanation.includes(g.evidence)) throw new Error(`Evidence not verbatim in ${item.id}/${cid}`);
      rows.push({ item, cid, gold, pred: g?.status ?? "missing", evidence: g?.evidence ?? "" });
    }
  }
  const run: RunScore = {
    engine,
    version: engine === "built-in" ? GRADER_VERSION : "prompt-v1",
    date: new Date().toISOString().slice(0, 10),
    label,
    dev: stats(rows.filter((r) => r.item.split === "dev")),
    test: stats(rows.filter((r) => r.item.split === "test")),
    hinglish: stats(rows.filter((r) => r.item.hinglish)),
    all: stats(rows),
    msPerItem: Math.round((Date.now() - t0) / dataset.items.length),
  };
  console.log(`\n== ${engine} (${run.version}) ==`);
  printStats("held-out", run.test);
  printStats("dev", run.dev);
  printStats("hinglish", run.hinglish);
  printStats("all", run.all);
  if (verbose) {
    for (const r of rows) {
      if (r.gold === r.pred || r.item.split !== "dev") continue;
      console.log(`    ${r.item.id}/${r.cid}: human=${r.gold} grader=${r.pred}${r.evidence ? `  «${r.evidence.slice(0, 90)}»` : ""}`);
    }
  }
  return run;
}

/* ---- results file ---- */
const HISTORY = path.join(DIR, "history.json");
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

function writeResults(runs: RunScore[]) {
  const hist: RunScore[] = fs.existsSync(HISTORY) ? JSON.parse(fs.readFileSync(HISTORY, "utf8")) : [];
  for (const r of runs) {
    const i = hist.findIndex((h) => h.engine === r.engine && h.version === r.version);
    if (i >= 0) hist[i] = r;
    else hist.push(r);
  }
  fs.writeFileSync(HISTORY, JSON.stringify(hist, null, 2) + "\n");
  const items = dataset.items;
  const nLabels = (pred: (i: Item) => boolean) => items.filter(pred).reduce((n, i) => n + Object.keys(i.labels).length, 0);
  const nItems = (pred: (i: Item) => boolean) => items.filter(pred).length;
  const pr = (st: Stats) => STATUSES.map((s) => `${pct(st.perStatus[s].precision)} / ${pct(st.perStatus[s].recall)}`).join(" | ");
  const tick = "`";
  const lines = [
    "# Grader evaluation",
    "",
    `Method (spec §8.5): ${items.length} student explanations of five topics from the *${claimsFile.subject}* subject`,
    "(Gradient Descent, Backpropagation, Chain rule, Overfitting, Loss functions), covering strong, partial, wrong,",
    `vague and Hinglish answers. Every claim was hand-labelled covered / missing / wrong using the F2 rules (${nLabels(() => true)} labels).`,
    "The grader sees the topic, its claims, the note chunks and the explanation. Every covered/wrong verdict must quote",
    "the student's words verbatim, which is checked on every run.",
    "",
    `The set is split into **dev** (${nItems((i) => i.split === "dev")} explanations, ${nLabels((i) => i.split === "dev")} labels), used to tune the built-in engine,`,
    `and **held-out test** (${nItems((i) => i.split === "test")} explanations, ${nLabels((i) => i.split === "test")} labels), which is only scored. The headline number is the`,
    `held-out one. The **Hinglish** slice (${nItems((i) => i.hinglish)} explanations) spans both splits. The built-in engine is deterministic,`,
    "so reruns give identical numbers.",
    "",
    "Protocol note: the first 35 explanations were written and scored once with the untuned engine (builtin-v1) before the",
    "split was fixed and 14 more were added; all tuning after that used dev disagreements only. Later, 12 more dev explanations were",
    "added (paraphrases, role swaps, absolute claims, formula errors), labelled before scoring. Labels were never changed to fit the grader.",
    "",
    `Data: ${tick}eval/claims.json${tick} (claims + note pages), ${tick}eval/dataset.json${tick} (explanations, labels, split).`,
    `Run: ${tick}npm run eval${tick} (${tick}npx tsx eval/run.ts${tick}; add ${tick}--verbose${tick} to list dev disagreements). The model grader runs as a`,
    "separate row when an AI key is set (ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY or LLM_BASE_URL + LLM_API_KEY).",
    "",
    `Regression test: ${tick}npx tsx eval/samples.test.ts${tick} checks that every suggested explanation in the sample workspace`,
    "grades as exactly 1 wrong + 2 missing, and prints which claim was marked wrong.",
    "",
    "## Latest run",
    "",
    "| Engine | Version | Held-out agreement | Dev agreement | Hinglish | All |",
    "|---|---|---|---|---|---|",
    ...runs.map((r) => `| ${r.engine} | ${r.version} | **${pct(r.test.agreement)}** | ${pct(r.dev.agreement)} | ${pct(r.hinglish.agreement)} | ${pct(r.all.agreement)} |`),
    "",
    "Per status on the held-out set (precision / recall):",
    "",
    "| Engine | Covered | Missing | Wrong | Speed |",
    "|---|---|---|---|---|",
    ...runs.map((r) => `| ${r.engine} | ${pr(r.test)} | ${r.msPerItem} ms per explanation |`),
    "",
    "## Versions",
    "",
    "| Date | Engine | Version | Held-out | Dev | Note |",
    "|---|---|---|---|---|---|",
    ...hist.map((h) => `| ${h.date} | ${h.engine} | ${h.version} | ${pct(h.test.agreement)} | ${pct(h.dev.agreement)} | ${h.label} |`),
    "",
    "## How the built-in engine works",
    "",
    "A deterministic semantic matcher: stemming, an ML/science synonym and paraphrase lexicon (including common Hinglish",
    "words), IDF-weighted concept overlap across the subject's claims, bigrams, and number/formula matching. Contradictions",
    "are found with scoped negation, antonym pairs (larger/smaller, increase/decrease, forward/backward, input/output,",
    "maximise/minimise, before/after, add/multiply, regression/classification) and per-clause attribute binding",
    "(for example \"high training error, low test error\" against the notes), training/validation and other role swaps, from/to",
    "direction order, absolute qualifiers (\"only\", \"always\") that the notes do not support, and formula shape (f'(x)·g'(x) vs",
    "f'(g(x))·g'(x)). A span that contradicts a claim is never used as evidence that the claim is covered. It needs no API key.",
    "",
  ];
  fs.writeFileSync(path.join(DIR, "RESULTS.md"), lines.join("\n"));
}

/** Threshold calibration on the dev split only. */
function sweep() {
  const dev = dataset.items.filter((i) => i.split === "dev");
  const base = { ...TUNING };
  const out: { cfg: string; acc: number }[] = [];
  for (const covered of [0.45, 0.5, 0.55])
    for (const wrong of [0.45, 0.5, 0.55])
      for (const wrongDirect of [0.25, 0.3, 0.4, 0.5])
      for (const windowPenalty of [0.8, 0.88, 1]) {
        Object.assign(TUNING, { covered, wrong, wrongDirect, windowPenalty });
        let ok = 0, n = 0;
        for (const item of dev) {
          const res = builtinGrade(inputFor(item));
          for (const [cid, gold] of Object.entries(item.labels)) {
            n++;
            if ((res.claims.find((c) => c.claim_id === cid)?.status ?? "missing") === gold) ok++;
          }
        }
        out.push({ cfg: `covered=${covered} wrong=${wrong} wrongDirect=${wrongDirect} windowPenalty=${windowPenalty}`, acc: ok / n });
      }
  Object.assign(TUNING, base);
  out.sort((a, b) => b.acc - a.acc);
  console.log(`current: ${JSON.stringify(base)}`);
  for (const o of out.slice(0, 15)) console.log(`  dev ${(100 * o.acc).toFixed(1)}%  ${o.cfg}`);
}

async function main() {
  if (args.includes("--sweep")) return sweep();
  const runs: RunScore[] = [];
  if (engineArg !== "model") runs.push(await evaluate("built-in", async (inp) => builtinGrade(inp)));
  const prov = engineArg !== "builtin" ? modelProvider() : null;
  if (prov) {
    // Free tiers allow ~10 requests/minute: pace calls and wait out 429s so every item is graded by the model.
    const gapMs = Number(process.env.EVAL_GAP_MS ?? 6500);
    let last = 0;
    let fallbacks = 0;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const run = await evaluate(prov.name, async (inp) => {
      const p = buildGradingPrompt(inp);
      for (let i = 0; i < 6; i++) {
        await sleep(Math.max(0, last + gapMs - Date.now()));
        last = Date.now();
        try {
          const raw = await prov.call(p.system, p.user);
          return finalizeResult(gradeResponseSchema.parse(parseJson(raw)), inp);
        } catch (e) {
          const limited = /429|rate|quota|exhaust/i.test(String(e));
          if (!limited && i >= 1) break;
          if (limited) await sleep(15000 * (i + 1));
        }
      }
      fallbacks++;
      console.warn("  model call did not complete; built-in engine used for this item");
      return builtinGrade(inp);
    });
    if (fallbacks) {
      console.log(`
${fallbacks} item(s) used the built-in engine, so this model row is printed but not recorded.`);
    } else runs.push(run);
  } else if (engineArg !== "builtin") console.log("\n(no AI key set: model grader row skipped)");
  if (!args.includes("--no-write") && runs.length) writeResults(runs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
