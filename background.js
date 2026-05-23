// Refinery Lite — background service worker.
//
// Converts an intercepted ChatGPT conversation to markdown (convert.js) and
// POSTs it to dopo.st. The cross-origin POST runs here: a service-worker
// fetch with host_permissions is not CORS-restricted. Unchanged
// conversations are not re-uploaded. The dopo URL is stored per
// conversation_id and reported back to the originating tab for the bridge
// to surface as UI feedback.

importScripts('convert.js'); // provides toMarkdown()

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
  const hashKey = 'hash_' + convId;
  const urlKey  = 'url_'  + convId;

  const cached = await chrome.storage.local.get([hashKey, urlKey]);
  if (cached[hashKey] === sig) {
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
    await chrome.storage.local.set({ [hashKey]: sig, [urlKey]: url || cached[urlKey] || null });
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
