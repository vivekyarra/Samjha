# Samjha — Teach this back (Chrome extension)

Select text on any lecture slide, PDF or course page and explain it back to Samjha by voice, right in Chrome's side panel.

## Install (developer mode)
1. Start Samjha (`npm run dev`, default http://localhost:3000) and sign in (or open `/demo`).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick this `extension/` folder.
3. Open the extension's **Options** (right-click the Samjha icon → Options):
   - Set **Samjha URL** if it isn't `http://localhost:3000`.
   - Click **Connect extension**. On localhost the key is handed over automatically; otherwise copy the key from the page and paste it into **Extension key**.
   - **Test connection** should say "Connected as …".
4. Optional: for PDFs opened from your disk, enable **Allow access to file URLs** on the extension's card.

## Use
- Select text and press **Ctrl+Shift+Y** (**⌘⇧Y** on Mac), click the toolbar button, or right-click → **Teach this back with Samjha**.
- The side panel adds the selection to your **From the web** subject (with a link back to the page), then asks you to explain it. Dictate with Wispr; it sends after a 1.5 s pause (or press Send / Ctrl+Enter).
- You get ✓ Covered / ✗ Wrong / ○ Missing per point, then the buddy explains only your gaps out loud. Hit **Explain it back** to close the loop. Esc stops the voice.

| Where | How it reads content |
|---|---|
| Normal pages, Moodle, Google Classroom | Your text selection (all frames, incl. embedded iframes) |
| Google Slides | Your selection; if nothing is selected, the deck title + visible text of the current slide |
| PDFs in Chrome's viewer | Right-click a selection → menu item. With no selection, the PDF link is sent and Samjha downloads and reads the whole PDF (≤ 20 MB) |
| Local `file://` PDFs | The extension reads the file (needs "Allow access to file URLs") |

## How auth works
Requests go to `/api/ext/*` with `credentials: "include"` **and** `Authorization: Bearer <key>`. The key is an HMAC of your user id
(signed with `SAMJHA_SECRET`), shown at `/ext/connect`. The server only allows CORS from `chrome-extension://` origins.

## Files
`manifest.json` (MV3) · `background.js` (menu, shortcut, selection capture) · `sidepanel.html/js` (explain → grade → buddy loop) ·
`options.html/js` · `config.js` · `icons/` (regenerate with `node extension/scripts/make-icons.mjs`).
A web version of the panel lives at `/ext/panel?topicId=…` in the app.
