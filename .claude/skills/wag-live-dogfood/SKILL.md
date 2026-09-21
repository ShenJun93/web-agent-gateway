---
name: wag-live-dogfood
description: Use when driving WAG end to end against the real Edge acceptance environment — a live proposal from a real conversation through the Run gate and the operator approval to a durable effect. Covers the exact runtime, the two human gates, how to detect each transition without driving the panel, and the cleanup that must follow.
---

# WAG live dogfood

The live loop is where WAG's defects actually surface: the cutover found five that the test suite
could not, and every one came from running the product against a real signed-in conversation.

`.claude/rules/` carries the invariants — read `human-presence-boundary.md` and
`browser-automation.md` before starting. This skill is the procedure.

## Preconditions, checked not assumed

```bash
node --version                                   # 22.19 <= v < 27
ls node_modules >/dev/null 2>&1 || npm ci        # a fresh worktree resolves tsc/tsx upward
npm run build                                    # the runtime serves dist/, not src/
playwright-cli list --all --json                 # mandatory; stop fail-closed if unparseable
```

Confirm the native host is registered for **Edge**, and that it points where you think:

```powershell
Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.openai.web_agent_gateway'
```

## Start only what the task needs

```bash
node dist/cli.js serve-browser-operator --config <absolute-config-path>
```

It writes two lines to stderr — `gateway.ready` with the admission URL, and `gateway.operator`
with the operator origin and the path of the 0600 file holding the single-use bootstrap URL.

```text
discovery     %LOCALAPPDATA%\WebAgentGateway\browser-adapter-v4.json
durable state %LOCALAPPDATA%\WebAgentGateway\browser-operator-v4.sqlite
operator url  %LOCALAPPDATA%\WebAgentGateway\browser-operator-v4.sqlite.operator-url
```

**Do not open the operator URL file.** It is the operator's credential, it is single-use, and
spending it takes their approval session away. The guard refuses a read of it through `Read`,
`Grep`, `Glob`, `WebFetch` and the obvious shell forms — but you are being told its path here, so
treat not opening it as the rule, not as something enforced for you.

## The loop

1. Drive the conversation to emit a `wag-tool` block. chatgpt.com renders code blocks in a
   CodeMirror viewer and drops the fence info string, so an untagged block is expected and
   accepted; any other language is still refused.
2. Open the side panel. `panel.state` re-attaches the bridge to open conversations and rescans
   before answering, so opening the panel is enough — **nobody has to reload the page by hand**.
   If you find yourself asking for a reload, that is a defect, not a step.
3. Confirm **exactly one** pending proposal, and that it is the one you expect. A proposal is
   identified by session, tab, provider message id, tool and exact arguments; two observations
   agreeing on all five are one proposal. More than one means a deduplication regression — stop
   and diagnose rather than asking for a click.
4. **Gate 1 — Run.** Human. Ask for that one gesture and stop.
5. Detect the transition from durable state, not from the panel: the proposal becomes a record
   (`mut_…`, `verifyreq_…`, a commit record). Poll the store read-only. Then continue on your own.
6. **Gate 2 — approve or reject on the operator.** Human, and the only thing that causes an
   effect. Ask once, stop, then detect the outcome and carry on.
7. Verify the effect exactly: reviewed `result_sha256` equals the bytes on disk; a committed blob
   hash equals the previewed hash; a verification returns its real exit code and output.

Both gates are human and **must not be collapsed into one**. Run submits; approval effects.

## Negative evidence belongs in the same run

A live run that only shows the happy path has not shown much. From the browser, against the live
runtime, confirm the refusals still hold — approve and dispatch methods are not on the surface, a
path outside the allowed root fails, and a second browser session cannot touch the first
session's workspaces, records or results. The session must survive every refusal.

## Cleanup

Stop the runtime you started — it removes its own discovery and operator-url files. Close only the
browser worker you own. Then inventory: any `node.exe` whose command line contains this worktree's
path, and any `wag-native-host.exe` you caused, and nothing else.
See `.claude/rules/resource-policy.md`. Never broad-kill.
