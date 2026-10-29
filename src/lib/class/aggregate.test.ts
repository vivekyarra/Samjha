// Run: npx tsx src/lib/class/aggregate.test.ts
import assert from "node:assert/strict";
import { anonymise, buildClassHeatmap, containsAny, fallbackMisconception, pickMostMisunderstood, type ClaimCount, type TopicCount } from "./aggregate";

// Raw per-student rows (what lives in attempts / claim_cards / claim_results).
const students = Array.from({ length: 7 }, (_, i) => ({ id: `u_secret${i}abc`, name: `Student${i} Kumarappa` }));
const topics = [
  { id: "t_gd", name: "Gradient Descent", position: 0 },
  { id: "t_bp", name: "Backpropagation", position: 1 },
  { id: "t_none", name: "Overfitting", position: 2 },
];
const claims = [
  { id: "c_gd1", topic_id: "t_gd", text: "Learning rate sets step size", source_id: "s1", page: 3, position: 0 },
  { id: "c_gd2", topic_id: "t_gd", text: "Steps go against the gradient", source_id: "s1", page: 4, position: 1 },
  { id: "c_bp1", topic_id: "t_bp", text: "Uses the chain rule", source_id: "s1", page: 9, position: 0 },
];
const attempts = [
  ...students.slice(0, 6).map((s) => ({ user: s.id, topic: "t_gd" })),
  ...students.slice(0, 4).map((s) => ({ user: s.id, topic: "t_bp" })),
  { user: students[0].id, topic: "t_gd" }, // repeat attempt must not double count
];
const greenCards = [
  ...students.slice(0, 3).map((s) => ({ user: s.id, claim: "c_gd1" })),
  ...students.slice(0, 6).map((s) => ({ user: s.id, claim: "c_gd2" })),
  ...students.slice(0, 4).map((s) => ({ user: s.id, claim: "c_bp1" })),
];
const wrongs = [
  ...students.slice(3, 6).map((s) => ({ user: s.id, claim: "c_gd1" })),
  { user: students[3].id, claim: "c_gd1" },
  ...students.slice(0, 4).map((s) => ({ user: s.id, claim: "c_bp1" })),
];

// Equivalent of the aggregate SQL: COUNT(DISTINCT user_id) GROUP BY key. Only counts leave this step.
const distinct = <T extends { user: string }>(rows: T[], key: (r: T) => string) => {
  const m = new Map<string, Set<string>>();
  for (const r of rows) (m.get(key(r)) ?? m.set(key(r), new Set()).get(key(r))!).add(r.user);
  return m;
};
const topicCounts: TopicCount[] = [...distinct(attempts, (a) => a.topic)].map(([topic_id, s]) => ({ topic_id, attempted: s.size }));
const g = distinct(greenCards, (c) => c.claim);
const w = distinct(wrongs, (c) => c.claim);
const claimCounts: ClaimCount[] = claims.map((c) => ({
  claim_id: c.id,
  green: g.get(c.id)?.size ?? 0,
  wrong: w.get(c.id)?.size ?? 0,
  wrong_marks: wrongs.filter((x) => x.claim === c.id).length,
}));

const hm = buildClassHeatmap({ subjectId: "sub1", subjectName: "ML", students: students.length, topics, claims, topicCounts, claimCounts });

// 1. Topic with 6 distinct students is shown, with aggregate shares.
const gd = hm.topics.find((t) => t.topicId === "t_gd")!;
assert.equal(gd.attempted, 6);
assert.equal(gd.suppressed, false);
assert.equal(gd.claims[0].green, 3);
assert.equal(gd.claims[0].greenShare, 0.5);
assert.equal(gd.claims[1].greenShare, 1);
assert.equal(gd.greenShare, 0.75);
assert.equal(gd.colour, "green");

// 2. Topic with 4 students (<5) is suppressed: no shares, no counts per claim, no colour.
const bp = hm.topics.find((t) => t.topicId === "t_bp")!;
assert.equal(bp.suppressed, true);
assert.equal(bp.attempted, 4);
assert.equal(bp.greenShare, null);
assert.equal(bp.colour, null);
for (const c of bp.claims) {
  assert.equal(c.green, null);
  assert.equal(c.greenShare, null);
  assert.equal(c.wrong, null);
}
const none = hm.topics.find((t) => t.topicId === "t_none")!;
assert.equal(none.suppressed, true);
assert.equal(none.attempted, 0);

// 3. Boundary: exactly 5 is shown, 4 is not.
const at5 = buildClassHeatmap({ subjectId: "s", subjectName: "x", students: 5, topics: [topics[0]], claims: [claims[0]], topicCounts: [{ topic_id: "t_gd", attempted: 5 }], claimCounts: [] });
assert.equal(at5.topics[0].suppressed, false);
const at4 = buildClassHeatmap({ subjectId: "s", subjectName: "x", students: 5, topics: [topics[0]], claims: [claims[0]], topicCounts: [{ topic_id: "t_gd", attempted: 4 }], claimCounts: [{ claim_id: "c_gd1", green: 4, wrong: 4 }] });
assert.equal(at4.topics[0].suppressed, true);
assert.equal(at4.topics[0].claims[0].green, null);

// 4. Most misunderstood ignores suppressed topics (c_bp1 has 4 wrong but topic has only 4 students).
const mm = pickMostMisunderstood(hm, claimCounts, 5);
assert.deepEqual(mm.map((m) => m.claimId), ["c_gd1"]);
assert.equal(mm[0].wrong, 3);

// 5. No user ids or names anywhere in the output.
const secrets = students.flatMap((s) => [s.id, s.name, s.name.split(" ")[0]]);
const blob = JSON.stringify({ hm, mm });
assert.equal(containsAny(blob, secrets), null, "output leaked an identifier");
for (const k of ["user", "user_id", "userId", "name\":\"Student"]) assert.ok(!blob.includes(k), `output contains ${k}`);

// 6. Anonymiser strips names, emails, handles, numbers.
const dirty = "Student3 said (ask student3 kumarappa, mail s3@uni.edu, @s3, +91 98765 43210) the rate is the gradient";
const clean = anonymise(dirty, students.map((s) => s.name));
assert.equal(containsAny(clean.toLowerCase(), ["student3", "kumarappa", "s3@uni.edu", "@s3", "98765"]), null, clean);

// 7. Fallback misconception: quotes only phrases shared by 3+ students, never names.
const s1 = fallbackMisconception("Learning rate sets step size", [{ text: "Actually, the learning rate sets the step size.", n: 3 }], [{ text: "Student1 thinks it is the gradient", n: 1 }], students.map((s) => s.name));
assert.equal(s1, "Many students get this wrong; the notes say the learning rate sets the step size.");
const s2 = fallbackMisconception("x", [{ text: "The learning rate sets the step size", n: 3 }], [{ text: "learning rate is the gradient", n: 3 }], []);
assert.equal(s2, 'Many students think "learning rate is the gradient"; the notes say the learning rate sets the step size.');

console.log("class aggregate: all privacy tests passed");
