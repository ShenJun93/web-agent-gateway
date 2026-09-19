# ADR-0023: Commit Through a Private Index and Git Plumbing, With Compare-and-Swap

Date: 2026-09-20
Status: Accepted
Depends on: ADR-0003, ADR-0008, ADR-0009, ADR-0011, ADR-0014, ADR-0015, ADR-0018, ADR-0020, ADR-0022
Design: `docs/superpowers/specs/2026-09-19-wag-dc-replacement-v1-design.md`
Acceptance plan: `docs/superpowers/plans/2026-09-19-wag-dc-replacement-v1-acceptance.md`

## Context

WAG can inspect, search, list, diff, read, verify, make reviewed edits and create reviewed files.
Committing is the last step of ordinary repository engineering it cannot do, so a session still
falls back to another tool at the end of every task.

Committing is a new authority class, not another projection: it moves a branch ref, and the obvious
implementation — `git commit` — is the single most dangerous way to do it. `git commit` runs
`pre-commit`, `prepare-commit-msg`, `commit-msg` and `post-commit` hooks, mutates the operator's
real index as an intermediate step, and takes its message through a channel that invites
interpolation.

## Evidence

Measured on 2026-09-20 against the local `git` on this machine, in scratch repositories built for
the purpose. Each claim below was observed, not assumed.

**Plumbing runs no *commit* hooks — but it is not hook-free.** With executable `pre-commit`,
`prepare-commit-msg`, `commit-msg` and `post-commit` hooks installed in `.git/hooks` *and* a hostile
`core.hooksPath` pointing at a second set, a commit built with `read-tree` + `add` + `write-tree` +
`commit-tree` + `update-ref` fired none of them.

An independent review then showed that canary set was too narrow. Git also has `post-index-change`,
fired by any index write including one into `GIT_INDEX_FILE`, and `reference-transaction`, fired by
every ref update including `update-ref`. Both fired, from `.git/hooks` and from `core.hooksPath` —
and the `plan` half runs before any human approval, so an unapproved proposal alone executed them.
A `reference-transaction` hook exiting non-zero at the `prepared` phase can also abort the update,
letting a hostile repository make every commit fail.

Passing `-c core.hooksPath=<empty directory>` on every invocation suppresses all of them, verified
against the same hostile fixture with the commit still landing correctly.

**The message is data.** A message containing `$(touch …)`, backticks and `; rm -rf /` passed on
`commit-tree` stdin was stored verbatim; no file was created.

**The real index is untouched.** With a staged change to `a.txt` in the real index, the real index
tree hash was byte-identical before and after (`c612c6c4…`), and an unrelated dirty `b.txt` stayed
` M`.

**Compare-and-swap works.** `git update-ref <ref> <new> <wrong-old>` fails with
`cannot lock ref … is at … but expected …` and leaves HEAD unchanged.

**`commit.gpgsign` does not reach `commit-tree`.** With `commit.gpgsign=true`, the resulting object
carried no `gpgsig` header. Signing cannot be triggered by configuration surprise.

**Identity is required.** With `user.name`/`user.email` unset, `commit-tree` fails with
`Author identity unknown`. This is a fail-closed precondition, not something to synthesise.

**`git add` stages a deletion.** Adding a path whose file has been removed drops it from the index.
Deletion must therefore be rejected explicitly, not assumed impossible.

**`git add` executes clean filters.** A `.gitattributes` entry of `filter=evil` plus a
`filter.evil.clean` command ran that command during `add`. `git check-attr filter -- <path>`
reports `filter: evil` versus `filter: unspecified`, and a path carrying only `text=auto` executed
nothing. Attribute-driven end-of-line normalisation is not an execution vector; a `filter`
attribute is.

**Literal pathspecs handle awkward names.** With `--` and `:(literal)`, paths with a leading dash,
spaces and `[...]` were added correctly and matched nothing else.

**`core.worktree` redirects `git add` at any directory.** A second independent review found,
and this machine's git confirmed, that a repository whose `.git/config` sets
`core.worktree = <elsewhere>` makes `git add -- :(literal)<path>` stage *that* directory's file.
With a decoy of the same name left in the workspace, `statSync`, `check-attr` and
`diff-tree --name-status` all describe the decoy, so every per-path guard passes and the
operator is shown an ordinary one-file change while the commit carries the outside file's bytes.
The same missing assertion let a workspace nested inside a larger repository commit to the
*outer* repository's branch. `git rev-parse --show-toplevel` reports the effective worktree,
including a configured `core.worktree`, so one comparison against the admitted canonical root
closes both. `-c core.worktree=…` does **not** override the repository's own value; only
`GIT_WORK_TREE` or the assertion does.

