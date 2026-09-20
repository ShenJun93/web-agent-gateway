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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'panel.result') resultEl.textContent = JSON.stringify(message.response, null, 2);
});

refresh().catch(() => { statusEl.textContent = 'Adapter unavailable'; });
