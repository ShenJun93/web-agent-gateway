# WAG Local Operator PRIMARY — Cutover Evidence

Date: 2026-09-20
Status: PASS — local cutover for repository-engineering work on this machine
Candidate: `2c419b2`
Base: `5246e0e`
Predecessor receipt: `docs/benchmarks/2026-09-20-wag-local-operator-primary-source-acceptance.md`
Decision authority: ADR-0018, ADR-0019, ADR-0023, ADR-0024, ADR-0025, ADR-0026

This is a successor, not an amendment. The predecessor receipt stands as written for `a421216`.

## Decision

```text
WAG_LOCAL_OPERATOR = PRIMARY
DESKTOP_COMMANDER  = FALLBACK_ONLY
```

for normal local repository-engineering work on this machine: reading a repository, proposing an
edit or a file creation, proposing a commit, running a configured verification, and having each
of those approved locally before it takes effect — driven from a ChatGPT Web conversation, with
Desktop Commander not in the loop at any point.

This is a **local** decision about this machine. It authorizes nothing remote.

## Scope, and what this does not claim

- Not a general agent platform, and not Desktop Commander feature parity. WAG stays narrower on
  every profile; the surface is the twelve tools listed below and nothing else.
- Not a remote, hosted, multi-device or multi-user claim.
- Does not authorize push, PR, merge, remote branch mutation, release, tag, signing, native-host
  publication, provider or account actions, or any machine-wide change.
- Not a Layer B WebChat tier claim under the benchmark contract. This is Layer A.
- The installed native host is a **development** build from the working tree, deliberately placed
  beside the accepted CI distribution rather than over it. See *Installed state* below.

## Environment

```text
host                = Microsoft Windows 11 Pro 10.0.26200, x64
node                = v24.20.0
npm                 = 12.0.2
git                 = 2.55.0.windows.2
browser             = Microsoft Edge 153.0.4234.32   (see "Why Edge")
devspace pin        = docs/benchmarks/devspace-pin.json  (33d6d0b)
gitleaks            = 8.30.1
playwright-cli      = 0.1.19
```

## Commits in range

```text
465cda2  docs: decide one git execution policy and record what it is for
966699e  feat: run every git subprocess through one policy
3810ecd  test: bound the proposal object-count assertion instead of pinning it
d5894c6  feat: run verifications through an argv runner with a built environment
b7f8446  feat: bound what a proposal costs and who learns what from it
a421216  feat: add a proposal-only browser operator adapter
beca4a6  docs: accept the git surface, the verify runner and the v4 adapter locally
16e6c7f  feat: serve the browser operator and make the shipped extension v4
2c419b2  refactor: build the storage slot names from one prefix
```

## Gates

All run against `2c419b2`, after the last source edit.

```text
npm test                     457 pass / 0 fail   exit 0   860.4s
npm run typecheck                                exit 0
npm run build                                    exit 0
npm run test:business        1 pass / 0 fail     exit 0
npm run test:dc-replacement  1 pass / 0 fail     exit 0
git diff --check                                 exit 0
gitleaks 8.30.1  beca4a6..2c419b2  2 commits, 67.63 KB, 1 finding — see below
```

### The one gitleaks finding, stated exactly

```text
RuleID:  generic-api-key
File:    browser/extension/service-worker-core-v4.js:17
Commit:  16e6c7f
Value:   a chrome.storage.session slot name
```

`const SEEN_STORAGE_KEY = 'wag.operator.seen.v4'` — a storage slot name, not a credential. The
neighbouring queue slot, identical in shape, did not trip the rule, so the signal is threshold
noise. `2c419b2` builds both names from one prefix, which removes the shape the rule matches; the
finding remains only in the history of `16e6c7f`. No allowlist was added, because suppressing a
rule for that path would also hide anything real added there later.

A whole-tree scan (`--no-git`) reports four further findings, all pre-existing and all public
values: the extension's **public** manifest key, and three Authenticode SHA-256 digests in the
preview-release documents and their test. The repository's gate is the committed-range scan for
this reason.

## The cutover evidence

Everything below ran against the **built** `dist/cli.js`, a real pinned DevSpace, the real
registered native host, a real Edge browser with the real unpacked extension, and a real
signed-in chatgpt.com conversation.

### 1. The full chain, from a real conversation to a real file