**`cmd.exe` refuses rather than truncates.** Measured: 8146 characters ran, 8246 exited 1 with
"The command line is too long." Gzipping the helper alone is not enough — an 8 KiB message or a
large path set still overflows — so the payload is gzipped too and the assembled command is
measured and refused before execution.

**Object ids are not always 40 hex.** `git init --object-format=sha256` produces 64-hex ids on
git 2.55.0.windows.2. An early 40-hex assumption refused such a repository outright with a generic
"rejected backend commit plan"; the identity checks are plain string comparisons, so accepting both
widths is correct and is covered by a sha-256 fixture test.

## Decision

WAG commits by building a **private index** and using **plumbing**, never `git commit`.

```text
every invocation: git -c core.hooksPath=<empty dir owned by this process> ...
git rev-parse --show-toplevel                   # must equal the admitted canonical root
git symbolic-ref --quiet HEAD                   # recursing form: resolves to the terminal ref
git var GIT_AUTHOR_IDENT                        # required, bound, and shown to the operator
GIT_INDEX_FILE = <WAG-owned temp index, outside the repository>
git read-tree <exact previewed HEAD>
git add -- :(literal)<each selected path>      # one argv element per path
git write-tree                                  -> tree
git diff-tree --name-status <previewed HEAD> <tree>   # refuse anything but A/M
git commit-tree <tree> -p <exact previewed HEAD>   message on stdin
git update-ref refs/heads/<branch> <new> <exact previewed HEAD>   # compare-and-swap
```

The helper **and** the payload are gzipped before base64url encoding, because the executor runs
the command through `cmd.exe`, whose command line is capped at 8191 characters. The plain
base64url of the helper alone exceeds that — found by the helper silently failing once it grew —
and a maximum-size message or path set exceeds it even with the helper compressed. The assembled
command is therefore measured against a 8000-character budget and refused with `INPUT_TOO_LARGE`
at *proposal* time, so an input that could never execute is never put in front of a human.

### The repository must prove it is the admitted one

Per-path confinement asks "is this path inside the root?". It never asked "is this git repository
the root?". Two different attacks turned on that gap — a hostile `core.worktree` and a workspace
nested in an outer repository — and both are closed by one assertion, made before anything else:

```text
git rev-parse --show-toplevel  ==  the admitted canonical root      (else WORKTREE_MISMATCH)
```

Both sides are resolved with the native realpath before comparison, because git prints forward
slashes and Windows compares case-insensitively and may hand back 8.3 short names.

### The change set, not the path set, is what is checked

Per-path guards are not sufficient, and the review proved it: if HEAD holds a directory `src/` and
the worktree replaces it with a regular file `src`, then `git add -- :(literal)src` resolves the
conflict by dropping every `src/**` entry. The path exists, is a regular file, and is present in
the index afterwards, so every per-path check passes — while the commit deletes the subtree, and
the preview shows only `["src"]`.

WAG therefore computes the resulting tree delta with `diff-tree --name-status` and refuses anything
that is not an addition or a modification. That delta is bound into the preview and rendered on the
review page, so the operator approves what the commit *does*, not what was *asked for*.

`git commit -F -` is rejected: it would run every hook and mutate the real index, and the evidence
above shows the plumbing path avoids both while producing an ordinary commit.

### Execution mechanics

The execution backend accepts a single shell command string with no argv, env or stdin channel, so
WAG reuses the mechanism already accepted for `repo.search`, `repo.list` and `repo.diff`: a
WAG-owned helper, base64url-encoded, evaluated by a `node -e` stub, which then uses `spawnSync`
with a real argv array, an explicit `GIT_INDEX_FILE` in `env`, and the commit message as `input`.
No selected path, branch name or message is ever concatenated into a shell string.

### Preconditions, all checked at preview and re-checked at approval

- `HEAD` resolves through `git symbolic-ref` to `refs/heads/<branch>`; a detached HEAD is refused;
- the branch is not in the protected set (`main`, `master` by default), which is local
  configuration and can never be relaxed by the caller;
- no in-progress operation: `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge`,
  `rebase-apply`;
