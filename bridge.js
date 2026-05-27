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

// Two flavors of activity, both signaled by ChatGPT's `animate-spin` SVG:
//   1) sidebar chat item spins → that (background) chat just advanced.
//      Bump latestUpdate so the stale comparison fires straight away;
//      the freshness survives the spinner disappearing.
//   2) <main> area spins → the CURRENT chat is being updated (sending,
//      generating, tools). ChatGPT does not put a sidebar spinner on the
//      chat you're already on. On the disappearance transition we fetch
//      the conversation ourselves and push it through the upload pipeline,
//      so the active chat re-syncs without the user having to navigate.

let wasMainSpinning = false;

function pollSpinners() {
  if (!UI || typeof UI.getSidebarChats !== 'function') return;
  let bumped = false;
  const now = Math.floor(Date.now() / 1000);

  for (const chat of UI.getSidebarChats()) {
    const cid = chat.conversationId;
    if (!cid) continue;
    if (chat.element.querySelector('svg[class*="animate-spin"]')) {
      if ((latestUpdate.get(cid) || 0) < now) {
        latestUpdate.set(cid, now);
        bumped = true;
      }
    }
  }

  const mainEl = document.querySelector('main');
  const isMainSpinning = !!(mainEl && mainEl.querySelector('svg[class*="animate-spin"]'));
  if (wasMainSpinning && !isMainSpinning && currentConvId) {
    refetchAndResync(currentConvId);  // fire-and-forget
  }
  wasMainSpinning = isMainSpinning;

  if (bumped) refreshSidebarBadges();
}

setInterval(pollSpinners, 1500);

// ---- ChatGPT auth + refetch of the active chat -----------------------------

let cachedAccessToken = null;
let accessTokenExpiry = 0;
const refetchInFlight = new Set();

async function getAccessToken(force = false) {
  if (!force && cachedAccessToken && Date.now() < accessTokenExpiry) {
    return cachedAccessToken;
  }
  const res = await fetch('/api/auth/session'); // same-origin, cookies auto
  if (!res.ok) throw new Error('auth/session ' + res.status);
  const j = await res.json();
  if (!j.accessToken) throw new Error('no accessToken in /api/auth/session');
  cachedAccessToken = j.accessToken;
  accessTokenExpiry = j.expires
    ? new Date(j.expires).getTime() - 60_000
    : Date.now() + 10 * 60 * 1000;
  return cachedAccessToken;
}

// On main-area spinner-stop, ChatGPT itself doesn't re-fetch the conversation
// (the new turn is already streamed into the page state). We do it ourselves
// so the active chat picks up its new turn without the user navigating away.
async function refetchAndResync(convId) {
  if (!convId || refetchInFlight.has(convId)) return;
  refetchInFlight.add(convId);
  try {
    let token = await getAccessToken();
    let res = await fetch('/backend-api/conversation/' + convId, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (res.status === 401) {
      token = await getAccessToken(true);
      res = await fetch('/backend-api/conversation/' + convId, {
        headers: { Authorization: 'Bearer ' + token },
      });
    }
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.mapping) return;
    chrome.runtime
      .sendMessage({ type: 'UPLOAD', data })
      .catch((e) => console.debug('[refinery-lite] refetch sendMessage:', e.message));
  } catch (e) {
    console.debug('[refinery-lite] refetch failed:', e.message);
  } finally {
    refetchInFlight.delete(convId);
  }
}

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

    // Direct DOM signal beats any timestamp comparison: if ChatGPT is
    // showing its update spinner on this chat right now, it's stale.
    const isSpinning = !!chat.element.querySelector('svg[class*="animate-spin"]');

    const stored = updated[cid];
    const live   = latestUpdate.get(cid);
    // `(stored || 0)` handles chats synced before synced_update tracking
    // landed — any bump from the spinner poll still triggers stale.
    const stale  = isSpinning ||
                   (live != null && live > (stored || 0) + STALE_TOLERANCE_S);

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
    console.warn('[refinery-lite] upload error:', msg.error,
                 '(convId:', msg.convId, ')');
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

// loud warning if token isn't configured — otherwise the only "no token"
// log lives in the service-worker console, which is easy to miss.
chrome.storage.sync.get({ token: '' }, (s) => {
  if (!s.token) {
    console.warn(
      '[refinery-lite] no token set — click the extension icon and paste your dopo owner token. ' +
      'Until then opening a chat does nothing.'
    );
  }
});
