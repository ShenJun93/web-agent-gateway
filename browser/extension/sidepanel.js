const statusEl = document.querySelector('#status');
const pendingEl = document.querySelector('#pending');
const resultEl = document.querySelector('#result');

async function refresh() {
  // `panel.state` re-attaches the bridge to open conversations and rescans before answering,
  // so opening the panel is enough — the user never has to reload the page by hand.
  const state = await chrome.runtime.sendMessage({ type: 'panel.state' });
  statusEl.textContent = state.nativeConnected
    ? 'Native host connected'
    : 'Native host idle; it connects when you run a proposal';
  pendingEl.replaceChildren();
  for (const item of state.pending ?? []) pendingEl.append(renderPending(item));
}

function renderPending(item) {
  const wrapper = document.createElement('div');
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify({ tool: item.request.tool, arguments: item.request.arguments }, null, 2);
  const run = document.createElement('button');
  run.textContent = 'Run';
  run.addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'panel.execute', requestId: item.requestId }); await refresh(); });
  const dismiss = document.createElement('button');
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'panel.dismiss', requestId: item.requestId }); await refresh(); });
  wrapper.append(pre, run, dismiss);
  return wrapper;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  // A content script reaches this same listener, which is why the worker derives its actor from
  // Chrome's `sender` rather than from what a message claims. The panel had no equivalent check:
  // neither of these does anything a page could exploit — one renders a result, the other re-reads
  // authoritative state — but a page should not be able to drive the panel at all.
  if (sender?.id !== chrome.runtime.id || sender?.tab !== undefined) return;
  if (message?.type === 'panel.result') resultEl.textContent = JSON.stringify(message.response, null, 2);
  // A proposal was queued while this panel was already open. Results were always pushed; pending
  // was not, so the list could sit empty while storage held a proposal. Ask for the real state
  // rather than trusting the count in the message.
  if (message?.type === 'panel.pending') refresh().catch(() => undefined);
});

// Belt and braces for the case the push cannot cover: the worker was asleep when the proposal
// arrived, or the panel was hidden rather than closed. Showing the panel re-reads the queue.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh().catch(() => undefined);
});

refresh().catch(() => { statusEl.textContent = 'Adapter unavailable'; });
