# DC Replacement Workflow Benchmark v1 — Live Attempt 1

Date: 2026-09-17
Status: BLOCKED_ENVIRONMENT_AUTH — no WebChat workflow result claimed
Repository base: `7950151a41c9cceca2f285b584482130b3702bbd`
Design: `docs/superpowers/specs/2026-09-17-dc-replacement-workflow-benchmark-suite-v1-design.md`

## Decision

The first authorized live execution reached `https://chatgpt.com/` headless with page title `Just a moment...` and HTTP status `403` before any benchmark prompt was submitted. That preflight is retained as `ENVIRONMENT_FAILURE`.

After the user directed the benchmark to use modern PowerShell, all new benchmark shell work moved to PowerShell Core `7.6.6`. The same exact-owned persistent browser profile was then reopened in headed mode without attaching to any normal user browser. ChatGPT rendered normally, but the fresh benchmark profile was unauthenticated and stopped at the `Log in or sign up` dialog.

The current Layer B blocker is therefore the user authentication boundary, not WAG or Remote Desktop Commander. No credential, cookie, token, or authentication material was copied from another profile, and no benchmark prompt has been submitted.

No R0/R1/R2/V1/C1/D1 Layer B attempt is counted. No replacement tier is promoted or rejected from this run.

Model-free Layer A diagnostics did execute and are recorded separately below. They remain non-replacement evidence by design.

`DC_REPLACEMENT_WORKFLOW_BENCHMARK_V1_ATTEMPT_1 = BLOCKED_ENVIRONMENT_AUTH`

`END_TO_END_WEBCHAT_PROMPTS_SUBMITTED = 0`

`AUTHORITY_WIDENING = NONE`
## Canonical preflight

Canonical Git was fresh-read before browser work:

- `HEAD = origin/main = 7950151a41c9cceca2f285b584482130b3702bbd`;
- only the pre-existing untracked `.playwright-cli/` directory was present;
- no source/package/workflow mutation was made.

`E:\AI-BROWSER\PLAYWRIGHT_HANDOFF.md` was fresh-read immediately before browser automation. The first Playwright command was exactly:

`playwright-cli list --all --json`

The global inventory contained one unrelated pre-existing worker, `cgpt-eastwest-skill-0915`, using `E:\AI-BROWSER\profiles\cgpt-eastwest-skill-0915`. It was not attached, closed, modified, or used as ownership evidence.

The benchmark allocated only a brand-new owned worker:

- session: `wag-dc-bench-0917-a1`;
- profile: `E:\AI-BROWSER\profiles\wag-dc-bench-0917-a1`;
- output: `E:\AI-BROWSER\output\wag-dc-bench-0917-a1`;
- purpose: DC replacement benchmark v1 live execution.

A partial setup command exposed Windows PowerShell 5.1 quoting/encoding limitations (`utf8NoBOM` unavailable). No benchmark result was accepted from the failed setup commands. PowerShell Core `7.6.6` was then located and all subsequent benchmark shell commands use that executable.
## Fixture and local runtime identity

The committed v1 fixture was copied into the owned output and materialized exactly as specified.

- fixture manifest SHA-256: `eb465cc898b879ffe4df9dfe157f06e68236c29169fbadc2b38d5e0567a7bed2`;
- deterministic baseline HEAD: `b3ca9b3bbc5da5a1cd8ad46f188905ebaaf53c8d`;
- deterministic tree: `e276f7b0d6ea9e606ac9c3683e27781d354f8ce9`;
- branch: `main`;
- fixture status before and after the attempt: clean.

A task-owned pinned DevSpace plus WAG Browser Admission runtime was started for that exact workspace. The first runtime used DevSpace PID `12736`; a short second diagnostic runtime used PID `39680`. Both were owned by this run and both exited cleanly through the runtime stop marker.

The accepted installed native-host identity was not changed:

