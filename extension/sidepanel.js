// Samjha side panel: capture -> explain (Wispr dictation, auto-send after a pause) -> grade -> buddy (read aloud) -> explain back.
const AUTO_SUBMIT_MS = 1500;
const MIN_WORDS = 8;
const ICON = { covered: "✓", wrong: "✗", missing: "○" };
const LABEL = { covered: "Covered", wrong: "Wrong", missing: "Missing" };

const $ = (id) => document.getElementById(id);
const state = {
  handled: null, // id of the last capture we processed
  payload: null,
  topicId: null,
  topicName: "",
  claims: new Map(),
  attemptId: null,
  phase: "idle", // idle | explain | grading | buddy | explain_back | done
  timer: null,
  buddyAbort: null,
};

// ---------- API ----------
async function api(path, body, { stream = false, signal } = {}) {
  const { url, token } = await getSamjhaConfig();
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url + path, { method: body ? "POST" : "GET", credentials: "include", headers, body: body ? JSON.stringify(body) : undefined, signal });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error(`Can't reach Samjha at ${url}. Is it running? Check the URL in the extension options.`);
  }
  if (res.status === 401) {
    const err = new Error("Not signed in");
    err.auth = true;
    throw err;
  }
  if (stream) {
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error || "The buddy couldn't answer.");
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Samjha returned ${res.status}.`);
  return data;
}

// ---------- views ----------
function show(view) {
  for (const v of ["idle", "busy", "auth", "session"]) $(`v-${v}`).hidden = v !== view;
}
function setError(msg) {
  $("error").textContent = msg || "";
  $("error").hidden = !msg;
}
function busy(text) {
  $("busyText").textContent = text;
  show("busy");
}
function setPhase(p) {
  state.phase = p;
  const writing = p === "explain" || p === "explain_back";
  $("explainBox").hidden = !writing;
  $("grading").hidden = p !== "grading";
  $("buddyBox").hidden = p !== "buddy";
  $("doneMsg").hidden = p !== "done";
  if (writing) {
    $("explainLabel").textContent =
      p === "explain"
        ? `Explain ${state.topicName} like you're teaching a junior. Dictate with Wispr — I send after a ${AUTO_SUBMIT_MS / 1000}s pause.`
        : "Now explain it back to me.";
    $("explain").value = "";
    $("explain").focus();
  }
}

// ---------- speech ----------
function splitSentences(t) {
  return (t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").match(/[^.!?\n]+[.!?]*/g) || []).map((s) => s.trim()).filter(Boolean);
}
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  for (const s of splitSentences(text)) speechSynthesis.speak(new SpeechSynthesisUtterance(s));
}
function stopSpeech() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}
const stripLinks = (t) => t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

// ---------- flow ----------
async function refreshWho() {
  try {
    const me = await api("/api/ext/me");
    $("who").textContent = me.signedIn ? `· ${me.name}` : "";
    return me.signedIn;
  } catch {
    $("who").textContent = "";
    return false;
  }
}

async function handlePending(pending) {
  if (!pending || pending.id === state.handled) return;
  setError("");
  if (pending.status === "reading") return busy("Reading your selection…");
  state.handled = pending.id;
  if (pending.status === "error") {
    show("idle");
    return setError(pending.payload?.error || "Couldn't read the page.");
  }
  state.payload = pending.payload;
  await sendCapture();
}

async function sendCapture() {
  const p = state.payload;
  if (!p) return show("idle");
  busy(p.text ? "Adding this to Samjha…" : "Fetching the PDF and reading it… this can take a few seconds.");
  stopSpeech();
  try {
    const data = await api("/api/ext/capture", p);
    state.topicId = data.topicId;
    state.topicName = data.topicName || "this";
    state.claims = new Map((data.claims || []).map((c) => [c.id, c]));
    state.attemptId = null;
    $("topicName").textContent = state.topicName;
    $("capturedText").textContent = p.text ? p.text.slice(0, 2000) : `PDF: ${p.title || p.url}`;
    $("results").hidden = true;
    const { url } = await getSamjhaConfig();
    $("openFull").href = data.panelUrl || `${url}/ext/panel?topicId=${encodeURIComponent(data.topicId)}`;
    $("openFull").hidden = false;
    show("session");
    setPhase("explain");
    speak(`Explain ${state.topicName} like you're teaching a junior. Take your time.`);
  } catch (e) {
    if (e.auth) return show("auth");
    show("idle");
    setError(e.message);
  }
}

