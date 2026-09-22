# WAG direct-MCP readiness, and the ChatGPT plan gate

2026-09-22. Branch `feat/goal-ui-delegation-v1`. The question was whether ChatGPT can call WAG
directly and consume structured results, removing DOM observation, `wag-tool` fenced blocks, manual
relay and Claude as intermediary.

```text
WAG_DIRECT_MCP_TRANSPORT            = PASS
WAG_DIRECT_MCP_AUTONOMOUS_AUTHORITY = PASS   (was a real blocker; fixed in this milestone)
CHATGPT_DIRECT_READ_E2E             = BLOCKED   (plan not documented as eligible; unattempted)
CHATGPT_DIRECT_WRITE_E2E            = BLOCKED_BY_OPENAI_PLAN
BUSINESS_UPGRADE_WOULD_UNLOCK_FINAL_ACCEPTANCE = YES, for everything WAG controls
CLAUDE_INTERMEDIARY_REQUIRED        = NO for WAG's part; YES until a connector exists
```

Transport readiness and autonomous authority are reported separately on purpose. The first was
true almost immediately and would have been a misleading headline on its own: a direct client
could have reached WAG and still needed a person to approve every bounded step, which is not the
acceptance target.

Decision: `docs/adr/0030-reach-chatgpt-through-the-private-stdio-surface.md`.
Provider evidence: `docs/research/2026-09-22-chatgpt-direct-mcp-route.md`.

## The finding that decided the shape of this work

**WAG already was the thing that needed building.** The private stdio surface (ADR-0020) exposes
the exact loop the milestone asks for, and OpenAI's Secure MCP Tunnel takes a **stdio** MCP server
as a child process (`--mcp-command`, sample profile `sample_mcp_stdio_local`). So the integration is
a composition, not a subsystem:

```text
ChatGPT connector -> OpenAI tunnel endpoint -> tunnel-client (outbound HTTPS only)
  -> node dist/cli.js serve-stdio --config <local config>   (child process, no listening port)
  -> DevSpace / durable store / local operator approval, or a Goal Lease
```

The "or a Goal Lease" is the part that did not work when this milestone started, and fixing it is
the substance of the work. See *The blocker that mattered* below.

Zero new transport code, zero new tools, zero new policy. The reuse order is satisfied at the top
(`COMPOSE`), and nothing is exposed to the network — which is the point of the tunnel.

Measured, not described: the instrument builds the real server from the real config and issues a
real `tools/list`.

```text
projected tools  13: health, workspace.open, repo.list, repo.search, repo.snapshot, repo.diff,
                     file.read, verify.run, mutation.preview, file.create, mutation.result,
                     git.commit, git.commit.result
```

Results already return as machine-readable MCP results: every handler returns both a text block and
`structuredContent` (`toolResult` in `src/server.ts`), so a direct client gets structure without
parsing prose.

## What changed in WAG, and why the transport change demanded it

Every previous consumer of this surface was ours. A tunnelled client is not: it decides whether to
ask its user to confirm a write **from the tool annotations alone**. ADR-0020 had already recorded
the provider's own warning that a read-only annotation may cause that confirmation to be skipped.
That turns annotations on this surface into a security contract. Two real defects followed.

**1. `workspace.open` declared `readOnlyHint: true` while creating durable state.** It canonicalises
a root, opens a DevSpace workspace and mints a durable caller-owned workspace record. It is now
`false`. The same surface's sibling, `createBrowserVerifyAdmittedMcpServer`, already declared it
correctly — so this was an internal contradiction, not a judgement call.

**2. Four of the five oldest tools accepted unknown arguments and dropped them in silence.** This
was found by probing rather than by reading: a test sent `owner_id` to `repo.snapshot` expecting a
refusal, and instead the call reached the handler with the field quietly stripped and failed for an
unrelated reason. Every tool added since ADR-0020 was already `.strict()`; these four predate that
convention. They are now strict, so an injected or stray argument is refused rather than hidden.

Also completed: all four hints on every tool, so none silently inherits a specification default.
The whole change is 42 lines in `createGatewayMcpServer`, and every line of it *narrows* — it
declares more risk to the client and refuses more input than before.

### The defaults, checked rather than assumed — and what that means for the two defects

Read from the canonical MCP schema (`schema/2025-06-18/schema.ts`), not from memory:

