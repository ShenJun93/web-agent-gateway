const MAX_OBSERVATION_BYTES = 128 * 1024;
const MAX_CODE_BLOCKS = 2;
const seen = new WeakMap();
let scanScheduled = false;

function scheduleScan(force = false) {
  if (force) lastSerialized = new WeakMap();
  if (scanScheduled) return;
  scanScheduled = true;
  queueMicrotask(() => {
    scanScheduled = false;
    scanAssistantMessages();
  });
}
let lastSerialized = seen;

function scanAssistantMessages() {
  for (const node of assistantMessageNodes()) {
    const contents = assistantContentNodes(node);
    const text = contents.map(readText).filter(Boolean).join('\n').trim();
    if (!text) continue;

    const observation = { text, codeBlocks: renderedCodeBlocks(contents) };
    const serialized = JSON.stringify(observation);
    // A cheap local filter only. Correctness does not rest on it: this map dies with the page,
    // so the service worker dedupes on a stable message identity instead.
    if (lastSerialized.get(node) === serialized) continue;
    lastSerialized.set(node, serialized);
    if (new TextEncoder().encode(serialized).byteLength > MAX_OBSERVATION_BYTES) continue;
    chrome.runtime.sendMessage({
      type: 'provider.observed_text',
      ...observation,
      messageId: assistantMessageId(node),
      conversationHint: location.pathname.slice(0, 512),
    }).catch(() => undefined);
  }
}

/**
 * The provider's own identity for this assistant turn.
 *
 * Measured on chatgpt.com, 2026-09-20: both `data-message-id` and `data-turn-id` are
 * server-assigned UUIDs and are the same after a reload, which is exactly what a rescan needs
 * in order not to offer the same proposal twice. When neither is present the turn has no stable
 * identity, and an unstable one is worse than none — the service worker refuses those.
 */
function assistantMessageId(node) {
  // The order matters and is the fix for a duplicate seen in the live dogfood. `assistantMessageNodes`
  // returns turn nodes or message nodes depending on which the page has rendered yet, and the two
  // describe the *same* message with different attributes. Preferring whichever the matched node
  // happened to carry produced two identities for one message and therefore two proposals.
  // `data-message-id` is the innermost and most specific, so it wins wherever it appears.
  const message = node.matches?.('[data-message-id]')
    ? node.getAttribute('data-message-id')
    : node.querySelector?.('[data-message-id]')?.getAttribute('data-message-id');
  if (typeof message === 'string' && message) return message.slice(0, 128);

  const turn = node.getAttribute?.('data-turn-id') ?? node.closest?.('[data-turn-id]')?.getAttribute('data-turn-id');
  return typeof turn === 'string' && turn ? turn.slice(0, 128) : '';
}

// The side panel asks for a rescan when it opens, so a user who reloaded the extension does not
// have to reload the conversation by hand.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'provider.rescan') return false;
  if (sender?.id !== chrome.runtime.id) return false;
  scheduleScan(true);
  sendResponse({ rescanned: true });
  return false;
});

function assistantMessageNodes() {
  const live = [...document.querySelectorAll('[data-message-role="assistant"]')];
  if (live.length) return live.filter(isCompletedLiveTurn);

  const turns = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn="assistant"]')];
  if (turns.length) return turns;
  return [...document.querySelectorAll('[data-message-author-role="assistant"]')];
}

function isCompletedLiveTurn(node) {
  const value = node.getAttribute?.('data-message-complete');
  return value === '' || value === 'true';
}

function assistantContentNodes(node) {
  const rendered = [...(node.querySelectorAll?.('.markdown, .prose, [class*="markdown"]') ?? [])];
  if (rendered.length) return outermost(rendered);
  const roles = [...(node.querySelectorAll?.('[data-message-author-role="assistant"]') ?? [])];
  return roles.length ? roles : [node];
}

function outermost(nodes) {
  return [...new Set(nodes)].filter((candidate) => !nodes.some((other) =>
    other !== candidate && typeof other.contains === 'function' && other.contains(candidate),
  ));
}

function renderedCodeBlocks(contents) {
  const blocks = contents.flatMap((content) =>
    [...(content.querySelectorAll?.('pre code') ?? [])].map((code) => ({
      language: codeLanguage(code),
      text: readText(code),
    })),
  ).filter((block) => block.text);
  if (blocks.length <= 1) return blocks;
  return [blocks[0], { language: '', text: '' }].slice(0, MAX_CODE_BLOCKS);
}

function readText(node) {
  return (node?.innerText || node?.textContent || '').trim();
}

function codeLanguage(code) {
  const className = typeof code.className === 'string' ? code.className : '';
  const token = className.split(/\s+/).find((value) => value.startsWith('language-'));
  return token ? token.slice('language-'.length, 'language-'.length + 64) : '';
}

new MutationObserver(scheduleScan).observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['data-message-complete'],
});

scheduleScan();