- no unmerged index entries;
- the repository's top level is the admitted canonical root;
- author identity resolves (`git var GIT_AUTHOR_IDENT`), is bound into the record and the
  fingerprint, is shown to the operator, and is re-checked at approval — it comes from the
  untrusted repository configuration, so a commit cannot be re-attributed after review;
- every selected path passes the existing workspace path policy and realpath confinement, at
  proposal and again inside `approveLocal` before the backend is called;
- every selected path exists as a regular file — a missing path is a deletion request and is
  refused in v1;
- no selected path carries a `filter` attribute;
- the resulting tree differs from the previewed HEAD's tree, so an empty commit is impossible.

### What the preview binds, and approval revalidates

```text
owner + session + adapter          the exact caller tuple
workspace id and canonical root    the exact workspace
branch ref                         exact
old HEAD                           exact 40-hex
selected paths                     exact, ordered, canonicalised
resulting tree sha                 exact — recomputed at approval and compared
author identity                    exact — recomputed at approval and compared
message sha-256                    exact
fingerprint                        sha-256 over all of the above
```

If any of these drifted — HEAD moved, a selected file changed, the branch changed, the caller
differs — approval fails closed and a fresh preview is required. Nothing is committed.

### Exactly one commit

One ordinary single-parent commit. The branch moves only by compare-and-swap against the approved
old HEAD, so a concurrent commit loses rather than clobbering. Approval is single-use and
TTL-bounded, reusing the accepted durable review contract.

### A refusal and a lost helper are not the same outcome

A drift or precondition refusal is a clean failure: the ref moves only through compare-and-swap, so
nothing partial can have landed, and the record says `FAILED`. But an executor error, a helper
that was still running and had to be interrupted, truncated output or unreadable output are not
refusals — they are WAG losing sight of a process that may already have moved the ref. Those are
recorded as `OUTCOME_UNKNOWN`, the same state `reconcile()` uses after a restart, so the durable
record never claims a clean failure for a commit that may exist.

## V1 forbids

```text
amend, merge commits, allow-empty, signing, force, reset, clean, checkout/switch,
branch creation or deletion, arbitrary ref update, push/fetch/pull,
detached-HEAD commit, protected-branch commit, implicit add . / -A / unrestricted staging,
deletion and rename semantics
```

## Storage

A new `commits` table, not a new column. The store creates its schema with
`CREATE TABLE IF NOT EXISTS` on every open, so a new table appears on existing databases with no
migration, whereas a new column would need one and the store has no migration framework (ADR-0022).

Every proposal persists the caller tuple, the workspace, the branch and ref, the parent HEAD, the
candidate tree, the author, the selected paths, the resulting change set, the message and its
digest, the fingerprint, the deadline, the current state with its created/reviewed/completed
timestamps and, on success, the commit SHA. None of it is readable by the MCP caller beyond the
bounded `git.commit.result` projection.

It is a durable record of each proposal's outcome, not a transition log: unlike `mutations`,
commits do not append to `audit_events`, so an intermediate state that has already been
superseded is not recoverable. Extending the audit log to commits is deferred, and named in the
"not accepted" list below rather than glossed.

Outstanding proposals are capped per caller, because the operator's review list is finite and an
unbounded caller could bury a genuine proposal under lookalikes inside the review window.

## Configuration

`repositoryEngineering.gitCommit` requires `repositoryEngineering.mutation`, because it reuses that
block's durable store, caller context and operator review server. Configuring it alone would bind
nothing while reading like a working opt-in, so it is a load-time error.

`protectedBranches` defaults to `["main", "master"]` and, when given, must be non-empty. An empty
array reads like a default but means every branch is committable; v1 has no way to express "protect
nothing" by accident.

## The index consequence, stated plainly

Never touching the real index has a visible cost, observed in the production-local run and pinned by
a test rather than left to be discovered.

A normal `git commit` advances the index along with HEAD. WAG does not, so after a WAG commit the
operator's index still holds the pre-commit tree and `git status` renders the committed paths as
staged reversions against the new HEAD — `MM` for a modified file, `D ` for a newly committed one.

Nothing is lost: the commit, the worktree and every unrelated staged change are exactly as intended,
and WAG's own next commit is unaffected because it reads HEAD and never consults the index. But an
operator who then runs `git commit` themselves would commit those reversions.

