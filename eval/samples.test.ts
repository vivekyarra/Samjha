// Regression test: every hand-written suggested explanation in the sample workspace must grade as exactly
// 1 wrong + 2 missing with the built-in engine (the promise made in src/lib/demo/content.ts).
// Run: npx tsx eval/samples.test.ts   (exit code 1 on failure)
import { DEMO_PAGES, DEMO_SUGGESTED_EXPLANATION, DEMO_TOPICS } from "../src/lib/demo/content";
import { GRADER_VERSION, builtinGrade, type GradeInput } from "../src/lib/grading/core";

let failures = 0;
const names = Object.keys(DEMO_SUGGESTED_EXPLANATION);
if (!names.length) {
  console.error("No suggested explanations found in src/lib/demo/content.ts");
  process.exit(1);
}

for (const name of names) {
  const topic = DEMO_TOPICS.find((t) => t.name === name);
  if (!topic) {
    console.error(`FAIL ${name}: no matching topic in DEMO_TOPICS`);
    failures++;
    continue;
  }
  const claims = topic.claims.map((c, i) => ({ id: `${topic.key}${i + 1}`, text: c.text, page: c.page }));
  const pages = [...new Set(topic.claims.map((c) => c.page))];
  const input: GradeInput = {
    topic: topic.name,
    claims,
    chunks: pages.map((p) => ({ text: DEMO_PAGES[p - 1] ?? "", page: p })).filter((c) => c.text),
    explanation: DEMO_SUGGESTED_EXPLANATION[name],
  };
  const res = builtinGrade(input);
  const count = (s: string) => res.claims.filter((c) => c.status === s).length;
  const ok = count("wrong") === 1 && count("missing") === 2;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: covered ${count("covered")}, missing ${count("missing")}, wrong ${count("wrong")}`);
  for (const c of res.claims.filter((x) => x.status === "wrong"))
    console.log(`   wrong: ${claims.find((x) => x.id === c.claim_id)?.text.slice(0, 70)}  «${c.evidence.slice(0, 60)}»`);
  if (!ok) {
    for (const c of res.claims) {
      const text = claims.find((x) => x.id === c.claim_id)?.text ?? "";
      console.log(`   ${c.status.padEnd(7)} ${text.slice(0, 80)}${c.evidence ? `  «${c.evidence.slice(0, 70)}»` : ""}`);
    }
  }
}

console.log(`\n${GRADER_VERSION}: ${names.length - failures}/${names.length} sample explanations grade as 1 wrong + 2 missing.`);
process.exit(failures ? 1 : 0);
