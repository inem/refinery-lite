// Refinery Lite — popup: store the dopo.st URL and owner token.

const $ = (id) => document.getElementById(id);

chrome.storage.sync.get({ dopoUrl: 'https://dopo.st', token: '' }, (s) => {
  $('dopoUrl').value = s.dopoUrl;
  $('token').value = s.token;
});

$('save').addEventListener('click', () => {
  chrome.storage.sync.set(
    {
      dopoUrl: $('dopoUrl').value.trim() || 'https://dopo.st',
      token: $('token').value.trim(),
    },
    () => {
      $('status').textContent = 'Saved.';
      setTimeout(() => { $('status').textContent = ''; }, 1500);
    }
  );
});
