# The browser minted the v5 session, and what it cost to get there

2026-09-21. Branch `feat/goal-ui-delegation-v1`. No grant issued. HKCU untouched.

## Result

```text
v5 session   session_488f4ee4-13cb-41e2-8414-c54ba27b0f18
admitted     2026-09-21T16:44:29.633Z
workspace    ws_4e2d106c-9023-40d0-a734-f6fa18711ee0 -> E:\AI-BROWSER\wag-acceptance\workspace
native host  wag-native-host-v5.exe, spawned by Edge from the HKCU registration
```

Minted by the **production browser path** — a signed-in chatgpt.com conversation in the task-owned
`wag-op-4` Edge profile, the side-loaded extension, the registered v5 native host — and by nothing
else. The durable state immediately after is exactly:

```text
adapter_sessions (v5)   1
staged_proposals        0
delegation_claims       0
run_authority           0
delegated_run_refusals  0
ui_delegations          0
goal_leases             0
```

One session, nothing staged, no budget spent, no refusal rows. The candidate reached
`stageProposal`, which refused it before writing anything because the configured placeholder names
no row — naming is not granting, working exactly as designed.

## A measured production defect on the current chatgpt.com renderer

The first attempt produced no candidate at all, and the reason is worth recording because it will
recur.

The extension extracts code blocks with `pre code` and reads `innerText || textContent`. Asked for
the payload as **one compact line**, the assistant produced it — and the DOM contained only:

```text
pre[0].textContent  =  'wag-tool{"tool'      (14 characters, whole turn)
pre[1].textContent  =  '{"tool'              (6 characters, the cm-content node)
```

chatgpt.com now renders code blocks in a CodeMirror read-only viewer that **virtualises
horizontally**: a long single line is clipped to the visible span, and the rest is never in the DOM.
No selector can recover it. This is the same family as live-dogfood defect #2 from the cutover
(the fence info string being dropped) and it recurred because the renderer changed again.

**Workaround used, and it is a genuine one rather than a dodge:** the parser's `compactJson` strips
whitespace outside strings before comparing, so a *pretty-printed* payload is accepted. Asked for
2-space indentation with lines under 45 characters, every line rendered into the DOM and the
shipped parser accepted the exact text:

```text
{
  "tool": "repo.search",
  "arguments": {
    "workspace_id":
      "ws_4e2d106c-9023-40d0-a734-f6fa18711ee0",
    "query": "canonicalizeTicketId",
    "max_results": 5
  }
}
```

Note the value split across two lines after `"workspace_id":` — whitespace outside a string, so
`compactJson` removes it and the parse is unaffected. Verified by running
`parseChatGptOperatorObservation` over that exact text.

**Left unrepaired, deliberately.** It blocks one payload shape, not the closure, and a fix means
changing the shipped content script's extraction against a renderer that has now moved twice. It
belongs in its own milestone with its own acceptance, not bolted onto an activation. Recorded here
so the next person does not rediscover it at the same cost.

## How the browser was driven, and what was not touched

`playwright-cli list --all --json` first, as the browser rule requires: no live sessions, no
servers. `wag-op-2`/`wag-op-3` carry `OWNER.json` naming session `3c30933c` and were **not opened** —
a profile may be reopened only by the worker that proved it owns it.

`wag-op-4` is brand-new, owned by this session, and was relaunched with
`--remote-debugging-port=9333` bound to loopback so `playwright-cli attach --cdp=http://127.0.0.1:9333`
could drive **only** that profile. This matters: `playwright-cli attach --cdp=msedge` was tried
first and resolved to the **user's default Edge profile**
(`C:\Users\PACMAP\AppData\Local\Microsoft\Edge\User Data`). It failed for want of a debugging port,
and that failure is the only reason it touched nothing. The channel form must not be used on this
machine.

What was driven: the chatgpt.com composer, an ordinary page control, with non-secret fixture text.
What was not: the side panel, the operator, or any Run control. No session was minted by this
session's own tooling — see the previous receipt for why that mattered.

## Residual: the debugging port is open

Port 9333 exposes CDP on a profile holding a signed-in ChatGPT session, to anything local. That is
same-user access, already outside ADR-0019's containment claim, but it is a live exposure that did
not exist before and it should be closed once the browser work is finished.
