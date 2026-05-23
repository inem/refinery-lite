// Refinery Lite — MAIN-world fetch tap.
//
// Runs in the MAIN world at document_start so it can patch window.fetch
// before ChatGPT's app code uses it. Two interceptions:
//
//   - /backend-api/conversation/<uuid>     → full conversation JSON
//                                            (the chat the user just opened)
//   - /backend-api/conversations?...       → sidebar list with each chat's
//                                            current update_time, used to
//                                            detect "stale" chats (advanced
//                                            elsewhere since last sync)
//
// In both cases we read a clone and emit via window.postMessage. The
// original response is returned untouched — ChatGPT's own rendering is
// not affected.

(function () {
  'use strict';

  const CONVERSATION_RE = /\/backend-api\/conversation\/[0-9a-f-]{36}$/;
  const LIST_RE         = /\/backend-api\/conversations(?:\?|$)/;

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const resource = args[0];
    const url = typeof resource === 'string'
      ? resource
      : (resource && resource.url) || '';

    const response = await originalFetch.apply(this, args);

    if (CONVERSATION_RE.test(url)) {
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
    } else if (LIST_RE.test(url)) {
      response.clone().json()
        .then((data) => {
          if (data && Array.isArray(data.items)) {
            const items = data.items
              .filter((it) => it && it.id && it.update_time)
              .map((it) => ({ id: it.id, update_time: it.update_time }));
            window.postMessage(
              { source: 'refinery-lite', type: 'LIST', items },
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
