const MAX_OBSERVATION_BYTES = 128 * 1024;
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
  for (const node of document.querySelectorAll('[data-message-author-role="assistant"]')) {
    const text = (node.innerText || node.textContent || '').trim();
    if (!text || seen.get(node) === text) continue;
    seen.set(node, text);
    if (new TextEncoder().encode(text).byteLength > MAX_OBSERVATION_BYTES) continue;
    chrome.runtime.sendMessage({
      type: 'provider.observed_text',
      text,
      conversationHint: location.pathname.slice(0, 512),
    }).catch(() => undefined);
  }
}

new MutationObserver(scheduleScan).observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
});

scheduleScan();
