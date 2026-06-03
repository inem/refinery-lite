// Refinery Lite — popup: store the dopo.st URL and owner token.
// When either changes, wipe the per-chat cache (hash_*, url_*,
// synced_update_*) so the sidebar badges don't keep lying about chats
// that were synced under a different token / dopo instance.

const $ = (id) => document.getElementById(id);

let initialDopoUrl = '';
let initialToken   = '';

chrome.storage.sync.get({ dopoUrl: 'https://dopo.st', token: '' }, (s) => {
  $('dopoUrl').value = s.dopoUrl;
  $('token').value   = s.token;
  initialDopoUrl = s.dopoUrl;
  initialToken   = s.token;
});

async function clearChatCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) =>
    k.startsWith('hash_') || k.startsWith('url_') || k.startsWith('synced_update_')
  );
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

$('walk').addEventListener('click', () => {
  chrome.runtime.sendMessage({
    type: 'START_WALKER',
    opts: { onlyUnsynced: $('onlyUnsynced').checked },
  });
  window.close();
});

$('save').addEventListener('click', async () => {
  const dopoUrl = $('dopoUrl').value.trim() || 'https://dopo.st';
  const token   = $('token').value.trim();
  const changed = dopoUrl !== initialDopoUrl || token !== initialToken;

  await chrome.storage.sync.set({ dopoUrl, token });

  let msg = 'Saved.';
  if (changed) {
    const cleared = await clearChatCache();
    msg = cleared
      ? `Saved. Cleared ${cleared} cached entries — chats will resync as you open them.`
      : 'Saved.';
    initialDopoUrl = dopoUrl;
    initialToken   = token;
  }

  $('status').textContent = msg;
  setTimeout(() => { $('status').textContent = ''; }, 3000);
});
