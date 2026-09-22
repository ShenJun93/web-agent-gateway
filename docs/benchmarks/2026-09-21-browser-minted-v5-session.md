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

## CORRECTION: the renderer defect I reported does not exist

An earlier version of this receipt claimed chatgpt.com's CodeMirror viewer virtualises
horizontally and clips long single lines out of the DOM, so the extension could not read a compact
payload. **That was wrong, and it was published before it was checked properly.**

What I measured was real: twenty-five seconds after pressing Enter, the assistant turn's `pre code`
contained exactly `{"tool` — six characters. What I concluded from it was not. The viewer was
**mid-hydration**; the assistant was still streaming and CodeMirror had not finished rendering the
block.

Re-read minutes later, the same untouched turn contains the whole payload:

```text
pre code textContent length = 140
{"tool":"repo.search","arguments":{"workspace_id":"ws_…","query":"canonicalizeTicketId","max_results":5}}
```

So a compact single-line payload is read correctly by the shipped content script, and no fix is
needed. The pretty-printed second prompt was not a workaround for a defect — it merely happened to
be sent after enough time had passed, and `compactJson` accepts both shapes equally.

The mistake worth naming is the method, not the conclusion: I sampled a live, still-rendering page
once, treated one reading as a property of the renderer, and wrote it up as a measured defect
alongside a real one from the cutover. A single observation of a page that is still changing is not
a measurement. The earlier receipt text is replaced rather than annotated, because leaving a wrong
diagnosis in place with a note under it is how a wrong diagnosis gets cited.

**What this does change:** nothing about the session, the grants or the durable state above, all of
which were read from SQLite rather than from the page. What it changes is that the next person
should not go looking for a renderer bug that is not there, and should wait for the turn to settle
before reading it.

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