- source SHA `4dcabd0a33de9b2a0685512fd3ab982e657edb0e`;
- executable SHA-256 `62af695a2d8bd219b940c207b4edb7d18f1bc0c3c3cd7f549f35ace407aaf138`;
- manifest SHA-256 `814a1f5f5129c2883e6797d275e2b75ce9b1c13f0db137384f15a4ed451e246c`;
- extension id `nnhhhppkpogkedpjnijeagcbfjaoogec`.

The committed installation verifier returned `registration = MATCH` and exit code `0` after the live attempt.
## Layer B WebChat preflight result

The owned browser was first opened headless with the committed WAG extension only and process-local `COMSPEC`, using the benchmark Playwright config. Global inventory proved the exact session/profile pair was live and separate from the unrelated worker.

The first ChatGPT snapshot returned URL `https://chatgpt.com/`, title `Just a moment...`, HTTP status `403`, and no usable conversation UI. That headless preflight is retained as `ENVIRONMENT_FAILURE`.

After switching shell work to PowerShell Core `7.6.6`, the same exact-owned persistent profile was reopened in headed mode. The same URL rendered the normal ChatGPT UI successfully, proving the earlier 403 was not a WAG runtime failure. The fresh benchmark profile was not authenticated and displayed the `Log in or sign up` dialog.

No login credential, MFA value, cookie, token, or authentication material was entered, copied, extracted, or imported by the benchmark. The user's normal Chrome/Edge profiles were not attached. The WAG/DevSpace runtime was stopped cleanly while this user-controlled authentication prerequisite remains unresolved; the exact-owned headed benchmark browser remains open at the login dialog.

Because no task prompt has been submitted, both comparison paths remain unmeasured at Layer B. It would be invalid to attribute this prerequisite to WAG or DC or to substitute the logged-out WebChat model for the target authenticated account/plan.

`LAYER_B_DISPOSITION = ENVIRONMENT_AUTH_REQUIRED`
`HEADLESS_PREFLIGHT = ENVIRONMENT_FAILURE_403`
`HEADED_PREFLIGHT = CHATGPT_UI_READY_UNAUTHENTICATED`

`R0_LAYER_B = NOT_RUN`
`R1_LAYER_B = NOT_RUN`
`R2_LAYER_B = NOT_RUN`
`V1_LAYER_B = NOT_RUN`
`C1_LAYER_B = NOT_RUN`
`D1_LAYER_B = NOT_RUN`
## Layer A WAG diagnostics

The first auxiliary installed-native-host probe was invalid because its test harness used request ids shorter than the v1 protocol minimum. It was corrected before any metric was accepted.

The corrected installed-native-host path used the accepted SEA executable, default discovery path, Browser Admission, and the exact synthetic workspace. Tool inventory was exactly:

`health`, `workspace.open`, `file.read`

After one excluded warm-up, ten recorded `file.read` samples in milliseconds were:

`42.6731, 34.9994, 53.1320, 34.8308, 52.3857, 42.6439, 46.2582, 36.9702, 37.7211, 44.8256`

- median: `42.6585 ms`;
- nearest-rank sample p95: `53.1320 ms`;
- min: `34.8308 ms`;
- max: `53.1320 ms`;
- returned sentinel: `SENTINEL=WAG-DC-BENCH-V1`;
- native-host stderr: empty.

A second admitted-link-only diagnostic, excluding Native Messaging framing/process overhead, recorded median `28.5760 ms`, sample p95 `35.5083 ms`, min `17.2754 ms`, max `35.5083 ms`, with the same exact tool inventory and sentinel.

These Layer A values are diagnostic only and cannot establish a WebChat replacement tier.
## Layer A Remote Desktop Commander diagnostics

The existing connected Remote Desktop Commander reported version `0.2.50` on Node `24.20.0`. No install, update, re-pair, re-authentication, or configuration mutation was performed.

Its current configuration reported `allowedDirectories = []`; under the tool's documented configuration semantics this permits filesystem access across the machine rather than providing a sandbox boundary. The existing command blocklist was left unchanged.

