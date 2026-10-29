// Shared config helpers (loaded by background.js via importScripts and by extension pages via <script>).
const SAMJHA_DEFAULT_URL = "http://localhost:3000";

function normaliseSamjhaUrl(u) {
  try {
    const url = new URL(String(u || "").trim() || SAMJHA_DEFAULT_URL);
    if (url.protocol !== "http:" && url.protocol !== "https:") return SAMJHA_DEFAULT_URL;
    return url.origin;
  } catch {
    return SAMJHA_DEFAULT_URL;
  }
}

async function getSamjhaConfig() {
  const { samjhaUrl, samjhaToken } = await chrome.storage.local.get(["samjhaUrl", "samjhaToken"]);
  return { url: normaliseSamjhaUrl(samjhaUrl), token: samjhaToken || "" };
}
