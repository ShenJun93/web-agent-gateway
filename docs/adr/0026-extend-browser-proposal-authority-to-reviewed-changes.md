# ADR-0026: Extend Browser Proposal Authority to Reviewed Edits, Creations and Commits

Date: 2026-09-20
Status: Accepted
Depends on: ADR-0013, ADR-0014, ADR-0015, ADR-0017, ADR-0018, ADR-0019, ADR-0020, ADR-0022, ADR-0023, ADR-0024
Research: `docs/research/2026-09-20-wag-git-execution-surface.md`
Amended by: ADR-0028 (Approve) and ADR-0029 (Run). `RUN_AND_APPROVAL = HUMAN` below is the
  invariant **as decided here** and is no longer the whole model — see ADR-0029,
  *Consequence for the invariant*. The text below is left as written; it is the record of what
  this decision decided, not a statement of current policy.

## Context

ADR-0019 accepted one architecture class for the browser:

```text
same-user Browser admission
  -> bounded caller-owned proposal creation
  -> independent local operator approval
  -> existing WAG-owned consequential execution core
```

It authorized that class and explicitly did not authorize any particular implementation beyond
`verify.preview`. Browser Verify Approval v1 implemented it for one capability, as
`browser.chatgpt.native.verify.v3` / protocol 3.

Everything else in the DC-replacement loop — reviewed edit, reviewed file creation, reviewed
commit — was subsequently built and locally accepted on the **private stdio** surface
(ADR-0020, ADR-0022, ADR-0023). The browser can inspect and propose a verification; it cannot
propose a change. So the measured workflow still ends by leaving the browser.

This ADR decides whether the same proposal class may carry those three, and what identity it
must use.

## The criterion ADR-0019 wrote, and where it does not fit

ADR-0019 allows a bounded proposal when, among other things, "creation does not execute a
process or command" and "creation does not modify repository/workspace contents".

`verify.preview` satisfies both trivially: it hashes a profile plan and persists a record.

`mutation.preview` and `git.commit` do not satisfy the first. Computing what a reviewer needs to
see requires reading the file through the execution backend, and for a commit it requires
building the candidate tree and asking git what the resulting delta is. That is process
execution, and pretending otherwise would be the wrong way to resolve the tension.

The second criterion is the one that actually carries the safety, and it now holds exactly:

- `mutation.preview` and `file.create` read; they write nothing. The accepted durable mutation
  contract already proves this, and reject or expiry leaves the file byte-identical.
- `git.commit`'s plan used to write loose blobs and trees into the operator's object store
  before any human saw the proposal — ADR-0023 recorded that as not accepted. ADR-0024 closed
  it: planning now builds its tree in a scratch object directory that is discarded unless the
  operator approves, measured as zero new objects in the repository.

## Decision

The bounded-proposal class of ADR-0019 is refined and extended.

**Refined.** A proposal may run **bounded, read-only, WAG-owned execution** in order to compute
what the operator will review, provided it leaves no durable effect: no ref moves, no file
changes, no object persists, no process outlives the call, and nothing the repository controls
is executed (ADR-0024). "Does not execute a process" was a proxy for "leaves nothing behind";
the property that matters is the second one, and it is now directly established rather than
approximated.

**Extended.** On a distinct successor adapter, the browser may create proposals for reviewed
edit, reviewed file creation and reviewed commit, and may poll their bounded results. It may not
approve, dispatch, or cause any of them to execute.

Every other constraint ADR-0019 placed on the class is carried over unchanged: caller-owned
records, server-generated opaque ids, fixed review TTL, no deadline refresh by polling or
restart, terminal expiry and rejection, and fail-closed on stale, foreign or replayed records.

### Two bounds, because one of them was measuring the wrong thing

ADR-0019 required a per-caller live limit. Extending the class made two corrections necessary.

