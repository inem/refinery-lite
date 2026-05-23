# Refinery Lite

Chrome extension. Auto-saves every ChatGPT conversation you open to **dopo.st**
as markdown — one post per chat, dedup on content (no duplicates).

## Install

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder
2. Click the action icon → paste your dopo owner token (and URL if not dopo.st)
3. Open any ChatGPT chat — it syncs.
   - Synced chats get a green **✓** in the sidebar.
   - Header **↗ dopo** button opens the latest snapshot of the current chat.

## Files

- `manifest.json` — MV3
- `tap.js` — MAIN-world. Patches `window.fetch`, intercepts
  `/backend-api/conversation/<uuid>`, emits the conversation JSON via
  `window.postMessage`. Passive — returns the original response untouched.
- `bridge.js` — ISOLATED-world. Relays to the background worker, drives the
  inline header status, the `↗ dopo` button, and the sidebar **✓** badges.
- `background.js` — service worker. Converts to markdown, dedups on a
  content signature (message ids + text — immune to server-side
  timestamp drift), POSTs `POST /` to dopo.st with
  `Authorization: Bearer <token>`. Returns `{url}` to the bridge.
- `convert.js` — pure conversation → markdown converter. `importScripts`'d
  by `background.js`; also runnable under node for tests against captured
  conversations.
- `chatgpt-ui.js` — UI helper library. Vendored from
  <https://github.com/inem/chathpt-ui.js>.
- `popup.html` / `popup.js` — settings UI (token + dopo URL).

## How the markdown looks

A YAML frontmatter (`kind: chatgpt-session`, `session-id`, `title`, `url`,
`created`, `updated`) followed by `# title`, a metablock, then alternating
`## Prompt:` / `## Response:` sections with per-message timestamps. The
`session-id` lets dopo collapse re-uploads of one chat into a single
snapshot history (once dopo knows about `chatgpt-session` as a kind).

## Design

The triple-based design crystal lives in the [`onto`][onto] repo under
`worlds/refinery-lite-001/`.

[onto]: https://github.com/inem/onto
