// Refinery Lite — ISOLATED-world bridge + UI.
//
// Relays the conversation JSON from the MAIN-world tap (window.postMessage)
// to the background worker (chrome.runtime), and shows feedback in ChatGPT's
// own UI via window.ChatGPTUI (loaded by the manifest before us):
//
//   - inline status in the header: "Saving to dopo…" → "Saved → /abc123"
//   - persistent header button "↗ dopo" that opens the stored dopo URL
//     for the currently-open conversation
//   - green ✓ badge in the sidebar next to every chat that's already synced

const UI = window.ChatGPTUI;
const STATUS_ID = 'rl-status';
const BUTTON_ID = 'rl-open';
const BADGE_OK  = '✓';
const SYNCED_COLOR = '#10a37f';

let currentConvId = null;

// ---- per-chat URL store -----------------------------------------------------

function urlKey(convId) { return 'url_' + convId; }

async function getSavedUrl(convId) {
  if (!convId) return null;
  const got = await chrome.storage.local.get(urlKey(convId));
  return got[urlKey(convId)] || null;
}

async function syncedConvIds() {
  const all = await chrome.storage.local.get(null);
  const set = new Set();
  for (const k of Object.keys(all)) {
    if (k.startsWith('url_') && all[k]) set.add(k.slice(4));
  }
  return set;
}

// ---- header button ----------------------------------------------------------

function ensureButton(url) {
  if (!UI || typeof UI.addTopHeaderButton !== 'function') return;
  // remove an old instance so the onClick captures the fresh url
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

// ---- sidebar: synced badges -------------------------------------------------

async function refreshSidebarBadges() {
  if (!UI || typeof UI.getSidebarChats !== 'function') return;
  const synced = await syncedConvIds();
  for (const chat of UI.getSidebarChats()) {
    const ok = chat.conversationId && synced.has(chat.conversationId);
    UI.addChatBadge(chat.element, ok ? BADGE_OK : null, { color: SYNCED_COLOR });
  }
}

if (UI && typeof UI.onSidebarChange === 'function') {
  // fires once at start and on every sidebar mutation (new chat, rename, etc.)
  UI.onSidebarChange(refreshSidebarBadges, 400);
}

// refresh whenever storage changes (a new chat just got its url_ key)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some((k) => k.startsWith('url_'))) {
    refreshSidebarBadges();
  }
});

// ---- tap → background -------------------------------------------------------

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (!d || d.source !== 'refinery-lite' || d.type !== 'CONVERSATION' || !d.data) return;

  currentConvId = d.data.conversation_id || null;

  if (UI && UI.setInlineStatus) {
    UI.setInlineStatus('Saving to dopo…', { id: STATUS_ID });
  }
  refreshButton();

  chrome.runtime
    .sendMessage({ type: 'UPLOAD', data: d.data })
    .catch((e) => console.debug('[refinery-lite] sendMessage failed:', e.message));
});

// ---- background → bridge ----------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'UPLOAD_DONE') return;
  // ignore stale messages for a chat the user has already navigated away from
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
