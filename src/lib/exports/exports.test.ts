// Run: npx tsx src/lib/exports/exports.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { buildApkg, fieldChecksum } from "./apkg";
import { heuristicQuestion } from "./questions";
import { buildGapsPdf, GAPS_TITLE } from "./gapsPdf";
import { PDFDocument } from "pdf-lib";

async function main() {
  // Questions
  assert.equal(heuristicQuestion("Gradient descent is an optimisation algorithm that follows the negative gradient."), "What is Gradient descent?");
  assert.equal(heuristicQuestion("The learning rate controls the step size."), "What does learning rate control?");
  assert.equal(heuristicQuestion("Overfitting leads to poor generalisation."), "What does Overfitting lead to?");
  assert.equal(heuristicQuestion("Regularisation is used to reduce overfitting."), "What is Regularisation used for?");
  assert.match(heuristicQuestion("If the learning rate is too high, training diverges."), /^What happens if the learning rate is too high\?$/);
  assert.match(heuristicQuestion("Backprop applies the chain rule layer by layer, from output to input", "Backprop"), /\?|why:/);
  console.log("ok - heuristic questions");

  // Anki package
  const cards = [
    { front: "What is Gradient descent?", back: "Gradient descent follows the negative gradient.<br><span class=cite>(notes.pdf, p.3)</span>", key: "c1", tags: ["Gradient Descent"] },
    { front: "What does learning rate control?", back: "The learning rate controls the step size.", key: "c2" },
  ];
  const apkg = await buildApkg("Samjha::Intro to ML", cards, 1_760_000_000_000);
  const zip = await JSZip.loadAsync(apkg);
  assert.deepEqual(Object.keys(zip.files).sort(), ["collection.anki2", "media"]);
  assert.equal(await zip.file("media")!.async("string"), "{}");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "samjha-apkg-test-"));
  const file = path.join(dir, "collection.anki2");
  fs.writeFileSync(file, await zip.file("collection.anki2")!.async("nodebuffer"));
  const db = new DatabaseSync(file);
  try {
    const col = db.prepare("SELECT * FROM col").get() as Record<string, unknown>;
    assert.equal(Number(col.ver), 11);
    const models = JSON.parse(String(col.models));
    const model = Object.values(models)[0] as { flds: { name: string }[]; tmpls: unknown[]; did: number; id: number };
    assert.deepEqual(model.flds.map((f) => f.name), ["Front", "Back"]);
    const decks = JSON.parse(String(col.decks));
    assert.equal(decks[String(model.did)].name, "Samjha::Intro to ML");
    assert.ok(decks["1"], "default deck present");

    const notes = db.prepare("SELECT * FROM notes ORDER BY id").all() as Record<string, unknown>[];
    assert.equal(notes.length, 2);
    assert.equal(notes[0].flds, `${cards[0].front}\x1f${cards[0].back}`);
    assert.equal(Number(notes[0].csum), fieldChecksum(cards[0].front));
    assert.equal(Number(notes[0].mid), model.id);
    assert.equal(Number(notes[0].usn), -1);
    assert.equal(notes[0].sfld, cards[0].front);
    assert.equal(notes[0].tags, " Gradient_Descent ");
    assert.equal(typeof notes[0].guid, "string");

    const cardRows = db.prepare("SELECT * FROM cards ORDER BY due").all() as Record<string, unknown>[];
    assert.equal(cardRows.length, 2);
    assert.deepEqual(cardRows.map((c) => [Number(c.ord), Number(c.type), Number(c.queue), Number(c.due), Number(c.did)]), [
      [0, 0, 0, 1, model.did],
      [0, 0, 0, 2, model.did],
    ]);
    assert.equal(Number(cardRows[0].nid), Number(notes[0].id));
    for (const t of ["revlog", "graves"]) assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0);
    assert.equal((db.prepare("PRAGMA integrity_check").get() as Record<string, string>).integrity_check, "ok");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("ok - apkg structure (col, notes, cards, revlog, graves)");

  // Gaps PDF: one page for a normal subject, wraps long text, survives non-Latin characters.
  const claims = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`, text: `Claim ${i}: the update rule is θ ← θ − η∇L and it keeps going for a while so that the line has to wrap across the page width properly.`,
    page: i + 1, file_name: "ml-notes.pdf", mastery: (i % 2 ? "amber" : "red") as "red" | "amber", correction: i % 3 ? null : "Step against the gradient, not along it. समझा",
  }));
  const subj = { id: "s1", name: "Intro to ML", examDate: "2026-11-02", topics: [
    { id: "t1", name: "Gradient Descent", explanation: "Think of walking downhill in fog: feel the slope, step down.", claims: claims.slice(0, 6) },
    { id: "t2", name: "Backpropagation", explanation: null, claims: claims.slice(6) },
  ] };
  const bytes = await buildGapsPdf([subj, { id: "s2", name: "Physics", examDate: null, topics: [] }], "Asha");
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getTitle(), GAPS_TITLE);
  assert.equal(doc.getPageCount(), 2, "one page per subject");
  const big = await buildGapsPdf([{ ...subj, topics: Array.from({ length: 12 }, (_, i) => ({ ...subj.topics[0], id: `t${i}`, claims })) }], "Asha");
  assert.ok((await PDFDocument.load(big)).getPageCount() > 1, "overflows onto more pages when needed");
  fs.writeFileSync(path.join(os.tmpdir(), "samjha-gaps-test.pdf"), bytes);
  console.log("ok - gaps pdf");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