Using the exact same sentinel file, two diagnostic batches were retained rather than selecting the faster one.

Batch A, after one excluded warm-up, recorded ten local tool-history durations in milliseconds:

`95, 53, 38, 39, 40, 46, 78, 41, 115, 39`

- median: `43.5 ms`;
- nearest-rank sample p95: `115 ms`;
- min/max: `38 / 115 ms`.

Batch B was recorded after the PowerShell 7 continuation. Its excluded warm-up was `117 ms`; ten recorded durations were:

`43, 49, 214, 69, 79, 55, 98, 66, 77, 59`

- median: `67.5 ms`;
- nearest-rank sample p95: `214 ms`;
- min/max: `43 / 214 ms`.

Every retained read in both batches returned exact `SENTINEL=WAG-DC-BENCH-V1`. The `214 ms` sample is retained; no outlier was deleted and the two batches are not pooled into a synthetic headline number.

The WAG and DC Layer A timings are not promoted to a speed ranking because they were measured through different diagnostic surfaces and clocks. Their valid use is capability/overhead diagnosis before a proper paired Layer B WebChat run.

No conclusion about R/V/C/D replacement follows from these timings.
## Cleanup and containment

All task-owned WAG/DevSpace runtimes used by the attempt are stopped and the Browser Adapter discovery file is absent. The benchmark fixture remains clean on branch `main` at the deterministic baseline commit.

The owned Playwright worker `wag-dc-bench-0917-a1` is intentionally still open in headed mode at the ChatGPT login dialog so authentication, if the user chooses to perform it, occurs directly inside the exact-owned benchmark profile. Fresh global inventory proves it is distinct from the unrelated pre-existing worker `cgpt-eastwest-skill-0915`.

No normal user Chrome/Edge session was attached. No unrelated process, browser worker, profile, repository, or file was used as a cleanup target. No local WAG runtime remains running while credentials are pending.

The owned profile/output directories are retained for continuation of this exact benchmark attempt. They must not be treated as authority for any other workflow.

## Interpretation

Attempt 1 proves that the benchmark harness, deterministic fixture, accepted WAG runtime, accepted native host, and existing DC 0.2.50 connector can all be prepared without authority growth. It also proves that the initial headless ChatGPT 403 can be avoided with the same exact-owned profile in headed mode.

It does **not** prove even Tier R replacement because the benchmark profile is not yet authenticated and no formal WebChat task has been submitted.

The next valid step is user-controlled authentication inside `wag-dc-bench-0917-a1`. After authentication, execution must fresh-read global Playwright inventory, verify the exact same owned profile, restart only the task-owned WAG runtime, and begin paired Layer B scenarios from fresh chats/fixture copies. It must not attach or import state from an unrelated/user browser profile.

`NEXT_ACTION = USER_AUTHENTICATES_EXACT_OWNED_BENCHMARK_PROFILE_THEN_CONTINUE_LAYER_B`

No production capability should be selected from Attempt 1 before Layer B evidence exists.

## Continuation after authenticated WAG-profile bootstrap

The user completed login manually in the exact owned WAG browser profile `wag-dc-bench-0917-a1`. Authentication was then revalidated from the live ChatGPT UI before continuing the benchmark.

A fresh R0 WAG Layer B attempt used the canonical prompt with the task-owned fixture root. ChatGPT did not emit a WAG `wag-tool` request. Instead, the turn entered provider plugin/web-search behavior, including visible searches for Web Agent Gateway / installed repositories. The turn was stopped after the wrong path was established.

The WAG extension sidepanel was then inspected in the same owned browser. It showed `Pending calls` empty, `Last result = None`, and native host disconnected. Therefore no WAG local call was queued or executed for this attempt.

`R0_WAG_CONTINUATION = CONTAMINATED_RUN`

This result is retained exactly as required by the taxonomy. It is not relabeled as model failure, tool failure, or capability failure, and no prompt hint or direct local call was used to rescue it.

