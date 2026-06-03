// Refinery Lite — background service worker.
//
// Pipeline per intercepted conversation:
//   1. compute contentSig — if unchanged since last sync, skip everything.
//   2. extract file references (asset_pointers + attachments).
//   3. for each: fetch the binary from ChatGPT (Bearer accessToken from
//      /api/auth/session), POST to dopo /upload — get {sha256, url, existed}.
//      uploads run in parallel; dopo dedups by sha256 server-side so this
//      is fast on re-sync (each file responds with existed:true, no S3 put).
//   4. compose markdown with `{{file:HEX64}}` tokens; dopo's render-time
//      resolver swaps them for real URLs at view time.
//   5. POST the markdown to dopo /, store url+update_time, ack the tab.

importScripts('convert.js'); // toMarkdown, contentSig, extractFileRefs

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function tell(tabId, payload) {
  if (typeof tabId !== 'number') return;
  chrome.tabs.sendMessage(tabId, payload).catch(() => { /* tab gone — ignore */ });
}

// fetch() has NO default timeout. Anything we don't wrap can hang forever
// (slow S3 signed-URL, stuck dopo POST, dead chatgpt API) — and walker's
// waitForUploadDone has no signal until its own timeout fires. Wrap every
// outbound fetch here so handleUpload is bounded.
function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...(opts || {}), signal: ctrl.signal })
    .finally(() => clearTimeout(t));
}

// ===== ChatGPT auth & file fetch ============================================

let cachedAccessToken = null;
let accessTokenExpiry = 0;

async function getAccessToken(force = false) {
  if (!force && cachedAccessToken && Date.now() < accessTokenExpiry) {
    return cachedAccessToken;
  }
  const res = await fetchWithTimeout('https://chatgpt.com/api/auth/session', {
    credentials: 'include',
  }, 10_000);
  if (!res.ok) throw new Error('auth/session ' + res.status);
  const j = await res.json();
  if (!j.accessToken) throw new Error('no accessToken in /api/auth/session');
  cachedAccessToken = j.accessToken;
  accessTokenExpiry = j.expires
    ? new Date(j.expires).getTime() - 60_000
    : Date.now() + 10 * 60 * 1000;
  return cachedAccessToken;
}

async function chatgptFileMeta(fileId) {
  const metaUrl = 'https://chatgpt.com/backend-api/files/' + fileId + '/download';
  let token = await getAccessToken();
  let res = await fetchWithTimeout(metaUrl, {
    headers: { Authorization: 'Bearer ' + token },
  }, 15_000);
  if (res.status === 401) {
    token = await getAccessToken(true); // force-refresh
    res = await fetchWithTimeout(metaUrl, {
      headers: { Authorization: 'Bearer ' + token },
    }, 15_000);
  }
  if (!res.ok) throw new Error('file meta ' + res.status);
  return res.json(); // typically { download_url, file_name, mime_type, ... }
}

async function fetchChatGPTBlob(fileId) {
  const meta = await chatgptFileMeta(fileId);
  const url = meta.download_url || meta.url;
  if (!url) throw new Error('no download_url for ' + fileId);
  const r = await fetchWithTimeout(url, {}, 30_000);
  if (!r.ok) throw new Error('download ' + r.status);
  const blob = await r.blob();
  const mime = meta.mime_type || meta.mimetype || blob.type || 'application/octet-stream';
  return { blob, mime };
}

// ===== dopo /upload =========================================================

async function dopoUpload(blob, mime, dopoUrl, token) {
  const base = (dopoUrl || 'https://dopo.st').replace(/\/+$/, '');
  const res = await fetchWithTimeout(base + '/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': mime || 'application/octet-stream',
    },
    body: blob,
  }, 30_000);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('upload ' + res.status + ' ' + body.slice(0, 120));
  }
  return res.json(); // { url, sha256, mime, existed }
}

async function uploadAllFiles(refs, dopoUrl, dopoToken) {
  if (!refs.length) return {};
  const fileMap = {};
  const results = await Promise.allSettled(
    refs.map(async (ref) => {
      const { blob, mime } = await fetchChatGPTBlob(ref.id);
      const up = await dopoUpload(blob, mime, dopoUrl, dopoToken);
      return { id: ref.id, sha256: up.sha256, existed: up.existed };
    })
  );
  let existed = 0, fresh = 0, failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      fileMap[r.value.id] = r.value.sha256;
      r.value.existed ? existed++ : fresh++;
    } else {
      failed++;
      const ref = refs[results.indexOf(r)];
      console.warn('[refinery-lite] file fetch/upload failed:',
                   ref && (ref.id + ' (' + ref.kind + ')'),
                   '—', r.reason && r.reason.message);
    }
  }
  console.log('[refinery-lite] files:', { existed, fresh, failed, of: refs.length });
  return fileMap;
}