```text
readOnlyHint     default false
destructiveHint  default true     (meaningful only when readOnlyHint == false)
idempotentHint   default false    (meaningful only when readOnlyHint == false)
openWorldHint    default true
```

The defaults are **pessimistic**. So the missing hints were an accuracy problem, not a safety one:
a client seeing `repo.snapshot` without them would have assumed destructive and open-world, which
is wrong but errs toward confirming too much. The genuine security defect was the other kind — the
*affirmative* `readOnlyHint: true` on a tool that writes, which is the only way this surface could
have talked a client out of a confirmation. The two are worth keeping distinct, and the
completeness rule is now a convention that makes the affirmative case visible rather than buried.

One nuance accepted deliberately: the specification says `destructiveHint` and `idempotentHint` are
meaningful only when `readOnlyHint == false`, so declaring them on read-only tools is redundant.
They are declared anyway, uniformly, because a uniform table is what makes an outlier obvious.

The specification also states that clients **MUST** treat tool annotations as untrusted unless they
come from a trusted server. That is the same burden ADR-0020 recorded from the provider side, and it
is the reason this is treated as WAG's contract to get right rather than as a control WAG can lean
on.

## Gate evidence

| # | Gate | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Discovery through the supported architecture | PASS | `tools/list` over a generic MCP client returns the 13-tool loop; `test/direct-mcp-readiness.test.ts` |
| 2 | A read call reaches WAG, structured output returns | PASS | `npm run test:dc-replacement` — see below |
| 3 | Mutation/verify/git schemas exposed with correct annotations | PASS | full annotation table pinned per tool; completeness enforced for every tool, not sampled |
| 4 | Authority / CAS / replay / workspace checks still authoritative | PASS | untouched by the diff; transport-neutrality pinned by test; see the security section |
| 5 | Restart/recovery durable | PASS | existing restart tests green; `sessionId` is per process by design (ADR-0020 §5) |
| 6 | Browser path regression green | PASS | full suite; no browser surface was modified |
| 7 | Zero Desktop Commander dependency | PASS | denied in `.claude/settings.json`; the server did not connect this session at all |
| 8 | Full gates green | PASS | see below |
| 9 | **Autonomous authority reachable** (added after review) | PASS | stable session binding; `test/direct-mcp-session-binding.test.ts`, 8/8 |

```text
npm test                     880 tests, 874 pass, 0 fail, 6 todo   exit 0
npm run typecheck                                                  exit 0
npm run build                                                      exit 0
npm run test:business        1/1                                   exit 0
npm run test:dc-replacement  1/1                                   exit 0
git diff --check                                                   exit 0
gitleaks --no-git            7 findings, identical to the pre-change baseline, none in a changed file
gitleaks (each changed file) no leaks found
```

880 is +16 on the 864 this branch carried: the eight readiness tests and the eight session-binding
tests. `npm test` reports one `✖` under "failing tests" — it is a `# TODO` test, one of the two
`OPEN:` harness-guard items that predate this milestone, which node lists there while counting it
as `todo`. Hence `fail 0` and exit 0.

The DC-replacement acceptance is worth quoting, because it is the whole loop over the real
transport with the built artifact:

```text
tools        13, the full direct loop
operatorApprovals 3      commitBranch wag-work   commitSha 78948ba3…
commitParent b3ca9b3b…   commitClassHooksFired false
baselineExitCode 1  ->  afterFixExitCode 0
```

Three operator approvals, because that run configures no lease — which is exactly the behaviour
the stable-session work leaves untouched by default.

### Why gate 2 is stronger than it looks

`test/dc-replacement.acceptance.ts` already connects a generic MCP client to WAG like this:

```ts
new StdioClientTransport({ command: process.execPath, args: [builtCli, 'serve-stdio', '--config', configPath], ... })
```

That is byte-for-byte what `tunnel-client --mcp-command "node <cli> serve-stdio --config <path>"`
produces: the same binary, the same argv, the same pipe. The tunnel adds an outbound HTTPS hop in
front of it and changes nothing about the child process. So the composition's local half is not
merely plausible — it is the transport an accepted acceptance test has been exercising all along,
including the full read -> mutation -> verify -> commit loop with local approval.

What the tunnel adds beyond that, and what therefore remains unproven here, is only the hop: queue
semantics, latency, reconnection and any framing the client imposes.