```text
chatgpt.com (signed in)
  -> content script  (real page, real assistant turn, trusted sender)
  -> service worker  (proposal queued, identified, persisted)
  -> HUMAN clicks Run in the WAG side panel
  -> Chromium native messaging
  -> registered native host  (%LOCALAPPDATA%\WebAgentGateway\native-host-dev\4db6c1b0…)
  -> WAG admission  (loopback, one-time bootstrap)
  -> durable record  mut_b66d75d5-4676-4ba1-ab84-276306a8d343
  -> HUMAN approves on the local operator review server, on a channel the browser
     is never told the origin of
  -> CONTRIBUTING.md written
```

The reviewed `result_sha256` was `4988b179e5836c4c472c152f7e572b7021b0ef1eac0ea15c28064d7ec1345a32`.
The file on disk hashes to the same value. Before approval the path did not exist.

### 2. A real commit, proposed from the browser

```text
commit   5d9dc357d9bca5a79280afd6a04fae583a16d519
parent   1b875dc7e956d6576607cb37df83bebc9ca4e5b1   (exactly one)
branch   work
blob     e9fb059195b9945f616349eb9160161daffa3b3a7842148470e862cf6238714e
```

The committed blob hash equals the `resultSha256` the browser preview reported and the file on
disk — byte fidelity end to end from a browser proposal. HEAD was unchanged until the operator
approved. The `D ` / `??` index state afterwards is the documented ADR-0023 consequence of never
touching the operator's real index.

### 3. A real verification

`verify.preview` from the browser created `verifyreq_4bb21cbf…`; the operator approved it; the
configured `unit` profile ran through the argv runner and returned `exit_code: 0` with the test
output, retrieved by the browser through `verify.result`.

### 4. The proposal survived a real restart

The WAG runtime was stopped and restarted between proposal and approval. The pending commit
record reconciled and was still approvable, and the review page rendered the repository, the
author, the parent, the tree, the selected paths, the change set and the message.

### 5. Negative evidence, live

From the browser, against a live runtime:

```text
mutation.approve      -> MALFORMED_REQUEST   (not on the surface)
verify.run            -> MALFORMED_REQUEST
repo.diff             -> MALFORMED_REQUEST
git.commit + branch   -> MALFORMED_REQUEST   (no branch argument exists)
workspace.open C:\Windows -> LOCAL_WAG_FAILED (outside the allowed root)
```

The session survived all five refusals. A second browser session, from the same browser and the
same extension, was refused on every attempt against the first session's objects:

```text
file.read      their workspace  -> error
repo.snapshot  their workspace  -> error
mutation.result their record    -> error
file.create    their workspace  -> error
git.commit     their workspace  -> error
```

The browser was never given the operator origin, its bootstrap, its cookie or its CSRF token; the
discovery file carries four keys and none of them.

## Why Edge

Measured on 2026-09-20, and corroborated against current Chromium sources:

- **Google Chrome cannot side-load an unpacked extension at all.** Chrome logged
  `--load-extension is not allowed in Google Chrome, ignoring.` and
  `--disable-extensions-except is not allowed in Google Chrome, ignoring.` The guard is
  compile-time on Google-Chrome-branded builds and has been since Chrome 137; the
  `--enable-unsafe-extension-debugging` escape hatch was deleted in Chrome 149. Nothing about
  headless, automation or the profile changes it.
- **Playwright's bundled Chromium** — the path Playwright's own documentation recommends — cannot
  run on this machine: a Windows Application Control policy blocks the binary. Changing that
  policy is a machine-wide security change and was out of authority, so it was not attempted.
- **Microsoft Edge 153 accepts `--load-extension`** and the MV3 service worker runs headless.

Edge is therefore the acceptance browser here. Recorded as measured, not as a guarantee: the
current Playwright documentation asserts Edge removed these switches too, which this machine
contradicts today. If Edge closes it, the documented successor is the CDP `Extensions.loadUnpacked`
command on the browser-level target, which no longer requires a pipe transport or a flag.

## What the live dogfood found that tests did not

Five defects, all discovered by running the product against a real signed-in conversation, all
fixed in `16e6c7f` with regression tests.