async function submit() {
  clearTimeout(state.timer);
  const explanation = $("explain").value.trim();
  if (!explanation || state.phase === "grading" || !state.topicId) return;
  const kind = state.phase === "explain_back" ? "explain_back" : "explain";
  stopSpeech();
  setError("");
  setPhase("grading");
  try {
    const data = await api("/api/ext/grade", {
      topicId: state.topicId,
      explanation,
      kind,
      parentAttemptId: kind === "explain_back" ? state.attemptId || undefined : undefined,
      afterBuddy: kind === "explain_back",
    });
    for (const c of data.claims || []) state.claims.set(c.id, c);
    state.attemptId = data.attemptId;
    renderGrades(data.result);
    const total = data.result.claims.length;
    const gaps = data.result.claims.filter((c) => c.status !== "covered").length;
    if (!gaps) {
      setPhase("done");
      speak(total ? "Every point covered. Nice work." : "Saved.");
    } else {
      speak(`You covered ${total - gaps} of ${total}. Let me explain the rest.`);
      runBuddy("gaps");
    }
  } catch (e) {
    if (e.auth) return show("auth");
    setPhase(kind);
    $("explain").value = explanation;
    setError(e.message);
  }
}

function renderGrades(result) {
  const list = $("gradeList");
  list.replaceChildren();
  for (const g of result.claims) {
    const li = document.createElement("li");
    li.className = g.status;
    const head = document.createElement("strong");
    head.textContent = `${ICON[g.status]} ${LABEL[g.status]}: `;
    li.append(head, document.createTextNode(state.claims.get(g.claim_id)?.text || ""));
    if (g.status !== "covered" && g.correction) {
      const fix = document.createElement("span");
      fix.className = "fix";
      fix.textContent = g.correction;
      li.append(fix);
    }
    list.append(li);
  }
  const misc = $("miscList");
  misc.replaceChildren();
  for (const m of result.misconceptions || []) {
    const li = document.createElement("li");
    li.textContent = `✗ “${m.quote}” → ${m.correction}`;
    misc.append(li);
  }
  $("results").hidden = false;
}

async function runBuddy(mode) {
  if (!state.attemptId) return;
  stopSpeech();
  state.buddyAbort?.abort();
  const ctrl = new AbortController();
  state.buddyAbort = ctrl;
  setPhase("buddy");
  setError("");
  const out = $("buddyText");
  out.textContent = "Thinking…";
  try {
    const res = await api("/api/ext/buddy", { topicId: state.topicId, attemptId: state.attemptId, mode }, { stream: true, signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let full = "";
    let spoken = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      full += dec.decode(value, { stream: true });
      out.textContent = stripLinks(full);
      const sentences = splitSentences(full);
      const complete = /[.!?\n]\s*$/.test(full) ? sentences.length : sentences.length - 1;
      if (complete > spoken) {
        speak(sentences.slice(spoken, complete).join(" "));
        spoken = complete;
      }
    }
    const rest = splitSentences(full).slice(spoken).join(" ");
    if (rest) speak(rest);
  } catch (e) {
    if (e.name === "AbortError") return;
    if (e.auth) return show("auth");
    setError(e.message);
  }
}

// ---------- events ----------
$("explain").addEventListener("input", () => {
  stopSpeech();
  clearTimeout(state.timer);
  const words = $("explain").value.trim().split(/\s+/).filter(Boolean).length;
  if (words >= MIN_WORDS) state.timer = setTimeout(submit, AUTO_SUBMIT_MS);
});
$("explain").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
});
$("btnSend").addEventListener("click", submit);
$("btnStop").addEventListener("click", stopSpeech);
$("btnBack").addEventListener("click", () => {
  stopSpeech();
  state.buddyAbort?.abort();
  setPhase("explain_back");
  speak("Now explain it back to me.");
});
document.querySelectorAll("#buddyBox [data-mode]").forEach((b) => b.addEventListener("click", () => runBuddy(b.dataset.mode)));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") stopSpeech();
});

$("btnSignIn").addEventListener("click", async () => {
  const { url } = await getSamjhaConfig();
  chrome.tabs.create({ url: `${url}/login?next=${encodeURIComponent("/ext/connect?ext=" + chrome.runtime.id)}` });
});
$("btnConnect").addEventListener("click", async () => {
  const { url } = await getSamjhaConfig();
  chrome.tabs.create({ url: `${url}/ext/connect?ext=${chrome.runtime.id}` });
});
$("btnRetry").addEventListener("click", async () => {
  if (await refreshWho()) state.payload ? sendCapture() : show("idle");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.pending) handlePending(changes.pending.newValue);
  if (area === "local" && (changes.samjhaToken || changes.samjhaUrl)) {
    refreshWho().then((ok) => {
      if (ok && !$("v-auth").hidden) state.payload ? sendCapture() : show("idle");
    });
  }
});

(async function init() {
  refreshWho();
  const { pending } = await chrome.storage.session.get("pending");
  if (pending && Date.now() - (pending.at || 0) < 5 * 60 * 1000) handlePending(pending);
  else show("idle");
})();
