const MAX_OBSERVATION_BYTES = 128 * 1024;
const MAX_CODE_BLOCKS = 2;
const seen = new WeakMap();
let scanScheduled = false;

function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  queueMicrotask(() => {
    scanScheduled = false;
    scanAssistantMessages();
  });
}

function scanAssistantMessages() {
  for (const node of assistantMessageNodes()) {
    const contents = assistantContentNodes(node);
    const text = contents.map(readText).filter(Boolean).join('\n').trim();
    if (!text) continue;

    const observation = { text, codeBlocks: renderedCodeBlocks(contents) };
    const serialized = JSON.stringify(observation);
    if (seen.get(node) === serialized) continue;
    seen.set(node, serialized);
    if (new TextEncoder().encode(serialized).byteLength > MAX_OBSERVATION_BYTES) continue;
    chrome.runtime.sendMessage({
      type: 'provider.observed_text',
      ...observation,
      conversationHint: location.pathname.slice(0, 512),
    }).catch(() => undefined);
  }
}

function assistantMessageNodes() {
  const turns = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn="assistant"]')];
  if (turns.length) return turns;
  return [...document.querySelectorAll('[data-message-author-role="assistant"]')];
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
});

scheduleScan();