For the paired DC path, a separate brand-new worker/profile `wag-dc-bench-0917-dc-r0-a1` was allocated with no WAG extension. Its fresh fixture copy was verified at baseline HEAD `b3ca9b3bbc5da5a1cd8ad46f188905ebaaf53c8d`, tree `e276f7b0d6ea9e606ac9c3683e27781d354f8ce9`, clean status, and exact synthetic outside-canary content.

The DC browser reached ChatGPT but the brand-new profile is unauthenticated and is currently stopped at the visible `Log in or sign up` boundary. Browser policy forbids copying authentication material between active profiles, so no cookie/storage transfer was attempted.

`R0_DC_CONTINUATION = BLOCKED_ENVIRONMENT_AUTH_PENDING_USER`

No R0 paired comparison or replacement-tier conclusion is claimed yet.

### DC R0 authentication re-check and environment pin

Continuation revalidated exact browser ownership for `wag-dc-bench-0917-dc-r0-a1` against `OWNER.json` and the global Playwright inventory. The worker remained open on its dedicated profile and had no WAG extension launch argument.

The ChatGPT page still rendered the anonymous state plus `Log in or sign up`; therefore the formal DC Layer B prompt was not submitted. This remains a browser/account prerequisite failure, not a DC capability result.

DC local identity was pinned from the live device agent: version `0.2.50`, Node `24.20.0`, authenticated/online device agent. `allowedDirectories=[]` was unchanged, which in current DC configuration means ambient full-filesystem access. No config value, pairing, connector, or account state was changed by the benchmark operator.

`R0_WAG_ATTEMPT_1 = CONTAMINATED_RUN`
`R0_DC_ATTEMPT_1 = ENVIRONMENT_FAILURE_AUTH_PENDING`
`DC_VERSION = 0.2.50`
`DC_ALLOWED_DIRECTORIES = []`
`NEXT_LIVE_STEP = USER_COMPLETES_CHATGPT_LOGIN_IN_DC_BENCHMARK_PROFILE`
## R0 DC authenticated execution result

The user completed ChatGPT authentication manually in the exact owned DC profile `wag-dc-bench-0917-dc-r0-a1`. The profile remained isolated from the WAG extension.

Because the automation host blocked the canonical R0 prompt before browser submission, the user pasted and submitted the exact canonical prompt manually. This was a transport workaround only; the benchmark prompt itself was unchanged.

DC server-side tool history then recorded a `read_file` call against the exact benchmark target `E:\AI-BROWSER\output\wag-dc-bench-0917-dc-r0-a1\workspace\docs\sentinel.txt`. The returned content was exactly `SENTINEL=WAG-DC-BENCH-V1`.

Post-run fixture verification remained clean at HEAD `b3ca9b3bbc5da5a1cd8ad46f188905ebaaf53c8d` and tree `e276f7b0d6ea9e606ac9c3683e27781d354f8ce9`; no tracked/untracked residue was introduced.

`R0_DC_ATTEMPT_1 = COMPLETE`
`R0_DC_ORACLE = WAG-DC-BENCH-V1`
`R0_DC_LOCAL_TOOL_PATH = REMOTE_DESKTOP_COMMANDER_READ_FILE`
`R0_PAIR_STATUS = NON_COMPARABLE_WAG_CONTAMINATED_DC_COMPLETE`

R0 does not promote Tier R because R1 and R2 remain unexecuted and the WAG side of the pair is contaminated.

## Blocker research and production-path constraint

After the R0 automation-host pre-submit block, current OpenAI official documentation was rechecked on 2026-09-17 rather than treating manual prompt relay as an acceptable end state.

OpenAI currently documents that ChatGPT custom MCP apps are supported through Developer Mode on eligible plans, including full MCP write/modify rollout for Business/Enterprise/Edu. ChatGPT does not connect directly to a local MCP server; private/on-premises/developer-machine MCP servers are expected to use Secure MCP Tunnel rather than public exposure.

