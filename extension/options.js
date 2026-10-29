const $ = (id) => document.getElementById(id);
const status = (t) => ($("status").textContent = t);

(async () => {
  const { url, token } = await getSamjhaConfig();
  $("url").value = url;
  $("token").value = token;
})();

async function save() {
  const url = normaliseSamjhaUrl($("url").value);
  const prev = await getSamjhaConfig();
  const token = $("token").value.trim();
  // The key belongs to one Samjha server; drop it if the URL changed and the key wasn't edited.
  const keepToken = url === prev.url || token !== prev.token ? token : "";
  await chrome.storage.local.set({ samjhaUrl: url, samjhaToken: keepToken });
  $("url").value = url;
  $("token").value = keepToken;
  return url;
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await save();
  status("Saved.");
});

$("connect").addEventListener("click", async () => {
  const url = await save();
  chrome.tabs.create({ url: `${url}/ext/connect?ext=${chrome.runtime.id}` });
  status("Sign in on the Samjha tab. If it can't connect automatically, copy the key there and paste it here.");
});

$("test").addEventListener("click", async () => {
  await save();
  const { url, token } = await getSamjhaConfig();
  status("Testing…");
  try {
    const res = await fetch(`${url}/api/ext/me`, { credentials: "include", headers: token ? { authorization: `Bearer ${token}` } : {} });
    const me = await res.json();
    status(me.signedIn ? `✓ Connected as ${me.name}.` : "Samjha is reachable, but you're not signed in. Use Connect extension.");
  } catch {
    status(`✗ Can't reach ${url}. Is Samjha running?`);
  }
});

chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && c.samjhaToken) {
    $("token").value = c.samjhaToken.newValue || "";
    if (c.samjhaToken.newValue) status("✓ Extension connected.");
  }
});
