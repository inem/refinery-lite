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

const STATUS_ID     = 'rl-status';
const BUTTON_ID     = 'rl-open';
const BADGE_OK      = '✓';
const BADGE_STALE   = '↻';
const BADGE_BROKEN  = '✗';
const COLOR_OK      = '#10a37f'; // green
const COLOR_STALE   = '#f59e0b'; // amber
const COLOR_BROKEN  = '#dc2626'; // red

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
let lastSidebarCount = 0;

// ChatGPT rate-limits aggressive /backend-api/conversation/ traffic with 429.
// Tap surfaces it as a RATE_LIMITED message; we hold a deadline here. The
// walker stalls until it passes; spinner-stop refetch is also gated on it.
let rateLimitedUntil = 0;

function pollSpinners() {
  if (!UI || typeof UI.getSidebarChats !== 'function') return;
  let bumped = false;
  const now = Math.floor(Date.now() / 1000);

  const chatsList = UI.getSidebarChats();
  // Detect new chats arriving via lazy-load. onSidebarChange's 400ms debounce
  // + 100ms cool-down silently drops mutations during rapid scroll, so newly
  // loaded chats never get their ✓ badge until something else triggers a
  // refresh. Force one on count change here.
  if (chatsList.length !== lastSidebarCount) {
    lastSidebarCount = chatsList.length;
    bumped = true;
  }

  for (const chat of chatsList) {
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
  // While walker is clicking through chats, ChatGPT itself fetches
  // /backend-api/conversation/<id> on each navigation and the tap catches
  // it. A second refetch from here on spinner-stop doubles the rate and
  // is exactly what was triggering 429s. Skip while walker owns the run.
  if (wasMainSpinning && !isMainSpinning && currentConvId && !walkerRunning) {
    refetchAndResync(currentConvId);  // fire-and-forget
  }
  wasMainSpinning = isMainSpinning;

  ensureWalkerButton();  // header gets wiped on SPA nav; re-install if missing

  if (bumped) refreshSidebarBadges();
}

// Always-present "Sync all" button in the chat header — twin of the
// "↗ dopo" button but context-free (no current chat required).
function ensureWalkerButton() {
  if (!UI || typeof UI.addTopHeaderButton !== 'function') return;
  if (document.querySelector('[data-cgq-id="rl-walk"]')) return;
  UI.addTopHeaderButton({
    id: 'rl-walk',
    icon: '⟳',
    label: 'Sync all',
    title: 'Sync all unsynced ChatGPT chats to dopo.st',
    onClick: () => runWalker({ onlyUnsynced: true }),
  });
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
// Returns true if a valid UPLOAD was sent (data fetched, mapping present),
// false if the fetch itself failed. Walker uses the result to decide
// whether a subsequent UPLOAD_DONE timeout means "really broken" (false)
// or "background just slow" (true).
async function refetchAndResync(convId) {
  if (!convId || refetchInFlight.has(convId)) return false;
  refetchInFlight.add(convId);
  try {
    let token;
    try {
      token = await getAccessToken();
    } catch (e) {
      console.warn('[refinery-lite] refetch', convId, '— auth/session failed:', e.message);
      return false;
    }
    const url = '/backend-api/conversation/' + convId;
    let res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) {
      console.log('[refinery-lite] refetch', convId, '— 401, refreshing token');
      token = await getAccessToken(true);
      res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    }
    if (!res.ok) {
      console.warn('[refinery-lite] refetch', convId, '— HTTP', res.status, res.statusText);
      return false;
    }
    let data;
    try { data = await res.json(); }
    catch (e) {
      console.warn('[refinery-lite] refetch', convId, '— JSON parse failed:', e.message);
      return false;
    }
    if (!data || !data.mapping) {
      console.warn('[refinery-lite] refetch', convId, '— no .mapping; keys:',
                   data ? Object.keys(data).slice(0, 10).join(',') : '(null)');
      return false;
    }
    try {
      await chrome.runtime.sendMessage({ type: 'UPLOAD', data });
    } catch (e) {
      console.warn('[refinery-lite] refetch', convId, '— sendMessage:', e.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[refinery-lite] refetch', convId, '— unexpected:', e.message);
    return false;
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
  const url = {}, updated = {}, broken = {};
  for (const k of Object.keys(all)) {
    if (k.startsWith('url_'))                url[k.slice(4)] = all[k];
    else if (k.startsWith('synced_update_')) updated[k.slice('synced_update_'.length)] = all[k];
    else if (k.startsWith('broken_'))        broken[k.slice('broken_'.length)] = all[k];
  }

  for (const chat of UI.getSidebarChats()) {
    const cid = chat.conversationId;
    if (!cid) { UI.addChatBadge(chat.element, null); continue; }

    // Broken trumps everything — show the red ✗ loudly so the user knows
    // not to expect this chat on dopo (and walker won't retry it).
    if (broken[cid]) {
      UI.addChatBadge(chat.element, BADGE_BROKEN, { color: COLOR_BROKEN });
      continue;
    }

    if (!url[cid]) { UI.addChatBadge(chat.element, null); continue; }

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
        k.startsWith('url_') || k.startsWith('synced_update_') || k.startsWith('broken_'))) {
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

  if (d.type === 'RATE_LIMITED') {
    const seconds = Number(d.retryAfter) || 30;
    const until = Date.now() + seconds * 1000;
    if (until > rateLimitedUntil) rateLimitedUntil = until;
    console.warn('[refinery-lite] rate-limited by ChatGPT — pausing',
                 seconds, 's (until',
                 new Date(rateLimitedUntil).toLocaleTimeString() + ')');
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

// ---- walker: auto-sync all chats one by one --------------------------------

let walkerRunning = false;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitForUploadDone(convId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      chrome.runtime.onMessage.removeListener(listener);
      resolve(val);
    };
    const listener = (msg) => {
      if (msg && msg.type === 'UPLOAD_DONE' && msg.convId === convId) finish(msg);
    };
    chrome.runtime.onMessage.addListener(listener);
    setTimeout(() => finish(null), timeoutMs);
  });
}

function showWalkerPanel({ title, subtitle, onStop }) {
  let el = document.getElementById('rl-walker');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rl-walker';
    Object.assign(el.style, {
      position: 'fixed', top: '70px', right: '20px', zIndex: '100000',
      background: '#1f1f1f', color: 'white', padding: '14px 16px',
      borderRadius: '10px', boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
      font: '13px -apple-system, system-ui, sans-serif', minWidth: '240px',
    });
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div style="font-weight:600;margin-bottom:4px">${title}</div>
    <div style="color:#aaa;margin-bottom:10px;font-size:12px">${subtitle}</div>
    <button id="rl-walker-stop"
      style="background:#dc2626;color:white;border:0;padding:6px 14px;
             border-radius:5px;cursor:pointer;font:inherit">Stop</button>
  `;
  document.getElementById('rl-walker-stop').onclick = onStop;
}

function hideWalkerPanel() {
  const el = document.getElementById('rl-walker');
  if (el) el.remove();
}

// Find the scrollable ancestor of a sidebar chat element. Cached after first
// successful lookup — the container is stable across ChatGPT's SPA navigations.
let cachedScrollable = null;
function findScrollable() {
  if (cachedScrollable && document.contains(cachedScrollable)) return cachedScrollable;
  const chats = UI && UI.getSidebarChats ? UI.getSidebarChats() : [];
  const seed = chats.length && chats[chats.length - 1].element;
  if (!seed) return null;
  let el = seed.parentElement;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
      cachedScrollable = el;
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

// Trigger ChatGPT's lazy-load of older chats. setting scrollTop alone is
// sometimes not enough — the lazy-loader is an IntersectionObserver on a
// sentinel at the bottom of the list, and observer events sometimes don't
// fire on programmatic scroll. Triple-tap: scroll container, scrollIntoView
// the last chat (block:end), and dispatch a synthetic scroll event.
function scrollNavToBottom() {
  const el = findScrollable();
  if (!el) {
    console.warn('[refinery-lite] walker: scroll skipped — no scrollable container found');
    return;
  }
  el.scrollTop = el.scrollHeight;
  const chats = UI && UI.getSidebarChats ? UI.getSidebarChats() : [];
  const last = chats[chats.length - 1];
  if (last && last.element) {
    try { last.element.scrollIntoView({ block: 'end' }); } catch (_) {}
  }
  try { el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}
}

// Actively wait for ChatGPT to lazy-load more sidebar chats. Polls every
// 200ms and re-triggers scroll every ~1s — handles slow networks AND
// IntersectionObserver sentinels that need a re-nudge after the loading
// placeholder appears and is replaced by real items.
async function waitForMoreChats(beforeCount, timeoutMs) {
  const start = Date.now();
  let lastNudge = 0;
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    const now = UI.getSidebarChats().length;
    if (now > beforeCount) {
      console.log('[refinery-lite] walker: scroll triggered load after',
                  attempts, 'nudges,', Date.now() - start, 'ms');
      return now;
    }
    if (Date.now() - lastNudge > 1000) {
      scrollNavToBottom();
      lastNudge = Date.now();
      attempts++;
    }
    await sleep(200);
  }
  return UI.getSidebarChats().length;
}

async function runWalker(opts = {}) {
  if (walkerRunning) return;
  walkerRunning = true;
  console.log('[refinery-lite] walker started', opts);

  const onlyUnsynced = opts.onlyUnsynced !== false;
  // 5s between chats keeps us under ChatGPT's 429 threshold on big runs.
  // Manual clicks finish in 1–2s, so the wait is the user's reaction time,
  // not the bottleneck. Walker also breaks early into longer pauses when a
  // RATE_LIMITED arrives (see loop below).
  const pauseSec = opts.pauseSec || 5;

  try {
    const all = await chrome.storage.local.get(null);
    const synced = new Set(Object.keys(all)
      .filter((k) => k.startsWith('url_') && all[k])
      .map((k) => k.slice(4)));
    // broken_<cid> stores a unix-seconds timestamp of when the chat last
    // failed. Walker skips it for BROKEN_RETRY_S after that, then auto-
    // retries (the chat may have been a transient ChatGPT-side hiccup).
    // Legacy entries stored as `true` coerce to 1 → instantly expired →
    // retried on the next run. Background clears the key on a successful
    // sync, so a self-healed chat goes back to ✓.
    const broken = new Map();
    for (const k of Object.keys(all)) {
      if (k.startsWith('broken_') && all[k]) {
        broken.set(k.slice('broken_'.length), Number(all[k]) || 0);
      }
    }
    const BROKEN_RETRY_S = 24 * 3600;
    const brokenRecent = (cid) => {
      const ts = broken.get(cid);
      return ts && (Date.now() / 1000 - ts) < BROKEN_RETRY_S;
    };

    const visited = new Set();
    let stop = false;
    let attempted = 0;
    let okCount = 0;
    let failCount = 0;
    let lastTitle = '';

    // If we were kicked off from the new-chat page (chatgpt.com/), the
    // sidebar may not have rendered its list yet. Show a "starting…" panel
    // so the user sees the walker is alive, then wait up to ~3s for chats.
    showWalkerPanel({ title: 'Walker', subtitle: 'starting…', onStop: () => { stop = true; } });
    for (let i = 0; i < 15 && !stop; i++) {
      if (UI && UI.getSidebarChats && UI.getSidebarChats().some((c) => c.conversationId)) break;
      await sleep(200);
    }
    // Force a badge refresh so the user sees the true synced state before
    // we start — disagreement between walker and sidebar badges is confusing.
    await refreshSidebarBadges();

    while (!stop) {
      // Honour any active rate-limit window first. ChatGPT's 429 means
      // every conversation fetch is failing — clicking through chats now
      // just turns them all red. Wait it out, surface a countdown to the
      // user, then resume on the same `next` candidate.
      while (!stop && Date.now() < rateLimitedUntil) {
        const remaining = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
        showWalkerPanel({
          title: 'Rate-limited by ChatGPT',
          subtitle: `paused ${remaining}s · resuming automatically`,
          onStop: () => { stop = true; },
        });
        await sleep(1000);
      }
      if (stop) break;

      // Fresh DOM read every iteration: ChatGPT may shift/insert items.
      const chats = UI.getSidebarChats().filter((c) => c.conversationId);
      const next = chats.find((c) =>
        !visited.has(c.conversationId) &&
        !brokenRecent(c.conversationId) &&
        (!onlyUnsynced || !synced.has(c.conversationId))
      );

      if (!next) {
        const before = chats.length;
        const unvisitedSynced = chats.filter((c) =>
          !visited.has(c.conversationId) && synced.has(c.conversationId)).length;
        console.log('[refinery-lite] walker: no next candidate',
                    { loaded: before, visited: visited.size,
                      alreadySyncedInList: unvisitedSynced,
                      onlyUnsynced });
        const after = await waitForMoreChats(before, 8000);
        if (after === before) {
          console.log('[refinery-lite] walker: scroll exhausted, ending', { final: after });
          break;
        }
        console.log('[refinery-lite] walker: loaded more chats', { from: before, to: after });
        continue;
      }

      visited.add(next.conversationId);
      attempted++;
      lastTitle = next.title || next.conversationId;

      // Keep the currently-syncing chat in the user's view — otherwise the
      // sidebar drifts and you can't tell where the walker is at.
      try { next.element.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      catch (_) { /* element detached — happens occasionally on re-render */ }

      showWalkerPanel({
        title: `Syncing ${attempted} · ${lastTitle.slice(0, 40)}`,
        subtitle: 'opening chat…',
        onStop: () => { stop = true; },
      });

      // Real click — same path as a manual click. ChatGPT's SPA routes
      // into the chat, fetches /backend-api/conversation/<id> itself in
      // MAIN world, the tap intercepts the response and pushes UPLOAD.
      // Direct fetch from ISOLATED world (the previous approach) appears
      // not to behave the same way — manual clicks sync in seconds while
      // refetchAndResync stalled the whole pipeline.
      const clickAt = Date.now();
      next.element.click();
      const result = await waitForUploadDone(next.conversationId, 30000);
      if (result && !result.error) {
        okCount++;
      } else if (rateLimitedUntil > clickAt) {
        // The conversation fetch failed because of a 429, not because the
        // chat itself is broken. Un-visit so the next loop iteration picks
        // it up again — after the rate-limit wait at the top of the loop.
        visited.delete(next.conversationId);
        attempted--;
        console.log('[refinery-lite] walker: rate-limited mid-chat',
                    next.conversationId, '— will retry after pause');
      } else {
        failCount++;
        const why = result ? result.error : 'no UPLOAD_DONE in 30s (tap never fired?)';
        console.warn('[refinery-lite] walker: failed', next.conversationId, '—', why);
        const nowTs = Math.floor(Date.now() / 1000);
        broken.set(next.conversationId, nowTs);
        try { await chrome.storage.local.set({ ['broken_' + next.conversationId]: nowTs }); }
        catch (_) {}
      }
      if (stop) break;

      // Do NOT pre-scroll here — ChatGPT keeps the active chat in view
      // and scrolling to the bottom would jump the user past unvisited
      // chats. Scrolling happens ONLY when find() runs out of candidates.
      for (let s = pauseSec; s > 0; s--) {
        if (stop) break;
        const tally = `${okCount} ok${failCount ? ` · ${failCount} failed` : ''}`;
        showWalkerPanel({
          title: `${tally} · ${lastTitle.slice(0, 30)}`,
          subtitle: `Next in ${s}s`,
          onStop: () => { stop = true; },
        });
        await sleep(1000);
      }
    }

    if (!attempted) {
      showWalkerPanel({ title: 'Walker', subtitle: 'Nothing to sync.', onStop: hideWalkerPanel });
    } else {
      const summary = [`${okCount} synced`, failCount && `${failCount} failed`]
        .filter(Boolean).join(' · ');
      showWalkerPanel({
        title: stop ? 'Stopped' : 'Done',
        subtitle: summary,
        onStop: hideWalkerPanel,
      });
    }
    setTimeout(hideWalkerPanel, 5000);
  } finally {
    walkerRunning = false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'START_WALKER') runWalker(msg.opts || {});
});

// ---- extract: turn a selection in a ChatGPT reply into a dopo piece -------
//
// The button is gated on the active chat already being synced (url_<id> set
// in storage). If the chat hasn't synced yet the popup just shows ChatGPT's
// native buttons — no point letting the user save a quote that has no parent
// post to attach to.
//
// The range we send is intentionally opaque text-anchor JSON rather than the
// XPath that dopo's own quote-extractor uses. ChatGPT's DOM is React-rendered
// and bears no resemblance to dopo's markdown render, so an XPath computed
// here would not restore on dopo. The eventual dopo-side restorer will read
// {kind, mid, occurrence, text} and re-locate the highlight by text-search
// inside the matching assistant turn.

const EXTRACT_BTN_ID = 'rl-extract';
// ChatGPT's selection popup. Was `.aria-live=polite.fixed` — late-2026 the
// popup switched from position:fixed to a translate3d'd absolute container,
// so `.fixed` no longer matches. The .aria-live=polite class (literal, with
// the '=' — tailwind arbitrary class) is still the stable handle.
const SELECTION_POPUP_SEL  = '.aria-live\\=polite';
const SELECTION_BTN_BAR    = '.shadow-long.flex.overflow-hidden';

// Closest ChatGPT assistant message ancestor (the React node carries both
// data-message-author-role="assistant" and data-message-id).
function findAssistantMessage(node) {
  let el = node && (node.nodeType === Node.TEXT_NODE ? node.parentElement : node);
  while (el && el !== document.body) {
    if (el.dataset && el.dataset.messageAuthorRole === 'assistant') return el;
    el = el.parentElement;
  }
  return null;
}

// 0-based index of which occurrence of `text` IN THE WHOLE CONVERSATION the
// selection starts at. Dopo's restorer text-searches its own rendered <article>
// for the same N-th occurrence — so the count has to match across DOMs.
//
// We scope to the message containers (each <div data-message-author-role>)
// rather than <main>, because <main> also carries ChatGPT's input box,
// suggestion chips, etc. — text that isn't in dopo's render and would shift
// the count.
function chatOccurrence(msgEl, range, text) {
  if (!text) return 0;
  let before = '';
  const all = document.querySelectorAll('[data-message-author-role]');
  for (const m of all) {
    if (m === msgEl) break;
    before += (m.innerText || m.textContent || '');
  }
  try {
    const probe = document.createRange();
    probe.setStart(msgEl, 0);
    probe.setEnd(range.startContainer, range.startOffset);
    before += probe.toString();
  } catch (_) { /* selection in a detached subtree — give up */ }
  let occ = 0, idx = -1;
  while ((idx = before.indexOf(text, idx + 1)) !== -1) occ++;
  return occ;
}

function installExtractButton() {
  const observer = new MutationObserver(async () => {
    const popup = document.querySelector(SELECTION_POPUP_SEL);
    if (!popup) return;
    const container = popup.querySelector(SELECTION_BTN_BAR);
    if (!container) return;
    if (container.querySelector(`[data-cgq-id="${EXTRACT_BTN_ID}"]`)) return;

    // Gate: only inject when the active chat already has a dopo URL.
    if (!currentConvId) return;
    const got = await chrome.storage.local.get(urlKey(currentConvId));
    const dopoPostUrl = got[urlKey(currentConvId)];
    if (!dopoPostUrl) return;

    // Popup may have closed during the await — re-check before inserting.
    if (!document.contains(container)) return;
    if (container.querySelector(`[data-cgq-id="${EXTRACT_BTN_ID}"]`)) return;

    const btn = document.createElement('button');
    btn.dataset.cgqId = EXTRACT_BTN_ID;
    // Mirror native popup buttons (Ask ChatGPT, Create Note) — radius lives
    // on the parent wrapper, each button is rounded-none, with a left border
    // acting as the separator from the previous button.
    btn.className =
      'btn relative btn-secondary rounded-none active:opacity-1 '
      + 'border-y-0 border-e-0 border-s border-solid border-token-border-heavy';
    btn.innerHTML = `
      <div class="flex items-center justify-center">
        <span class="flex items-center gap-1.5 select-none">
          <span style="font-size:14px;">📑</span>
          <span class="whitespace-nowrap select-none">Extract</span>
        </span>
      </div>`;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sel   = window.getSelection();
      const text  = sel ? sel.toString() : '';
      const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (!text || !range) return;
      handleExtractClick(text, range, dopoPostUrl);
    });
    container.appendChild(btn);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

async function handleExtractClick(text, range, dopoPostUrl) {
  const msgEl = findAssistantMessage(range.commonAncestorContainer);
  if (!msgEl) {
    if (UI && UI.showToast) UI.showToast('Select from an assistant reply', { type: 'error' });
    return;
  }
  const mid = msgEl.dataset.messageId || null;
  const occ = chatOccurrence(msgEl, range, text);
  const rangePayload = JSON.stringify({
    kind: 'chatgpt-selection',
    conv: currentConvId,
    mid,
    occurrence: occ,
    text,
  });
  const title = text.length > 80 ? text.slice(0, 77) + '…' : text;

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'EXTRACT',
      convId: currentConvId,
      dopoPostUrl,
      text,
      range: rangePayload,
      title,
    });
    if (res && res.ok) {
      if (UI && UI.showToast) UI.showToast('Extracted → dopo');
    } else {
      const why = (res && res.error) || 'failed';
      console.warn('[refinery-lite] extract failed:', why);
      if (UI && UI.showToast) UI.showToast('Extract: ' + why, { type: 'error' });
    }
  } catch (e) {
    console.warn('[refinery-lite] extract sendMessage threw:', e.message);
    if (UI && UI.showToast) UI.showToast('Extract: ' + e.message, { type: 'error' });
  }
  try { window.getSelection().removeAllRanges(); } catch (_) {}
}

installExtractButton();

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