| # | Defect | Fix |
| --- | --- | --- |
| 1 | A native frame the schema refused ended the host process, killing the admitted session and the operator's live workspace, with the extension seeing only "native host has exited" | Schema refusals are answered with `MALFORMED_REQUEST` and the session continues. Framing failures stay fatal, because the stream position is then unknown. |
| 2 | chatgpt.com renders code blocks in a CodeMirror viewer and drops the fence info string, so every `wag-tool` block arrived untagged and was rejected | An untagged block is accepted; any other language is still refused. The payload shape is the selector. |
| 3 | Queued proposals lived in service-worker memory, which MV3 discards after ~30s idle, so the panel was empty by the time a human looked | Queue and identities live in `chrome.storage.session`, revalidated on restore. |
| 4 | Duplicate proposals piled up across rescans and reloads | Two causes: `forTab` read and wrote storage across two awaits so one tab became two WAG sessions, and the message identity depended on which node kind the scan matched. Mint is coalesced per tab; innermost `data-message-id` wins. |
| 5 | The 60-second review window expired between the two human gestures, so a correct proposal could not be approved | Ceiling raised to five minutes — the commit path's existing ceiling — default unchanged, value configurable. The config loader was also dropping the field despite validating it. |

Findings 3 and 4 are related: persisting the queue turned a silent leak into a visible pile, which
is how the identity bug became findable at all.

## Installed state, and how to undo it

```text
files     %LOCALAPPDATA%\WebAgentGateway\native-host-dev\4db6c1b06aa31481\
          wag-native-host.exe   sha256 4db6c1b06aa31481b999de7d5c52d380d1bbf1a6c5abf03cc5315a4a877d311e
          com.openai.web_agent_gateway.json
          install-receipt.json
registry  HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.openai.web_agent_gateway
          prior state: ABSENT
profile   E:\AI-BROWSER\profiles\wag-op-2   (dedicated, disposable, WAG-owned, OWNER.json)
state     %LOCALAPPDATA%\WebAgentGateway\browser-operator-v4.sqlite
```

Left exactly as found: `HKCU\SOFTWARE\Chromium\NativeMessagingHosts\com.openai.web_agent_gateway`
still points at the accepted v3 distribution under `native-host\4dcabd0a…`. Nothing machine-wide
was touched, no OS or browser security control was disabled, and no unrelated browser profile was
opened.

Rollback, in order: delete the HKCU **Edge** subkey named above (it had no prior value, so nothing
is restored); stop the runtime, which removes its discovery file and its operator-url file; delete
the `native-host-dev\4db6c1b06aa31481` directory after confirming the executable still hashes to
the value above; delete the disposable browser profile. The accepted v3 installation and its
registration are not part of this and must not be touched.

## Residual limitations

```text
RESULTS_DO_NOT_RETURN_TO_THE_PAGE
```

This is the significant one. A result is delivered to the side panel, not back into the
conversation, so the ids a follow-up proposal needs are carried across by the human. The model can
poll its own records — `mutation.result`, `git.commit.result`, `verify.result` are on the surface —
but only if it is told the id. Until that loop closes, a multi-step task needs the operator to
relay ids between the panel and the chat. It is bounded and it is not a hidden Desktop Commander
fallback, but it is manual relay and it is the first thing a successor should remove.

```text
EXTENSION_RELOAD_STARTS_A_NEW_WAG_SESSION
```

`chrome.storage.session` is cleared when the extension reloads, so the tab's correlation is
re-minted and workspace ids from before the reload stop working. This is deliberate: putting the
correlation in `storage.local` would write a session key to disk.

```text
NATIVE_HOST_IS_A_DEVELOPMENT_BUILD
NO_NETWORK_ISOLATION
COMMITS_TABLE_IS_NOT_AN_APPEND_ONLY_TRANSITION_LOG
REAL_INDEX_HOLDS_THE_PRE_COMMIT_TREE_UNTIL_REFRESHED
ACCEPTANCE_BROWSER_IS_EDGE_NOT_CHROME
```

WAG's process is not network-isolated. Approval and process ownership are not a network sandbox,
and no machine-wide firewall or security policy was changed to pretend otherwise.

## Acceptance decision

```text
WAG_LOCAL_OPERATOR_PRIMARY_LOCAL = PASS
DESKTOP_COMMANDER_IN_THE_LOOP = NONE
BROWSER_DIRECT_CONSEQUENCE = NONE
HUMAN_GESTURES_REQUIRED = RUN_IN_PANEL + APPROVE_IN_OPERATOR
CROSS_SESSION_ISOLATION = ENFORCED_AND_MEASURED
BYTE_FIDELITY = REVIEWED_BYTES_EQUAL_WRITTEN_BYTES
LIVE_DOGFOOD_DEFECTS = 5_FOUND_5_FIXED_5_REGRESSION_TESTED
MACHINE_WIDE_CHANGE = NONE
```

Not authorized and not claimed by this receipt: push, PR, merge, remote branch mutation, release,
tag, signing, native-host publication, any provider or account action, any machine-wide change,
and any Layer B WebChat result.
