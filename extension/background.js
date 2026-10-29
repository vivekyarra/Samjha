// Samjha service worker: context menu / toolbar button / Ctrl+Shift+Y -> read the selection -> open the side panel.
importScripts("config.js");

const MENU_SELECTION = "samjha-teach-selection";
const MENU_PAGE = "samjha-teach-page";
const MAX_PDF = 20 * 1024 * 1024;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_SELECTION, title: "Teach this back with Samjha", contexts: ["selection"] });
    chrome.contextMenus.create({ id: MENU_PAGE, title: "Teach this page back with Samjha", contexts: ["page", "frame"] });
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

// sidePanel.open must run synchronously inside the user gesture, before any await.
function openPanel(tab) {
  const p = tab && tab.id != null ? chrome.sidePanel.open({ tabId: tab.id }) : tab ? chrome.sidePanel.open({ windowId: tab.windowId }) : null;
  if (p) p.catch((e) => console.warn("[samjha] side panel", e));
}

chrome.action.onClicked.addListener((tab) => {
  openPanel(tab);
  capture(tab, "");
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "teach-this-back") return;
  if (tab) {
    openPanel(tab);
    capture(tab, "");
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }, ([t]) => t && capture(t, ""));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  openPanel(tab);
  // In Chrome's PDF viewer scripting can't run, but the menu still hands us the selection.
  const t = tab || { url: info.pageUrl, title: "" };
  if (!t.url) t.url = info.frameUrl || info.pageUrl;
  capture(t, info.menuItemId === MENU_SELECTION ? info.selectionText || "" : "");
});

// The Samjha /ext/connect page hands us the extension token (only from the configured Samjha origin).
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "samjha-token" || typeof msg.token !== "string") return;
  getSamjhaConfig().then(async ({ url }) => {
    const origin = sender.origin || (sender.url ? new URL(sender.url).origin : "");
    if (origin !== url) return sendResponse(false);
    await chrome.storage.local.set({ samjhaToken: msg.token, samjhaName: msg.name || "" });
    sendResponse(true);
  });
  return true;
});

async function capture(tab, selectionText) {
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ pending: { id, status: "reading", at: Date.now() } });
  let payload;
  try {
    payload = await readTab(tab, selectionText);
  } catch (e) {
    payload = { error: e && e.message ? e.message : String(e) };
  }
  await chrome.storage.session.set({ pending: { id, status: payload.error ? "error" : "ready", at: Date.now(), payload } });
}

const isPdfUrl = (u) => /\.pdf($|[?#])/i.test(u || "");

async function readTab(tab, selectionText) {
  const url = tab.url || "";
  let title = tab.title || "";
  let text = (selectionText || "").trim();
  let pdf = isPdfUrl(url);
  let slideText = "";

  if (!text && tab.id != null) {
    try {
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: grabSelection });
      for (const r of results || []) {
        const v = r && r.result;
        if (!v) continue;
        if (v.text && v.text.length > text.length) text = v.text;
        if (v.top) {
          if (v.contentType === "application/pdf") pdf = true;
          if (v.slideText) slideText = v.slideText;
          if (v.title) title = v.title;
        }
      }
    } catch (e) {
      // Chrome's PDF viewer, chrome:// pages and the Web Store block scripting.
      console.info("[samjha] scripting unavailable", e && e.message);
    }
  }

  title = title.replace(/\s+-\s+Google (Slides|Docs|Classroom)$/, "").trim();
  if (!text && slideText) text = `${title}\n${slideText}`;
  if (text) return { text: text.slice(0, 200000), url, title };

  if (pdf || isPdfUrl(url)) {
    if (url.startsWith("file:")) return { pdfBase64: await readLocalPdf(url), url, title };
    if (/^https?:/.test(url)) return { pdfUrl: url, url, title };
  }
  throw new Error("Select some text on the page first (or open a PDF), then press Teach this back.");
}

async function readLocalPdf(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("To use local PDFs, turn on \"Allow access to file URLs\" for Samjha in chrome://extensions. Or select the text and use the right-click menu.");
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_PDF) throw new Error("That PDF is over 20 MB. Select the part you want instead.");
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Runs inside each frame of the page.
function grabSelection() {
  let text = String(window.getSelection ? window.getSelection() : "").trim();
  const el = document.activeElement;
  if (!text && el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type === "text")) && el.selectionEnd > el.selectionStart) {
    text = el.value.slice(el.selectionStart, el.selectionEnd).trim();
  }
  const top = window === window.top;
  const out = { text, top, contentType: document.contentType, title: top ? document.title : "" };
  if (top && location.hostname === "docs.google.com" && location.pathname.startsWith("/presentation")) {
    // Google Slides draws slides as SVG. Prefer the presenting/editing canvas, skip the thumbnail filmstrip.
    const roots = document.querySelectorAll(".punch-viewer-svgpage-svgcontainer, .punch-present-iframe, #workspace-container, #pages, .sketchy-page-content");
    const nodes = [];
    roots.forEach((r) => r.querySelectorAll("svg text").forEach((n) => nodes.push(n)));
    if (!nodes.length) document.querySelectorAll("svg text").forEach((n) => { if (!n.closest(".punch-filmstrip")) nodes.push(n); });
    const seen = new Set();
    const lines = [];
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.top > innerHeight) continue;
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (t && !seen.has(t)) { seen.add(t); lines.push(t); }
    }
    out.slideText = lines.join("\n").slice(0, 20000);
  }
  return out;
}