The alternative — reconciling the index for the committed paths afterwards — was rejected for v1. It
would mutate the operator's index, and the obvious tool for it is `reset`, which this milestone
forbids. The honest v1 position is that the operator refreshes their own index when they want to,
with `git reset -- <paths>`, which touches no file content.

## Consequences

Accepted:

- a session can complete an ordinary repository task, commit included, without leaving WAG;
- hostile hooks, hostile `core.hooksPath`, hostile commit messages and hostile filenames cannot
  execute anything through WAG's own git invocations;
- a directory/file swap cannot smuggle a subtree deletion past review;
- a hostile `core.worktree`, and a workspace nested inside a larger repository, are both refused
  before anything is read or staged;
- the operator's review page names the repository, the author and the resulting change set, and
  renders bidi overrides and zero-width characters as visible code points, so the text that is
  approved is the text that will be committed;
- the operator's real index and unrelated dirty files are never disturbed, including on failure.

Not accepted:

- anything in the forbidden list above;
- committing a deletion or rename — a real gap, deferred rather than rushed, because deletion needs
  its own review affordance;
- repositories using `filter`-based attributes such as git-lfs for a selected path; those are
  refused with a clear reason rather than silently executing the filter;
- suppressing hooks the *execution backend* runs. Opening a workspace is the backend's own MCP
  operation and it writes its own review refs, so `post-index-change` and `reference-transaction`
  can still fire from there. WAG cannot pass git options into that call. No commit hook is
  reachable that way, and the tests attribute every surviving invocation to the backend explicitly;
- an append-only transition log for commits; the `commits` row records the outcome and its
  timestamps, not every intermediate state;
- pruning terminal commit rows; the table grows until an operator removes the database;
- bounding the loose objects an unapproved preview writes. Building the candidate tree writes blobs
  and trees into the object store before any human sees the proposal. Refs and the worktree are
  untouched, and git prunes unreachable objects, but "nothing is written until approved" is true of
  refs and files, not of the object database.

## Security invariants

```text
GIT_COMMIT_IMPLEMENTATION = PRIVATE_INDEX_PLUS_PLUMBING
GIT_COMMIT_VIA_PORCELAIN = FORBIDDEN
REPOSITORY_TOP_LEVEL = MUST_EQUAL_ADMITTED_ROOT
AUTHOR_IDENTITY = REQUIRED_BOUND_AND_REVALIDATED
UNOBSERVABLE_OUTCOME = OUTCOME_UNKNOWN_NEVER_FAILED
COMMAND_TOO_LARGE_TO_EXECUTE = REFUSED_AT_PROPOSAL
BIDI_AND_ZERO_WIDTH_IN_REVIEW = RENDERED_AS_CODE_POINTS
COMMIT_HOOK_EXECUTION = IMPOSSIBLE_BY_CONSTRUCTION
INDEX_AND_REF_HOOKS = SUPPRESSED_VIA_EMPTY_CORE_HOOKSPATH
BACKEND_WORKSPACE_OPEN_HOOKS = OUTSIDE_WAG_CONTROL
CHANGE_SET_NOT_PATH_SET = BOUND_AND_REVIEWED
DELETION_IN_CHANGE_SET = REFUSED
MESSAGE_AS_SHELL_SYNTAX = FORBIDDEN
PATH_AS_SHELL_SYNTAX = FORBIDDEN
REAL_INDEX_MUTATION = FORBIDDEN
BRANCH_MOVE = COMPARE_AND_SWAP_ONLY
PARENTS = EXACTLY_ONE
EMPTY_COMMIT = FORBIDDEN
DETACHED_HEAD = FORBIDDEN
PROTECTED_BRANCH = LOCAL_CONFIG_ONLY
DELETION_OR_RENAME = FORBIDDEN_IN_V1
FILTER_ATTRIBUTE_ON_SELECTED_PATH = REFUSED
APPROVAL_SINGLE_USE_AND_TTL_BOUNDED = REQUIRED
DRIFT_AFTER_PREVIEW = FAIL_CLOSED
```

## Decision markers

```text
ADR_0023 = ACCEPTED
ADDED_TOOLS = git.commit, git.commit.result
GATED_BY = repositoryEngineering.gitCommit
STORE_MIGRATION_REQUIRED = NO_NEW_TABLE_ONLY
GIT_COMMIT_REQUIRES_MUTATION = TRUE
EMPTY_PROTECTED_BRANCH_SET = CONFIG_ERROR
PUSH_FETCH_REMOTE = NOT_AUTHORIZED
```