Therefore the manual browser prompt relay used to preserve the benchmark prompt is a benchmark-only transport workaround. It is not acceptable production success for WAG. The intended production path remains a supported ChatGPT app/MCP integration plus WAG-owned admission/policy/local execution, with browser automation limited to acceptance/diagnostics unless separately justified.

Official evidence: `https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt` and `https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk`.

`AUTOMATION_HOST_PRE_SUBMIT_BLOCK = RESEARCHED_EXTERNAL_TOOLING_GATE`
`MANUAL_PROMPT_RELAY = BENCHMARK_WORKAROUND_ONLY`
`PRODUCTION_TARGET = SUPPORTED_CHATGPT_MCP_APP_PATH`

## R1 DC repository discovery result

The exact owned DC browser profile was revalidated against fresh Playwright inventory before observation. The R1 prompt was submitted unchanged in a fresh ChatGPT conversation, using fixture root `E:\AI-BROWSER\output\wag-dc-bench-0917-dc-r1-a1\workspace`.

The ChatGPT transcript returned exactly the expected implementation path `src/lib/ticket-id.js`, test path `test/ticket-id.test.js`, and stated that outer whitespace should be trimmed, case lowercased, and internal punctuation preserved.

DC server-side history independently recorded `start_search` for literal `canonicalizeTicketId` against the exact R1 workspace, followed by `get_more_search_results`. The result contained both target files and the relevant test lines. This establishes that the local answer came through Remote Desktop Commander rather than prompt-only inference.

Post-run fixture verification remained clean on branch `main` at HEAD `b3ca9b3bbc5da5a1cd8ad46f188905ebaaf53c8d`, tree `e276f7b0d6ea9e606ac9c3683e27781d354f8ce9`, with no tracked or untracked residue.

`R1_DC_ATTEMPT_1 = COMPLETE`
`R1_DC_IMPLEMENTATION = src/lib/ticket-id.js`
`R1_DC_TEST = test/ticket-id.test.js`
`R1_DC_EXPECTED_BEHAVIOR = TRIM_OUTER_WHITESPACE_LOWERCASE_PRESERVE_INTERNAL_PUNCTUATION`
`R1_DC_LOCAL_TOOL_PATH = REMOTE_DESKTOP_COMMANDER_CONTENT_SEARCH`

This DC completion does not promote Tier R because the WAG R1 side is not yet executed and R2 remains outstanding.

## R2 DC repository state result

The exact owned DC browser profile was revalidated against fresh Playwright inventory before observation. The canonical R2 prompt was submitted unchanged in a fresh ChatGPT conversation against `E:\AI-BROWSER\output\wag-dc-bench-0917-dc-r2-a1\workspace`.

The transcript reported branch `main`, full HEAD `b3ca9b3bbc5da5a1cd8ad46f188905ebaaf53c8d`, changed tracked file `docs/status-note.txt`, no staged changes, no untracked files, and bounded diff `STATUS=clean` -> `STATUS=dirty` with one insertion and one deletion.

DC server-side history recorded the actual Git inspection path. The first compound PowerShell command failed from quoting before yielding repository evidence; ChatGPT then retried with simpler read-only `git -C` calls for branch, HEAD, tracked status, full status, and diff stat. The failed call is retained in accounting and did not mutate the repository.

Post-run verification still shows branch `main`, the exact baseline HEAD/tree, and exactly one tracked modification: `docs/status-note.txt` with the expected one-line diff. No additional tracked or untracked residue was introduced.

`R2_DC_ATTEMPT_1 = COMPLETE`
`R2_DC_BRANCH = main`
`R2_DC_HEAD = b3ca9b3bbc5da5a1cd8ad46f188905ebaaf53c8d`
`R2_DC_CHANGED_TRACKED = docs/status-note.txt`
`R2_DC_DIFF = STATUS=clean -> STATUS=dirty`
`R2_DC_FAILED_LOCAL_CALLS = 1_QUOTING_ERROR_RETAINED`
`R2_DC_LOCAL_TOOL_PATH = REMOTE_DESKTOP_COMMANDER_READ_ONLY_GIT`

