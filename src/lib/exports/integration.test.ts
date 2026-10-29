// End-to-end check on a temp DB: npx tsx --conditions=react-server src/lib/exports/integration.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.SAMJHA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "samjha-integration-"));

async function main() {
  const { run, newId, now, get } = await import("@/lib/db");
  const { getSettings, saveSettings } = await import("@/lib/settings");
  const nudges = await import("@/lib/nudges");
  const { buildSubjectApkg } = await import("@/lib/exports/anki");
  const { gapsPdfForUser, loadGaps } = await import("@/lib/exports/gaps");
  const { buildTranscript } = await import("@/lib/exports/transcript");

  const uid = newId("u_");
  await run("INSERT INTO users (id,name,email,created_at) VALUES (?,?,?,?)", uid, "Asha", "asha@example.com", now());
  assert.equal((await getSettings(uid)).autoSubmitMs, 1500);
  await saveSettings(uid, { voiceRate: 1.3, nudges: { timezone: "UTC", quietStart: "00:00", quietEnd: "00:00" } });
  assert.equal((await getSettings(uid)).voiceRate, 1.3);
  assert.equal((await getSettings(uid)).nudges.frequency, "daily");
  await assert.rejects(() => saveSettings(uid, { autoSubmitMs: 100 }));

  const sid = newId("s_"), tid = newId("t_"), src = newId("src_");
  await run("INSERT INTO subjects (id,owner_id,name,exam_date,created_at) VALUES (?,?,?,?,?)", sid, uid, "Intro to ML", null, now());
  await run("INSERT INTO subject_members (subject_id,user_id,role) VALUES (?,?,?)", sid, uid, "owner");
  await run("INSERT INTO sources (id,subject_id,file_name,created_at) VALUES (?,?,?,?)", src, sid, "ml-notes.pdf", now());
  await run("INSERT INTO topics (id,subject_id,name) VALUES (?,?,?)", tid, sid, "Gradient Descent");
  const claims = ["Gradient descent is an iterative optimisation algorithm.", "The learning rate controls the step size.", "Too high a learning rate makes training diverge."];
  const cids: string[] = [];
  for (const [i, text] of claims.entries()) {
    const id = newId("c_");
    await run("INSERT INTO claims (id,topic_id,text,source_id,page,position) VALUES (?,?,?,?,?,?)", id, tid, text, src, i + 2, i);
    cids.push(id);
  }
  const aid = newId("a_");
  await run("INSERT INTO attempts (id,user_id,topic_id,kind,transcript,created_at) VALUES (?,?,?,?,?,?)", aid, uid, tid, "explain", "It goes up the gradient.", now());
  await run("INSERT INTO claim_results (id,attempt_id,claim_id,status,evidence,correction) VALUES (?,?,?,?,?,?)", newId(), aid, cids[0], "wrong", "goes up", "It steps against the gradient.");
  await run("INSERT INTO buddy_messages (id,attempt_id,role,text,created_at) VALUES (?,?,?,?,?)", newId(), aid, "buddy", "Walk downhill: step against the slope [p.2](/sources/x?page=2). Now explain it back to me.", now());
  const past = new Date(Date.now() - 3600_000).toISOString();
  await run("INSERT INTO claim_cards (user_id,claim_id,due_at,mastery) VALUES (?,?,?,?)", uid, cids[1], past, "green");
  await run("INSERT INTO claim_cards (user_id,claim_id,due_at,mastery) VALUES (?,?,?,?)", uid, cids[0], null, "red");

  const c = await nudges.computeNudge(uid, new Date());
  assert.equal(c.shouldSend, true, c.reason);
  assert.equal(c.body, "1 concept due, about 2 minutes.");
  const sent = await nudges.sendNudge(uid);
  assert.equal(sent.nudges.length, 1);
  assert.equal(sent.nudges[0].status, "in_app");
  assert.match(sent.nudges[0].link!, /^\/api\/nudges\/open\?n=n_\w+&to=%2Freview%3Ffrom%3Dnudge%26n%3Dn_/);
  assert.equal((await nudges.computeNudge(uid, new Date())).shouldSend, false, "frequency respected");
  assert.ok(await nudges.markOpened(sent.nudges[0].id));
  assert.ok((await get<{ opened_at: string }>("SELECT opened_at FROM nudges WHERE id=?", sent.nudges[0].id))!.opened_at);
  const tok = nudges.unsubscribeToken(uid);
  assert.equal(await nudges.unsubscribe(tok + "x"), null);
  assert.equal((await nudges.unsubscribe(tok))!.name, "Asha");
  assert.equal((await getSettings(uid)).nudges.frequency, "off");
  console.log("ok - settings + nudges");

  const apkg = await buildSubjectApkg(sid);
  assert.equal(apkg.cards, 3);
  assert.equal(apkg.fileName, "Intro-to-ML.apkg");
  const g = await loadGaps(uid, sid);
  assert.equal(g.topics.length, 1);
  assert.deepEqual(g.topics[0].claims.map((x) => x.mastery).sort(), ["amber", "red", "red"]);
  assert.match(g.topics[0].explanation!, /^Walk downhill: step against the slope p\.2\.$/);
  const pdf = await gapsPdfForUser(uid, "Asha", [sid]);
  fs.writeFileSync(path.join(os.tmpdir(), "samjha-gaps-integration.pdf"), pdf);
  const t = await buildTranscript(aid);
  assert.match(t.markdown, /Gradient Descent — Samjha session transcript/);
  assert.match(t.markdown, /\*\*Wrong:\*\* Gradient descent is an iterative/);
  assert.match(t.markdown, /\*\*Buddy\*\*: Walk downhill/);
  console.log("ok - exports", g.topics[0].claims.map((x) => x.mastery).join(","));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
