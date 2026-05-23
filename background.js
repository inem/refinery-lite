// Refinery Lite — background service worker.
//
// Converts an intercepted ChatGPT conversation to markdown (convert.js) and
// POSTs it to dopo.st. The cross-origin POST runs here: a service-worker
// fetch with host_permissions is not CORS-restricted. Unchanged
// conversations are not re-uploaded. Per conversation_id we keep three
// things in chrome.storage.local:
//   - hash_<id>          : content signature of the last successful sync
//   - url_<id>           : dopo URL of the last successful sync
//   - synced_update_<id> : update_time (unix seconds floor) of the data
//                          we synced — the bridge compares it with the
//                          sidebar list's update_time to flag stale chats.

importScripts('convert.js'); // provides toMarkdown(), contentSig()

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function tell(tabId, payload) {
  if (typeof tabId !== 'number') return;
  chrome.tabs.sendMessage(tabId, payload).catch(() => { /* tab gone — ignore */ });
}

async function handleUpload(data, tabId) {
  const { dopoUrl, token } = await chrome.storage.sync.get({
    dopoUrl: 'https://dopo.st',
    token: '',
  });

  const convId = data.conversation_id || 'unknown';

  if (!token) {
    console.log('[refinery-lite] no token set — open the popup');
    tell(tabId, { type: 'UPLOAD_DONE', convId, error: 'no token' });
    return;
  }

  // Hash on a CONTENT signature, not on the formatted markdown:
  // server-side fields like update_time can drift between intercepts of
  // the same chat. contentSig depends only on message ids + text.
  const sig = hash(contentSig(data));
  const markdown = toMarkdown(data);
  const hashKey   = 'hash_'          + convId;
  const urlKey    = 'url_'           + convId;
  const updateKey = 'synced_update_' + convId;

  const updTs = data.update_time ? Math.floor(data.update_time) : null;

  const cached = await chrome.storage.local.get([hashKey, urlKey, updateKey]);
  if (cached[hashKey] === sig) {
    // Refresh synced-update even on a skipped upload, so the sidebar ✓
    // stays current when ChatGPT's update_time drifts without real content
    // changes (otherwise the chat would show ↻ stale forever).
    if (updTs && updTs !== cached[updateKey]) {
      await chrome.storage.local.set({ [updateKey]: updTs });
    }
    console.log('[refinery-lite] unchanged — skip', convId);
    tell(tabId, { type: 'UPLOAD_DONE', convId, url: cached[urlKey] || null, skipped: true });
    return;
  }

  const base = (dopoUrl || 'https://dopo.st').replace(/\/+$/, '');
  try {
    const res = await fetch(base + '/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({ content: markdown }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[refinery-lite] upload failed:', res.status, body);
      tell(tabId, { type: 'UPLOAD_DONE', convId, error: 'http ' + res.status });
      return;
    }
    const json = await res.json().catch(() => null);
    const url  = json && json.url;
    await chrome.storage.local.set({
      [hashKey]:   sig,
      [urlKey]:    url || cached[urlKey] || null,
      [updateKey]: updTs,
    });
    console.log('[refinery-lite] uploaded', convId, '→', url);
    tell(tabId, { type: 'UPLOAD_DONE', convId, url });
  } catch (e) {
    console.error('[refinery-lite] upload error:', e.message);
    tell(tabId, { type: 'UPLOAD_DONE', convId, error: e.message });
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'UPLOAD' && msg.data) {
    handleUpload(msg.data, sender && sender.tab && sender.tab.id);
  }
});

console.log('[refinery-lite] background ready');