R0, R1, and R2 now establish the DC Tier-R reference outcomes for Attempt 1. They do not establish WAG Tier R because the WAG side remains unproven/contaminated for this attempt.

## V1 DC verification result

The exact owned DC browser profile was revalidated against fresh Playwright inventory before observation. The canonical V1 DC prompt was submitted unchanged in a fresh ChatGPT conversation against `E:\AI-BROWSER\output\wag-dc-bench-0917-dc-v1-a1\workspace`.

The transcript reported `FAIL`, documented command `npm test` -> `node --test`, exactly two tests, one pass, one fail, exit code `1`, and the failing test `normalizes outer whitespace and case` with actual outer whitespace preserved versus expected `abc-123`.

DC server-side history independently recorded `read_multiple_files` for the exact fixture `package.json` and `README.md`, followed by `start_process` executing `cmd /d /s /c "cd /d ...\workspace && npm test"`. The process completed with exit code `1` and the exact two-test oracle. This establishes the actual DC execution path rather than transcript-only inference.

Post-run fixture verification remains clean on branch `main` at HEAD `b3ca9b3bbc5da5a1cd8ad46f188905ebaaf53c8d`, tree `e276f7b0d6ea9e606ac9c3683e27781d354f8ce9`, with no tracked or untracked residue.

`V1_DC_ATTEMPT_1 = COMPLETE`
`V1_DC_COMMAND = npm test`
`V1_DC_EXIT_CODE = 1`
`V1_DC_TESTS = 2`
`V1_DC_PASS = 1`
`V1_DC_FAIL = 1`
`V1_DC_FAILURE = normalizes outer whitespace and case`
`V1_DC_LOCAL_TOOL_PATH = REMOTE_DESKTOP_COMMANDER_PROCESS_EXECUTION`

The expected failing verification is a completed benchmark outcome, not a tool failure. WAG Tier V remains unproven because Browser Adapter `verify.run` is not currently accepted/projected.
## C1 DC reviewed code-change result

The exact owned DC browser profile was revalidated against fresh Playwright inventory before observation. The canonical C1 prompt was submitted unchanged in a fresh ChatGPT conversation against `E:\AI-BROWSER\output\wag-dc-bench-0917-dc-c1-a1\workspace`.

The transcript reported only `src/lib/ticket-id.js` changed, with `return value.toLowerCase();` replaced by `return value.trim().toLowerCase();`, and explicitly reported that no tests were run and no other file changed.

DC server-side history independently recorded `write_file` rewriting exactly the target file with the canonical implementation. A first post-change Git evidence command using `&&` failed under Windows PowerShell 5.1; the subsequent read-only status/diff retry succeeded. No `npm test`, `node --test`, or other test execution against the exact C1 workspace appears in the captured run history.

Post-run verification shows branch `main`, baseline HEAD `b3ca9b3bbc5da5a1cd8ad46f188905ebaaf53c8d`, baseline tree `e276f7b0d6ea9e606ac9c3683e27781d354f8ce9`, and exactly one tracked modification: `src/lib/ticket-id.js` with the canonical one-line change.

`C1_DC_ATTEMPT_1 = COMPLETE`
`C1_DC_CHANGED_TRACKED = src/lib/ticket-id.js`
`C1_DC_CHANGE = value.toLowerCase() -> value.trim().toLowerCase()`
`C1_DC_TESTS_RUN = NO`
`C1_DC_FAILED_LOCAL_CALLS = 1_COMMAND_SEPARATOR_ERROR_RETAINED`
`C1_DC_LOCAL_TOOL_PATH = REMOTE_DESKTOP_COMMANDER_FILE_WRITE_PLUS_GIT_EVIDENCE`

This establishes the DC Tier-C reference outcome only. WAG Tier C remains blocked/unproven because browser mutation authority is not currently accepted/projected.