## Security analysis

### Transport did not become authority

The caller tuple on this surface is derived locally and is not negotiable by the client: `ownerId`
from local configuration, `sessionId` minted per gateway process, `adapterId` the fixed literal
`private.stdio.v1` (`src/repository-engineering-runtime.ts`). `tunnel-client` carries bytes and
asserts no identity WAG reads.

A tunnelled ChatGPT is therefore the *stdio* caller and nothing else. It cannot read, resume, adopt
or alias a workspace owned by `browser.chatgpt.native.verify.v3`, `…operator.v4` or
`…delegation.v5`, because ownership is the whole tuple and the adapter differs. This is the same
property the previous mission proved for v4/v5, reached without adding anything.

Pinned rather than asserted: no tool on the direct surface accepts an owner, session, adapter,
correlation, lease, delegation, goal, authority or approval field, and unknown arguments are now
refused outright.

### ChatGPT's own confirmation composes *above* WAG, and no lease can suppress it

OpenAI documents that ChatGPT may require its user to confirm a write action, and may block some
actions outright. That gate is inside the client, upstream of any WAG code — by the time WAG sees a
request, ChatGPT has already decided to send it. The composition is a conjunction:

```text
ChatGPT confirmation  AND  WAG authority  ->  effect
```

**A Goal Lease admits an action on WAG's side only. It cannot suppress a confirmation imposed by
ChatGPT, and nothing here claims it can.** Equally, a provider confirmation is not a substitute for
local approval: with no lease named, ADR-0026 holds in full. Both failure directions are safe — a
confirmation without WAG authority yields a proposal and no effect; WAG authority with a ChatGPT
block yields no call at all.

### The loop has a rendezvous, and that is deliberate

`mutation.preview` and `git.commit` return an id, not an effect. Unless a Goal Lease admits the
action, a person must approve it locally, and the direct client completes the loop by polling
`mutation.result` / `git.commit.result`. A direct ChatGPT session is therefore *not* fire-and-forget
by default — which is the accepted design, not a gap.

The preparation instrument reports whether a `goalLeaseId` is named. It also distinguishes the two
authorities: a Goal UI Delegation lifts **Run**, and the direct path has no page and no Run gesture
— the MCP call *is* the proposal — so a delegation is irrelevant here. An earlier draft of the
banner conflated them and raised an alarm on an inert placeholder id; crying wolf in a safety
banner is its own defect, and it was fixed.

### The blocker that mattered, and the fix

An independent review found it, and it is the whole reason this milestone is not just a transport
receipt. A named `goalLeaseId` could never admit anything on this surface:

```text
src/repository-engineering-runtime.ts:78   sessionId: `sid_${randomUUID()}`   minted per process
src/goal-lease.ts:396                      admittedSessions.includes(request.sessionId) or deny
```

A lease admits only the sessions listed in its own durable row. `serve-stdio` minted a fresh
session id on every start and never emitted it, so no lease could name the session it would
actually meet — and under a tunnel the process lifetime belongs to the vendor client, so every
reconnect was a new identity. Autonomous admission here was not merely unused; it was
**unreachable**, while the startup profile reported autonomous admission as enabled.

**Classification: a WAG-side blocker to autonomous direct writes.** Not a provider gate and not a
policy choice — a defect of the family this codebase has produced twice before (a coordinator whose
decision nothing called; an activation rule nothing could satisfy).

#### The fix reuses ADR-0017 rather than inventing anything

Browser adapters have had a stable session since trusted adapter admission: a correlation resolves
to a durable adapter session, and the same correlation resolves to the same session — which is what
lets a service worker restart without orphaning its workspaces. The stdio surface now resolves its
session the same way, when and only when local configuration names a correlation:

```text
repositoryEngineering.mutation.sessionCorrelation   (human-written, local config only)
  -> adapterCorrelationDigest(ownerId, 'private.stdio.v1', correlation)   (existing derivation,
                                                                          exported, not copied)
  -> store.getOrCreateAdapterSession(...)   -> the same session_… on every start
```

What was deliberately *not* done:

