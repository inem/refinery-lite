// Refinery Lite — ChatGPT conversation JSON → markdown.
//
// Pure: no chrome.* / no DOM. importScripts'd by background.js, and also
// runnable standalone under node for testing against captured conversations.
//
// Verified against real /backend-api/conversation/ captures (chatgpt-dream.har,
// chatgpt-short.har): title, create_time/update_time, conversation_id,
// mapping/current_node/parent, author.role, content{content_type,parts},
// is_visually_hidden_from_conversation. NOT verified: reasoning ("thoughts")
// — neither capture contained reasoning messages; thoughtsOf is best-effort.
//
// Output starts with a YAML frontmatter block carrying `session-id` =
// conversation_id. dopo's storage parses it and treats re-uploads of the
// same chat as snapshots of one session (server.clj/dedup-by-session,
// storage/posts-by-session-id). The body itself matches the user's sample
// export (title, metablock, alternating Prompt / Response sections).
//
// The markdown is DETERMINISTIC for a given conversation state — no
// "exported at <now>" field — so both local-hash dedup and dopo's
// content-hash idempotency actually work.

function fmtTime(unixSec) {
  if (!unixSec) return '';
  const d = new Date(unixSec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}, ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// YAML accepts JSON-style double-quoted scalars, so JSON.stringify gives us
// a valid quoted string with proper escapes.
function yamlStr(s) { return JSON.stringify(s == null ? '' : String(s)); }

// Active branch: from current_node up the parent chain, then reversed.
// Falls back to every message by create_time when there is no current_node.
function orderedMessages(data) {
  const mapping = data.mapping || {};
  if (data.current_node && mapping[data.current_node]) {
    const out = [];
    const seen = new Set();
    let id = data.current_node;
    while (id && !seen.has(id)) {
      seen.add(id);
      const node = mapping[id];
      if (!node) break;
      if (node.message) out.push(node.message);
      id = node.parent;
    }
    return out.reverse();
  }
  return Object.values(mapping)
    .map((n) => n && n.message)
    .filter(Boolean)
    .sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
}

// Plain text of a message. Non-string parts (images) are dropped.
// Returns '' for editable_context / non-text content — those messages
// then skip naturally.
function textOf(content) {
  if (!content) return '';
  if (Array.isArray(content.parts)) {
    return content.parts.filter((p) => typeof p === 'string').join('\n').trim();
  }
  if (typeof content.text === 'string') return content.text.trim();
  return '';
}

// Reasoning summaries. BEST-EFFORT — unverified against a real capture.
function thoughtsOf(content) {
  if (!content) return [];
  if (content.content_type === 'thoughts' && Array.isArray(content.thoughts)) {
    return content.thoughts
      .map((t) => (t.summary || t.content || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }
  if (content.content_type === 'reasoning_recap' && typeof content.content === 'string') {
    return [content.content.replace(/\s+/g, ' ').trim()].filter(Boolean);
  }
  return [];
}

function isHidden(m) {
  return !!(m.metadata && m.metadata.is_visually_hidden_from_conversation);
}

function frontmatter(data) {
  const convId = data.conversation_id || '';
  const title  = (data.title || 'ChatGPT conversation').trim();
  const link   = convId ? `https://chatgpt.com/c/${convId}` : '';

  const lines = ['---'];
  lines.push('kind: chatgpt-session');
  lines.push('source: chatgpt');
  lines.push(`title: ${yamlStr(title)}`);
  if (convId) lines.push(`session-id: ${yamlStr(convId)}`);
  if (link)   lines.push(`url: ${yamlStr(link)}`);
  if (data.create_time) lines.push(`created: ${yamlStr(fmtTime(data.create_time))}`);
  if (data.update_time) lines.push(`updated: ${yamlStr(fmtTime(data.update_time))}`);
  lines.push('---');
  return lines.join('\n') + '\n';
}

function toMarkdown(data) {
  const title  = (data.title || 'ChatGPT conversation').trim();
  const convId = data.conversation_id || '';
  const link   = convId ? `https://chatgpt.com/c/${convId}` : '';

  const out = [];
  out.push(`# ${title}`, '');
  out.push('**Source:** ChatGPT  ');
  if (data.create_time) out.push(`**Created:** ${fmtTime(data.create_time)}  `);
  if (data.update_time) out.push(`**Updated:** ${fmtTime(data.update_time)}  `);
  if (link) out.push(`**Link:** [${link}](${link})  `);
  out.push('');

  let pendingThoughts = [];
  for (const m of orderedMessages(data)) {
    if (isHidden(m)) continue;
    const role = m.author && m.author.role;

    if (role === 'user') {
      const text = textOf(m.content);
      if (!text) continue;
      pendingThoughts = [];
      out.push('## Prompt:');
      if (m.create_time) out.push(fmtTime(m.create_time));
      out.push('', text, '');
    } else if (role === 'assistant' || role === 'tool') {
      const thoughts = thoughtsOf(m.content);
      if (thoughts.length) { pendingThoughts.push(...thoughts); continue; }
      const text = textOf(m.content);
      if (!text) continue; // tool calls, empty / streaming nodes
      out.push('## Response:');
      if (m.create_time) out.push(fmtTime(m.create_time));
      out.push('');
      if (pendingThoughts.length) {
        for (const s of pendingThoughts) out.push(`> **${s}**`, '>');
        out.push('');
        pendingThoughts = [];
      }
      out.push(text, '');
    }
  }
  const body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return frontmatter(data) + body;
}

// Stable per-content signature for dedup. Includes only the conversation_id
// and the visible user/assistant messages (id + full text). NO timestamps,
// NO update_time, NO frontmatter — so server-side metadata drift (e.g. a
// conversation's update_time getting bumped on read) does not invalidate
// the cache and cause a needless re-POST.
function contentSig(data) {
  const parts = [data.conversation_id || ''];
  for (const m of orderedMessages(data)) {
    if (isHidden(m)) continue;
    const role = m.author && m.author.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textOf(m.content);
    if (!text) continue;
    parts.push((m.id || '') + ':' + text);
  }
  return parts.join('');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { toMarkdown, orderedMessages, textOf, frontmatter, contentSig };
}
