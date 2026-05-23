// Refinery Lite — ISOLATED-world bridge + UI.
//
// Relays the conversation JSON from the MAIN-world tap (window.postMessage)
// to the background worker, and drives the in-page UI via window.ChatGPTUI:
//
//   - inline status in the header: "Saving to dopo…" → "Saved → /abc123"
//   - persistent header button "↗ dopo" that opens the stored dopo URL
//     for the currently-open conversation
//   - sidebar badges, three states:
//       ✓  green  — synced and current
//       ↻  amber  — synced but advanced on the server since last sync
//                   (e.g. continued on mobile); reopen to resync
//       (nothing) — never synced

const UI = window.ChatGPTUI;

const STATUS_ID    = 'rl-status';
const BUTTON_ID    = 'rl-open';
const BADGE_OK     = '✓';
const BADGE_STALE  = '↻';
const COLOR_OK     = '#10a37f'; // green
const COLOR_STALE  = '#f59e0b'; // amber

// Tolerance for spurious update_time drift on the server (read-bookkeeping,
// etc). Real continuations bump update_time by much more than this.
const STALE_TOLERANCE_S = 30;

let currentConvId = null;

// Latest update_time per chat from the sidebar list endpoint (unix
// seconds, floor). Populated by LIST intercepts; lives in memory only.
const latestUpdate = new Map();

// ---- per-chat storage -------------------------------------------------------

function urlKey   (id) { return 'url_'           + id; }
function updateKey(id) { return 'synced_update_' + id; }

async function getSavedUrl(convId) {
  if (!convId) return null;
  const got = await chrome.storage.local.get(urlKey(convId));
  return got[urlKey(convId)] || null;
}

// ---- header button ----------------------------------------------------------

function ensureButton(url) {
  if (!UI || typeof UI.addTopHeaderButton !== 'function') return;
  const existing = document.querySelector('[data-cgq-id="' + BUTTON_ID + '"]');
  if (existing) existing.remove();
  if (!url) return;
  UI.addTopHeaderButton({
    id: BUTTON_ID,
    icon: '↗',
    label: 'dopo',
    title: 'Open this chat on dopo.st',
    onClick: () => window.open(url, '_blank'),
  });
}

async function refreshButton() {
  ensureButton(await getSavedUrl(currentConvId));
}

// ---- sidebar badges ---------------------------------------------------------

async function refreshSidebarBadges() {
  if (!UI || typeof UI.getSidebarChats !== 'function') return;

  const all = await chrome.storage.local.get(null);
  const url = {}, updated = {};
  for (const k of Object.keys(all)) {
    if (k.startsWith('url_'))                url[k.slice(4)] = all[k];
    else if (k.startsWith('synced_update_')) updated[k.slice('synced_update_'.length)] = all[k];
  }

  for (const chat of UI.getSidebarChats()) {
    const cid = chat.conversationId;
    if (!cid || !url[cid]) { UI.addChatBadge(chat.element, null); continue; }

    const stored = updated[cid];
    const live   = latestUpdate.get(cid);
    const stale  = stored != null && live != null && live > stored + STALE_TOLERANCE_S;

    UI.addChatBadge(
      chat.element,
      stale ? BADGE_STALE : BADGE_OK,
      { color: stale ? COLOR_STALE : COLOR_OK }
    );
  }
}

if (UI && typeof UI.onSidebarChange === 'function') {
  // fires once at start and on every sidebar mutation
  UI.onSidebarChange(refreshSidebarBadges, 400);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some((k) =>
        k.startsWith('url_') || k.startsWith('synced_update_'))) {
    refreshSidebarBadges();
  }
});

// ---- window messages (from MAIN tap) ---------------------------------------

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (!d || d.source !== 'refinery-lite') return;

  if (d.type === 'CONVERSATION' && d.data) {
    currentConvId = d.data.conversation_id || null;
    if (UI && UI.setInlineStatus) {
      UI.setInlineStatus('Saving to dopo…', { id: STATUS_ID });
    }
    refreshButton();
    chrome.runtime
      .sendMessage({ type: 'UPLOAD', data: d.data })
      .catch((e) => console.debug('[refinery-lite] sendMessage failed:', e.message));
    return;
  }

  if (d.type === 'LIST' && Array.isArray(d.items)) {
    for (const it of d.items) {
      const ts = Math.floor(new Date(it.update_time).getTime() / 1000);
      if (Number.isFinite(ts)) latestUpdate.set(it.id, ts);
    }
    refreshSidebarBadges();
    return;
  }
});

// ---- runtime messages (from background) ------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'UPLOAD_DONE') return;
  if (msg.convId && currentConvId && msg.convId !== currentConvId) return;

  if (msg.error) {
    if (UI && UI.updateInlineStatus) UI.updateInlineStatus(STATUS_ID, 'dopo: ' + msg.error);
    if (UI && UI.hideInlineStatus)   UI.hideInlineStatus(STATUS_ID, 4000);
    return;
  }

  const short = msg.url ? msg.url.replace(/^https?:\/\/[^/]+/, '') : '';
  const text  = msg.skipped ? 'dopo: unchanged' : ('Saved → ' + (short || msg.url || ''));

  if (UI && UI.updateInlineStatus) UI.updateInlineStatus(STATUS_ID, text);
  if (UI && UI.hideInlineStatus)   UI.hideInlineStatus(STATUS_ID, 3000);

  if (msg.url) ensureButton(msg.url);
});

console.log('[refinery-lite] bridge + UI ready');