| Constraint | How it is met |
| --- | --- |
| Do not relax session matching | `admittedSessions` is untouched — exact match, default-deny. The session became knowable, not optional. |
| No parallel authority plane | One row in the existing `adapter_sessions` table via the existing digest. No new table, evaluator or lease path. |
| Derived from trusted local context | Read from the local config file only — never a tool argument, the transport, client environment or repository text. |
| Persisted and recoverable through reconnects | `getOrCreateAdapterSession` returns the existing row, so a tunnel-client restart resolves the same session. |
| Reuse Goal Lease semantics | The evaluator is unchanged. It simply now has a session that can be bound. |

#### Proof that a restart cannot acquire another session's authority

`test/direct-mcp-session-binding.test.ts`, eight tests:

```text
same correlation, two starts          -> one durable session, identical id
no correlation                        -> no durable session at all; fresh per process (default intact)
different correlation                 -> different session; two configs never merge
same correlation, different owner     -> different session   (ownerId is inside the digest)
same correlation, browser adapter     -> different session   (adapterId is inside the digest)
lease bound to session A, request B   -> SESSION_NOT_ADMITTED
lease bound to session A, browser id  -> ADAPTER_NOT_ADMITTED
goalLeaseId without a correlation     -> refused at startup, not denied in silence
```

The fifth is the acquisition attempt the domain separation exists to defeat: the *identical*
correlation string, same owner, different adapter, yields a different session — so a browser session
can never inherit a lease issued for the stdio session, nor the reverse.

The last closes the failure mode that produced this blocker. A configuration that could never admit
anything now fails loudly at startup instead of reporting autonomy as enabled and denying forever.
Writing that test also caught a defect in the guard itself: the store was opened before the check,
so a refused configuration leaked a handle. The check now runs first.

#### Discovery, and why it is not a credential

A lease binds a session id, so a human issuing one out of band has to find out which id to bind. The
browser path solved this with `listAdapterSessions`; the gateway now reports `stableSessionId` on
its startup profile, and only when a correlation makes it stable — so the default profile line is
byte-identical to what it was. A session id is an identity, not a secret: it grants nothing without
a lease row a person wrote.

#### The guard-rail this milestone could not install itself — now installed

`sessionCorrelation` selects which session a lease's bindings match, so writing it is authority
configuration in the same sense that naming a lease is. The PreToolUse guard already refused an
agent writing `goalLeaseId` or `goalUiDelegationId` into a `.json`; it did **not** know about
`sessionCorrelation`. Extending it meant editing `.claude/`, which this agent is denied — so the
change was prepared as a byte-verified patch and **applied by a human out of band**. The guard now
refuses naming `sessionCorrelation` in a JSON config identically to the other two grants
(`.claude/hooks/wag-human-gate-guard.mjs`, SHA `d3218fd6…`, recorded in
`scripts/verify-delegation-rule-patch.ts`; `test/authority-issuance-guard.test.ts` pins it). The
refusal-list gap is closed.

### The composition hands a credential to a vendor-run parent

`tunnel-client` spawns WAG as its child, so WAG inherits the vendor process's environment — and
`serve-stdio` refuses to start without `DEVSPACE_OAUTH_OWNER_TOKEN` (`src/private-runtime.ts:40`).
That token must therefore be exported in `tunnel-client`'s environment. WAG deletes it from its own
environment after the OAuth exchange (line 54) and passes it to no child it spawns, but the parent
still holds it for the life of the process. This was missed in the first draft and is now printed
by the instrument, because it is a deliberate decision, not a detail.

The reverse direction is safe and was checked: nothing `tunnel-client` exports — including
`CONTROL_PLANE_API_KEY` — can reach a WAG-spawned child, because those environments are built
upward from allowlists (`VERIFY_ALLOWED_ENV_KEYS`, `ALLOWED_BASE_ENV_KEYS`).

WAG's stderr also now flows to that parent. It carries the loopback operator origin and the *path*
of the operator credential file — not the credential, which is written to a 0600 file instead. The
ADR's "every diagnostic goes to stderr" is true but was too breezy about who now reads it.

### Two exposure notes, recorded not fixed

- **`workspace.open` is unbounded.** It inserts a durable workspace row per call with no rate limit
  and no per-caller cap, while `mutation.preview` has both. Pre-existing, but this milestone is what
  puts a remote model in a loop in front of it. Impact is local state growth rather than authority
  escalation, and ADR-0019 already places a same-user actor outside the containment claim — so it is
  recorded here rather than fixed inside a milestone whose whole diff is otherwise narrowing.