// ===== main upload pipeline =================================================

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

  // contentSig depends only on conversation content (ids + texts + attachment
  // names) — server-side update_time drift does not invalidate the cache,
  // and the file map is irrelevant to it (textOf falls back to placeholders).
  const sig = hash(contentSig(data));
  const hashKey   = 'hash_'          + convId;
  const urlKey    = 'url_'           + convId;
  const updateKey = 'synced_update_' + convId;
  const updTs = data.update_time ? Math.floor(data.update_time) : null;

  const cached = await chrome.storage.local.get([hashKey, urlKey, updateKey]);
  if (cached[hashKey] === sig) {
    if (updTs && updTs !== cached[updateKey]) {
      await chrome.storage.local.set({ [updateKey]: updTs });
    }
    console.log('[refinery-lite] unchanged — skip', convId);
    tell(tabId, { type: 'UPLOAD_DONE', convId, url: cached[urlKey] || null, skipped: true });
    return;
  }

  // Conversation actually changed — gather files, then compose markdown.
  let fileMap = {};
  try {
    const refs = extractFileRefs(data);
    if (refs.length) fileMap = await uploadAllFiles(refs, dopoUrl, token);
  } catch (e) {
    console.warn('[refinery-lite] file step failed:', e.message);
    // proceed without file tokens — placeholders survive
  }

  const markdown = toMarkdown(data, fileMap);

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
    // Successful sync clears any prior broken flag — chat is alive again.
    await chrome.storage.local.remove('broken_' + convId).catch(() => {});
    console.log('[refinery-lite] uploaded', convId, '→', url);
    tell(tabId, { type: 'UPLOAD_DONE', convId, url });
  } catch (e) {
    console.error('[refinery-lite] upload error:', e.message);
    tell(tabId, { type: 'UPLOAD_DONE', convId, error: e.message });
  }
}

// POST /<parent>/piece — body {text, range, title?}. Server creates a real
// post (kind=piece) anchored to the parent chat. The `range` is opaque JSON
// here; the dopo-side restorer will read it back at view-time to draw the
// in-chat highlight once the text-anchor branch lands in render.clj.
async function handleExtract(msg) {
  const { token } = await chrome.storage.sync.get({ token: '' });
  if (!token) return { ok: false, error: 'no token' };
  if (!msg.dopoPostUrl) return { ok: false, error: 'chat not synced yet' };

  let base, postId;
  try {
    const u = new URL(msg.dopoPostUrl);
    base   = u.origin;
    postId = u.pathname.replace(/^\/+|\/+$/g, '');
  } catch (_) { return { ok: false, error: 'bad dopo URL' }; }
  if (!postId) return { ok: false, error: 'bad dopo URL' };

  try {
    const res = await fetchWithTimeout(`${base}/${postId}/piece`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  'Bearer ' + token,
      },
      body: JSON.stringify({ text: msg.text, range: msg.range, title: msg.title }),
    }, 15_000);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: 'http ' + res.status + ' ' + body.slice(0, 120) };
    }
    const json = await res.json().catch(() => null);
    console.log('[refinery-lite] piece created', json && json.id, 'for', msg.convId);
    return { ok: true, id: json && json.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// GET /<parent>/pieces — list of extractions made from this chat. Returned
// to bridge so it can re-paint <mark>'s in the ChatGPT DOM on chat open.
async function handleListPieces(msg) {
  const { token } = await chrome.storage.sync.get({ token: '' });
  if (!token) return { ok: false, error: 'no token' };
  if (!msg.dopoPostUrl) return { ok: false, error: 'no parent url' };

  let base, postId;
  try {
    const u = new URL(msg.dopoPostUrl);
    base   = u.origin;
    postId = u.pathname.replace(/^\/+|\/+$/g, '');
  } catch (_) { return { ok: false, error: 'bad dopo URL' }; }
  if (!postId) return { ok: false, error: 'bad dopo URL' };

  try {
    const res = await fetchWithTimeout(`${base}/${postId}/pieces`, {
      headers: { Authorization: 'Bearer ' + token },
    }, 15_000);
    if (!res.ok) return { ok: false, error: 'http ' + res.status };
    const pieces = await res.json().catch(() => []);
    return { ok: true, pieces: Array.isArray(pieces) ? pieces : [], base };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'LIST_PIECES') {
    handleListPieces(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'EXTRACT') {
    // sendResponse is async-only when we return true below. Background's
    // other handlers are fire-and-forget, so this is the only branch that
    // needs the response channel kept open.
    handleExtract(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'UPLOAD' && msg.data) {
    const convId = msg.data.conversation_id || 'unknown';
    const tabId  = sender && sender.tab && sender.tab.id;
    console.log('[refinery-lite] UPLOAD received', convId, 'tab', tabId);
    Promise.resolve()
      .then(() => handleUpload(msg.data, tabId))
      .catch((e) => console.error('[refinery-lite] handleUpload threw', convId, '—', e.message));
  }
  if (msg && msg.type === 'START_WALKER') {
    // relay from popup → active chatgpt tab's bridge
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) return;
      const url = tab.url || '';
      if (!url.includes('chatgpt.com') && !url.includes('chat.openai.com')) {
        console.warn('[refinery-lite] walker: active tab is not chatgpt');
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'START_WALKER', opts: msg.opts || {} })
        .catch((e) => console.warn('[refinery-lite] walker send:', e.message));
    });
  }
});

console.log('[refinery-lite] background ready');
