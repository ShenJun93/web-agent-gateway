# The delegated Run was not proven. What was, and what stopped it

2026-09-22. Branch `feat/goal-ui-delegation-v1`. **`WAG_DC_REPLACEMENT` is not PASS.**

The activation succeeded and both grants exist and compose correctly. The browser-level
`DELEGATED_RUN` did **not** happen, so nothing downstream of it — leased mutation, verify, bounded
commit, replay check, DC matrix — was reached. This records what was established, what blocked it,
and two defects found on the way, one of them mine.

## What is established

| | |
| --- | --- |
| v5 HKCU registration | works — Edge spawned `wag-native-host-v5.exe` from it |
| Browser-minted v5 session | `session_488f4ee4-13cb-41e2-8414-c54ba27b0f18`, via signed-in chatgpt.com |
| `session.bind` against the live gateway | resolves the correlation to that exact session and offers `uidel_755b752bd6dd9438074208b9` |
| Delegation | 120 min, 8 actions, bound to that session/adapter/workspace, origin `https://chatgpt.com`, tools `mutation.preview`/`verify.preview`/`git.commit` |
| Lease | 240 min, 4 files, 64 KB, `*.js`/`*.md`, commit to `work` with CAS on `5d9dc357`, `delegatedGoalIds` naming the delegation's goal |
| Composition | lease admits exactly that goal; same session; same adapter; lease tools a subset |
| Shipped parser vs. the live page | accepts all three payload shapes produced, verified by running it over the real DOM |

Durable state at the end: **1 session, 0 staged, 0 claims, 0 run-authority rows, 0 refusal rows.**
Nothing was spent.

## Defect 1 — mine: the activation step issued the lease and never named it

`browser-operator-runtime.ts` reads `goalLeaseId` from configuration; absent means `goalLease` is
`undefined`, so no admission pass is created and every effect needs the operator. The instrument I
wrote replaced the delegation placeholder and stopped. The result is a live-looking lease row that
the runtime never loads.

**It looked activated and was not.** Repaired: the instrument now writes `goalLeaseId` beside the
delegation id, reads the config back, and refuses if either is missing or if a lease is already
named. A regression test pins it.

This is the same defect class this project keeps finding — a mechanism that reads as complete and
is reached by nothing — committed this time in the instrument built to prevent exactly that.

## Defect 2 — the delegated path is silent

Measured: `delegated-observation-v5.js`, `native-session-core-v5.js` and
`delegated-dispatch-core-v5.js` contain **zero** log statements between them. Every failure returns
`undefined`, and the caller treats `undefined` as "not attempted" and moves on.

That is correct behaviour and unobservable behaviour at the same time. When the candidate stopped
being offered, there was no way from outside to learn why: the payload parsed, the native transport
answered `hello`, `session.bind` returned the right session and the right delegation, and the
durable store recorded nothing at all. Three separate causes produce the identical silence:

```text
no native host installed            -> undefined, silent
handshake failed                    -> undefined, silent
WAG offered no delegation           -> undefined, silent
stale port, send rejected           -> STAGE_TRANSPORT_FAILED, not remembered, silent
```

Diagnosis stalled there. The remaining way forward would have been to add logging to the shipped
extension mid-proof — a source change to the thing under test — or to reload the extension, which
clears `chrome.storage.session`, re-mints the correlation, and invalidates the session the grants
are bound to. Neither is a legitimate move inside a proof, so the proof stopped.

**This is the finding that matters most.** A path that cannot say why it declined is a path whose
failures are indistinguishable from its correct refusals, and this milestone spent its last hours
demonstrating that.

## What was ruled out, so the next attempt does not repeat it

- **Not the registration.** Edge spawned the host from HKCU; `hello` round-tripped.
- **Not the gateway link.** A direct `session.bind` through a fresh host returned
  `{bound:true, sessionId:session_488f4ee4…, delegationId:uidel_755b…}`.
- **Not the parser.** Running the shipped parser over the live DOM accepted all three turns
  (`repo.search` compact, `repo.search` pretty-printed, `mutation.preview` pretty-printed).
- **Not the payload shape.** A compact 140-character line and a 455-character pretty-printed block
  both render fully and both parse. `compactJson` strips whitespace outside strings, so either is
  accepted.
- **Not hydration, in the end.** chatgpt.com's CodeMirror viewer hydrates slowly — a block read 25
  seconds after sending held 6 characters and the same untouched block held all 140 minutes later.
  Every reading in this receipt was taken after the turn settled.

The likely remaining cause, unproven and stated as such: the service-worker controller holds a
native port whose gateway link died across the WAG restart, `onDisconnect` never fired, and every
subsequent attempt fails silently on the stale port. That is a hypothesis the current code cannot
confirm or refute from outside, which is Defect 2 restated.

## A method error worth recording

Partway through I reported a chatgpt.com renderer defect — horizontal virtualisation clipping long
lines out of the DOM — on the strength of **one** reading of a still-rendering page. It was wrong
and I had committed it before checking. The correction is in
`2026-09-21-browser-minted-v5-session.md`. A single observation of a page that is still changing is
not a measurement, and it cost this milestone an hour of designing around a problem that did not
exist.

## State left behind

```text
Edge worker wag-op-4        stopped; CDP port 9333 closed; no native hosts running
playwright session          detached
DevSpace (pinned 33d6d0b)   running, 127.0.0.1:7676
WAG browser operator        running, honouring uidel_755b752bd6dd9438074208b9
grants                      both live; the delegation expires 2026-09-21T18:50:52Z
```

Closing the browser destroyed `chrome.storage.session`, so the correlation is gone and the session
the grants bind no longer has a browser. **A retry needs a fresh session and fresh grants**; the
existing ones cannot be reused and were deliberately not revoked, because revocation is a human act.

`npm run lease:stop` halts both authorities in every process on the next call.