- **Two tunnel profiles pointed at one config would collide.** Both gateways would open the same
  durable store and each write `${statePath}.operator-url`, so the second overwrites the first's
  bootstrap and either shutdown removes the shared file. Nothing locks against it. Pre-existing —
  but "a tunnel profile is a thing you can start twice" is a new way to reach it.

## Reuse delta

- No new transport, tool, argument, policy engine, workspace model, approval system, durable state
  machine, dependency, listener or protocol version.
- The instrument originally carried its own copy of the tool list, derived from configuration. That
  is the drift `scripts/p1a-tool-inventory.ts` exists to warn about, so it was replaced with a real
  `tools/list` against the real server, handed contexts whose every method throws.
- The instrument now gates `gitCommit` on `mutation` exactly as the runtime does, rather than
  deriving the two independently. The divergent config is unconstructible through
  `loadPrivateGatewayConfig`, which refuses it outright — so this is alignment for its own sake, and
  the only way to reach the old behaviour was a hand-built object.
- **Known duplication, recorded not resolved:** the refusing-stub pattern (a `Proxy` whose every
  method throws) now exists in two diagnostics — `scripts/p1a-tool-inventory.ts` and
  `scripts/prepare-direct-mcp-tunnel.ts`. Four lines, diagnostic only, no security decision in it.
  If a third appears it should be extracted rather than copied again.
- Minor test overlap: `mutation.preview`'s annotations are now asserted both in
  `test/mcp-surface.test.ts` and in the complete direct-surface table. Kept deliberately — deleting
  a guard to avoid redundancy is the worse trade.

## Residuals, recorded not reopened

- **`createBrowserAdmittedMcpServer` carries the same `workspace.open` misdeclaration** that was
  fixed here (`src/server.ts:206-210`): `readOnlyHint: true`, and a non-strict schema, on a call
  that reaches `AdmittedWorkspaceService.open` and inserts a durable record. Its `file.read` is also
  non-strict and none of its five tools declares `idempotentHint`.

  It was left alone deliberately, and the review then established the fact that makes that call
  comfortable: **this factory has no production caller.** Only three tests construct it. The two
  factories that *are* wired to runtimes are correct —
  `createBrowserVerifyAdmittedMcpServer` already declares `readOnlyHint: false` with a strict
  schema, and `createBrowserOperatorAdmittedMcpServer` delegates to it. So nothing shipped is
  affected, and the browser fallback path is not carrying this defect.

  It should still be corrected or deleted rather than left contradicting ADR-0030's
  `READ_ONLY_WHILE_MUTATING` rule — the next runtime wired to it would inherit the defect silently.
  Out of scope here because it blocks nothing, and because this milestone deliberately did not touch
  the browser path.
- The four `sameAuthority` copies outside `src/authority-tuple.ts` are unchanged and were not
  revisited; this milestone did not touch that code.
- The refusing-stub duplication noted in the reuse delta above.

## What is explicitly NOT proven

- **No connector was created and nothing was tunnelled.** Creating a tunnel and a runtime API key
  are account actions; no external resource was created. Gates 1 and 2 are evidenced against the
  built artifact over real stdio, which is the transport shape the tunnel uses — not through the
  tunnel itself.
- **No claim that Plus can attach a custom MCP connector, read or write.** OpenAI's current
  documentation names Business/Enterprise/Edu for full MCP and answers the Pro case as read/fetch
  only. Plus is not named at all. Absence of a statement is not a denial, but it is not evidence of
  eligibility either.
- **No claim about ChatGPT's behaviour**, including whether it would confirm, skip or block any
  given tool. Nothing was observed in ChatGPT.
- The previous mission's non-claims are unchanged and were not revisited.

## Would a Business upgrade unlock final acceptance?

**For everything WAG controls, yes — and that was not true before this milestone.** Before the fix
the honest answer would have been *no*: buying a plan would have bought direct write access to a
surface where a lease could never admit, so every bounded step would still have needed a human on
the operator route. The blocker would have survived the purchase.

After the fix, the autonomous loop closes on WAG's side. Under a configured correlation and a lease
a human issued for that session, a direct client completes
`workspace.open -> read -> mutation.preview -> mutation.result -> verify.run -> git.commit ->
git.commit.result` with no human gesture at any step: `workspace.open` and `verify.run` were never
approval-gated, and the two that are gated are exactly what the lease admits.

