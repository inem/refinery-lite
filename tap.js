// Refinery Lite — MAIN-world fetch tap.
//
// Runs in the MAIN world at document_start so it can patch window.fetch
// before ChatGPT's app code uses it. When ChatGPT loads a conversation it
// fetches /backend-api/conversation/<uuid> — that fetch is the "chat opened"
// event. We read a clone of the response and hand the full JSON to the
// ISOLATED-world uploader via window.postMessage.
//
// Passive: the original response is returned untouched. ChatGPT's own
// rendering is not affected — no truncation, no rewriting.

(function () {
  'use strict';

  const CONVERSATION_RE = /\/backend-api\/conversation\/[0-9a-f-]{36}$/;
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const resource = args[0];
    const url = typeof resource === 'string'
      ? resource
      : (resource && resource.url) || '';

    const response = await originalFetch.apply(this, args);

    if (CONVERSATION_RE.test(url)) {
      // Clone before the page consumes the body. Read async, never block.
      response.clone().json()
        .then((data) => {
          if (data && data.mapping) {
            window.postMessage(
              { source: 'refinery-lite', type: 'CONVERSATION', data },
              '*'
            );
          }
        })
        .catch(() => { /* not JSON / parse failure — ignore */ });
    }

    return response; // original, untouched
  };

  console.log('[refinery-lite] fetch tap installed');
})();