First, the limit was not actually present on all three capabilities: `git.commit` had it, and
`mutation.preview` did not. Both now refuse at **8 live proposals per caller**, counted as
records still awaiting review within their TTL, for the same reason — it is what keeps the
operator's review list legible and refusable.

Second, a live-record limit does not bound work. A proposal that fails while being computed
creates no record, so the counter never moves: an independent review of this change showed three
hundred `git.commit` proposals naming unchanged paths running the planner three hundred times,
each spawning git subprocesses and reading every selected file, with the record count sitting at
zero throughout. So each of the three capabilities also charges a **per-caller attempt window,
30 attempts per 60 seconds, before any backend work**. The window is in memory: it bounds how
fast one caller can drive local work, and there is nothing for an attacker to gain from a
restart that a fresh session would not already give them.

### The correlation must be minted, on this adapter only

A correlation is what maps a browser session to a durable WAG session; two admissions carrying
the same string are the same session, which is what lets a service-worker restart reconnect to
its own workspaces rather than orphan them. That also means whoever can choose the string can
join an existing session. On the adapter that can propose changes, the correlation must
therefore be a server-minted UUID (`session_<uuid>`) and nothing else. Rebinding an existing
correlation stays allowed — it is the reconnect path, not a weakness.

This constrains v4 only. v1, v2 and v3 keep their permissive correlation shape, because
narrowing it would alter an accepted contract.

### A proposal has an identity, and it is not the observation

The page is re-observed constantly: a DOM rescan, a page reload, an MV3 suspension, an extension
reload and the side panel reopening all re-read the same assistant message. Each observation
mints a fresh request id, so request id cannot be what makes a proposal unique.

A proposal is identified by the WAG session, the tab, the provider's own message id, the tool
and the exact arguments. Two observations agreeing on all five are one proposal; two different
messages carrying byte-identical payloads are two. A turn with no provider-assigned message id
has no stable identity, and an unstable identity is worse than none, so it is refused.

The identity and the queue live in `chrome.storage.session`, not in worker memory: MV3 discards
an idle worker after about thirty seconds, and a human is what moves a proposal. That storage is
not durable authority — it is memory-backed, per browser session, and revalidated on the way
back in. The durable record still only exists once WAG has admitted the call.

### Attachment is automated; approval is not

An extension reload orphans the content script in tabs that are already open. Re-injecting it,
and rescanning when the side panel opens, is attachment, not authority: a rescan can only
re-offer proposals, and the identity above makes it idempotent. The consequential gesture — Run
in the side panel — stays human, and so does the operator approval behind it.

### The review window is a usability bound, not the safety property

Approval re-reads the file and refuses on any drift from the reviewed bytes; a commit
revalidates branch, HEAD, tree and identity and moves the ref by compare-and-swap. The review
TTL only bounds how stale a human's understanding may be.

One minute was chosen for a surface where the operator is already at the review page. The
browser profile adds a window switch between two human gestures, and a one-minute window
expired in exactly that gap. The ceiling is therefore five minutes — what the commit path has
always allowed for a strictly more consequential operation — and the value is configurable. The
default is unchanged.

### The side panel is identified, not asserted

Only the side panel may move a queued proposal toward the native host. A content script reaches
the same extension message listener, so the actor is derived from the `sender` Chrome itself
fills in — same extension id, no originating tab, and the side panel document — and never from
a literal the message handler supplies or the message claims.

### Identity

Adding proposal authority changes the browser capability profile, so it takes its own identity
and existing sessions cannot acquire it:

```text
browser.chatgpt.native.operator.v4
protocol 4
```

`browser.chatgpt.native.verify.v3` and protocol 3 are frozen. Their tool list, adapter id,
protocol revision and tests are unchanged by this ADR, and a v1, v2 or v3 session never gains v4
authority.

### Surface

The successor reuses the accepted v3 read and verify semantics verbatim and adds only the
proposal and result operations the three capabilities need. It reuses the stdio tool names,
because those tools already are proposal-only — `git.commit` proposes, it does not commit.