Three limits remain, and none of them is a WAG-side blocker:

- **ChatGPT's own confirmation.** OpenAI documents that it may ask its user to confirm a write, and
  may block some actions outright, depending on app permissions and context. That gate is inside the
  client and upstream of WAG. **No lease, setting or WAG change can suppress it, and this receipt
  does not claim otherwise.** Whether it fires per tool call is undocumented per-tool and can only
  be measured once a connector exists — so "zero clicks" cannot be promised in advance by anyone.
- **The 12-hour lease ceiling** (ADR-0028). Autonomy is bounded by design, so a person re-issues a
  lease at least daily. That is a deliberate bound, not a defect, but it means "sole working agent"
  never means "unattended indefinitely".
- **A lease's bindings are a human's decision** — roots, tools, path patterns and budgets. Work
  outside them is refused, correctly.

So: the plan gate is now the *only* thing standing between here and direct write E2E, which is what
makes the upgrade question answerable at all.

## What remains before ChatGPT can be the sole working agent

Nothing further is required of WAG. The remaining steps are all account-side:

1. Confirm, in this account's own ChatGPT settings, whether a developer-mode / custom-connector
   toggle exists on Plus. One live observation; only the account holder can make it.
2. If it does not — the documented position — obtain a plan that permits custom MCP
   (Business/Enterprise/Edu; Business needs an admin and at least two seats), **or** accept Codex as
   the OpenAI surface instead: `tunnel-client` supports it first-class, it speaks MCP, and it is
   available on this plan. That is a product decision, not an engineering one.
3. Create a tunnel and a runtime API key in the OpenAI platform, install `tunnel-client`, and run
   the profile `npm run mcp:tunnel-profile` prints.
4. Add the connector in ChatGPT and confirm any write action it asks about.

And, only if autonomous operation is wanted — each one a human act, in this order:

5. Write a `sessionCorrelation` into the local config, start the gateway once, and read
   `stableSessionId` off its `gateway.profile` stderr line.
6. Issue a Goal Lease, out of band, bound to that session id, that adapter, the intended workspace
   root, tools, path patterns and budgets. Then name it as `goalLeaseId`.

Steps 5 and 6 are what turn "ChatGPT can drive WAG" into "ChatGPT can drive WAG without a person
between steps". Neither may be performed by an agent: naming a lease is authority configuration,
and so is choosing the correlation that decides which session that lease matches.

Until step 1 resolves, `CHATGPT_DIRECT_READ_E2E` and `CHATGPT_DIRECT_WRITE_E2E` stay BLOCKED, and a
human or Claude still relays between ChatGPT and WAG. That relay is the *only* remaining reason for
an intermediary — WAG's side of the direct loop is complete and tested.

## Provider acceptance update — 2026-09-22

The provider gate described above was subsequently exercised on a real ChatGPT
Business workspace.

See:

`docs/benchmarks/2026-09-22-chatgpt-business-direct-mcp-acceptance.md`

Current observed state:

CHATGPT_DIRECT_READ_E2E                 = PASS
CHATGPT_DIRECT_PROPOSAL_E2E             = PASS
CHATGPT_DIRECT_DURABLE_WRITE_EFFECT_E2E = NOT_YET_PROVEN
CHATGPT_DIRECT_VERIFY_E2E               = NOT_YET_PROVEN
CHATGPT_DIRECT_GIT_COMMIT_E2E           = NOT_YET_PROVEN
CHATGPT_DIRECT_AUTONOMOUS_LEASE_E2E     = NOT_YET_PROVEN

The earlier BLOCKED values in this document describe the state when this
readiness receipt was originally written. They are retained as historical
evidence rather than silently rewritten.

The provider acceptance health result reported `toolCount = 6`, but that value
is the DevSpace executor contract count validated by WAG health, not the
ChatGPT-facing WAG MCP tool inventory.

DEVSPACE_EXECUTOR_TOOL_CONTRACT = 6 / PASS
CHATGPT_WAG_MCP_SURFACE_COUNT   = NOT_MEASURED

The thirteen-tool list above remains the extended WAG profile projected and
locally tested by the readiness instrument. The first provider acceptance did
not measure the live connector's complete WAG tool inventory.