```text
health  workspace.open  repo.search  repo.snapshot  file.read
verify.preview  verify.result
mutation.preview  file.create  mutation.result
git.commit  git.commit.result
```

Not added: `repo.list`, `repo.diff`, anything that runs a verification directly, any `job.*`,
any argv or environment input, any approval or dispatch method, and any tool that names a branch,
a ref, an amend, a force or a push.

### The consequence boundary is unchanged

Nothing in this ADR lets a browser caller cause an effect. The local operator remains the only
authority that can turn a proposal into a change, through the accepted loopback review server
with its single-use bootstrap, session cookie, CSRF, Origin check and exact-record revalidation.

The browser is never given the operator origin, bootstrap token, session cookie, CSRF token, an
internal job or mutation identifier it does not own, or any handle to the filesystem or to a
process. A request id is correlation evidence, not a credential.

It is also never given the repository's configured author and committer identity. Those are
read from untrusted repository configuration at plan time, bound into the record and shown to
the operator, because the operator is the one who needs to check them; a proposing caller has no
reason to learn the name, email, git directory or common directory they name. They are carried
on the local review view only.

## What is still not authorized

```text
direct browser mutation, creation, commit or verification execution
browser-side approval or dispatch of anything
shell, process, PTY, argv or environment input from the browser
branch creation, deletion, push, fetch, merge, amend, reset, force, or any ref update
  other than the single compare-and-swap a locally approved commit performs
repo.list and repo.diff on the browser surface
any relaxation of ADR-0017 admission, ADR-0023 commit limits or ADR-0024 execution policy
stronger claims about the same-user bootstrap than ADR-0019 already makes
```

## Security invariants

```text
BROWSER_ADAPTER_V3 = FROZEN
V1_V2_V3_AUTHORITY_UPGRADE_TO_V4 = FORBIDDEN
BROWSER_PROPOSAL_CLASS = BOUNDED_READ_ONLY_EXECUTION_NO_DURABLE_EFFECT
BROWSER_DIRECT_CONSEQUENCE = FORBIDDEN
LOCAL_OPERATOR_APPROVAL = REQUIRED_FOR_EVERY_EFFECT
OPERATOR_CREDENTIALS_TO_BROWSER = NEVER
PROPOSAL_ID = CORRELATION_NOT_CREDENTIAL
CROSS_SESSION_PROPOSAL_ACCESS = FORBIDDEN
PROPOSAL_OBJECT_WRITES = NONE
PROPOSAL_LIVE_LIMIT_PER_CALLER = 8
PROPOSAL_ATTEMPT_WINDOW = 30_PER_60S_CHARGED_BEFORE_BACKEND_WORK
V4_CORRELATION = SERVER_MINTED_UUID_REQUIRED
ONE_TAB = ONE_WAG_SESSION
PROPOSAL_IDENTITY = SESSION_TAB_MESSAGE_TOOL_ARGUMENTS
PROPOSAL_RESCAN = IDEMPOTENT
REPOSITORY_IDENTITY_TO_BROWSER = NEVER
SIDE_PANEL_ACTOR = DERIVED_FROM_SENDER
ATTACHMENT_AND_RESCAN = AUTOMATED
RUN_AND_APPROVAL = HUMAN
REVIEW_WINDOW = CONFIGURABLE_UP_TO_5_MIN_DEFAULT_60S
```

## Decision markers

```text
ADR_0026 = ACCEPTED
SUCCESSOR_ADAPTER_ID = browser.chatgpt.native.operator.v4
SUCCESSOR_PROTOCOL_VERSION = 4
ADR_0019_PROPOSAL_CRITERION = REFINED_TO_NO_DURABLE_EFFECT
NEW_CONSEQUENTIAL_AUTHORITY = NONE
NEW_DEPENDENCY = NONE
```
