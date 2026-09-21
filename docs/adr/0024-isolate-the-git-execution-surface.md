# ADR-0024: Isolate the Git Execution Surface Behind One Policy

Date: 2026-09-20
Status: Accepted
Depends on: ADR-0014, ADR-0015, ADR-0017, ADR-0018, ADR-0019, ADR-0020, ADR-0021, ADR-0022, ADR-0023
Supersedes in part: ADR-0023's hook and content claims
Research: `docs/research/2026-09-20-wag-git-execution-surface.md`

## Context

WAG reaches `git` from five places — snapshot, list, diff, search and commit — and until now each
carried its own idea of what "safely" meant. Three hand-spelled copies of a two-flag policy in the
inspection helpers, a third with `core.hooksPath` in the commit helper, a fourth in
`environment-policy.ts` that production never imports, and no constructed environment anywhere.

That shape of duplication is what let two things be true at once: the commit path pinned
`core.hooksPath` and the inspection path did not, and neither noticed that pinning
`core.hooksPath` had stopped being sufficient.

Fresh measurement against the installed Git (2.55.0.windows.2) found four things the accepted
design got wrong. All are recorded with their reproductions in the research receipt.

1. **Config-defined hooks** — `hook.<name>.command` with `hook.<name>.event`, from the
   repository's own `.git/config` — execute on plumbing operations and are entirely unaffected by
   `core.hooksPath`. ADR-0023's "no commit hook runs" was false on this Git.
2. **A content filter executes during `git diff`**, and neither `--no-ext-diff` nor
   `--no-textconv` prevents it.
3. **An inherited `GIT_DIR` satisfies the worktree assertion** while every ref, HEAD and branch
   comes from another repository.
4. **The committed blob was not the reviewed bytes.** `git add` applied `text=auto` and
   `working-tree-encoding` silently, and the accepted `filter`-attribute gate reported
   `unspecified` for both.

## Decision

### One policy, two renderings

`src/safe-git.ts` is the only place that decides how WAG runs Git. It exports the policy as data
and as a JavaScript fragment generated from that same data:

- `SAFE_GIT_BASE_ARGS` and `buildSafeGitEnv` for Git spawned in this process, which is how the
  adversarial tests drive the policy directly against real hostile repositories;
- `SAFE_GIT_RUNNER_SOURCE`, embedded in every helper that runs inside the execution backend,
  because that backend accepts one shell command string and no argv.

The flags and the environment allowlist come from shared constants, so they cannot drift. The
driver-enumeration logic is genuinely written twice, and an independent review proved that matters:
the exported version used a `Set` and handled a driver named `__proto__` correctly, while the
emitted runner used a plain object, where assigning that name creates no own property and
`Object.keys` silently dropped it. The claim is therefore not "cannot drift" but "is tested for
equivalence": one test executes the emitted runner itself against the same hostile repository the
rest of the matrix drives through the exported policy.

### What the policy does

```text
--no-optional-locks --literal-pathspecs -P
-c core.fsmonitor=      -c core.pager=       -c core.editor=
-c core.askPass=        -c core.sshCommand=  -c diff.external=
-c gpg.program=         -c credential.helper=  -c sequence.editor=
-c init.templateDir=    -c protocol.allow=never  -c uploadpack.packObjectsHook=
-c core.hooksPath=<empty directory this process owns>

GIT_CONFIG_COUNT / GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n>:
  filter.<each>.clean= .smudge= .process= .required=false       enumerated per repository
  hook.<each>.command= .enabled=false                           enumerated per repository
```

The driver suppression is deliberately **not** `-c`. A driver name is chosen by the repository and
may contain `=`, and Git splits a `-c` argument on the first `=`: for a driver named `a=b`,
`-c filter.a=b.clean=` sets the unrelated key `filter.a` and leaves the hostile value live. That
was arbitrary command execution on the read tools and on an unapproved commit plan, found by
review and reproduced. The environment form keeps key and value in separate variables, has the
same precedence, and no name can escape it.

The rest is an environment built upwards from an allowlist, so no `GIT_*` from the parent survives
and no unrelated secret is inherited. WAG re-adds only the variables it owns for one operation:
`GIT_INDEX_FILE`, and the object-directory pair a non-persisting preview needs.

The two enumerated groups are the answer to attacker-chosen names: the driver is named by the
repository, so there is no fixed key to pin, but one `git config --get-regexp` — which executes
nothing — yields every name at every configuration level.

`--literal-pathspecs` replaces the per-call-site `:(literal)` prefixes. They are mutually
exclusive, and the global flag is the stronger: it applies to every argument of every command
rather than to the ones a call site remembered.

### The commit content pipeline

`git add` is gone from the trusted path. In its place:

```text
reviewed bytes on disk
  -> WAG's own end-of-line normalization, only when the effective attributes say git would
  -> git hash-object -w --no-filters --stdin        blob is exactly those bytes
  -> git update-index --add --cacheinfo <mode>,<oid>,<path>   mode read back and verified
  -> git write-tree
  -> git diff-tree --name-status                    refuse anything but A or M
  -> git commit-tree, message on stdin
  -> git update-ref <ref> <new> <exact previewed old>     compare-and-swap
```

The mode is HEAD's own for an existing path and `100644` for a new one, then read back from the
index and compared — `update-index --cacheinfo` accepts `040000`, `170000` and `0` with exit 0
and silently coerces or drops them, so its exit status proves nothing. A path whose HEAD entry is
a symlink or a gitlink is refused rather than converted into a blob.

#### End-of-line conversion is performed, not refused, and is reported

Refusing to commit a file containing CR would have been the simplest rule and is unusable: with
`core.autocrlf=true`, the common Windows setting, every text file git checks out has CRLF on disk
while its blob has LF. Committing worktree bytes verbatim would rewrite every such file.

So WAG converts, itself, in code, only when the effective `text` attribute and `core.autocrlf`
say git would, skipping content git would treat as binary — which means reproducing git's own
`convert_is_binary`: a NUL, **a lone CR**, or too few printable characters in the first 8000
bytes. Checking only the NUL, as the first implementation did, stripped CR bytes that `git add`
would have kept. An unrecognized `text` value is not a refusal either; git falls back to
`core.autocrlf`, and so does WAG. The converted paths are bound into the
proposal and named on the review page, so the operator approves a transformation they can see.

What remains forbidden is the repository performing a conversion: a `filter` attribute is a
program and is refused, and `working-tree-encoding` is a re-encode and is refused.

#### A proposal writes nothing

Planning runs with `GIT_OBJECT_DIRECTORY` pointed at a WAG-owned temporary directory and the
repository's own objects reachable through the alternates FILE. Reads resolve;
writes are discarded with the directory. Approval re-plans with persistence on, because a commit
has to outlive the helper process.

The alternates *file* rather than `GIT_ALTERNATE_OBJECT_DIRECTORIES`: git splits that variable on
the platform path separator, which on Windows is `;` — a legal NTFS filename character — and
quoting the value makes git refuse to normalize it at all. The file takes one path per line.

This closes the gap ADR-0023 listed as not accepted.

### Repository identity

The worktree assertion stays and is joined by the git dir, the common dir and the working
directory, all bound into the proposal and revalidated before the ref moves.

It also applies to the **read** tools now. `repo.diff`, `repo.search`, `repo.list` and
`repo.snapshot` had no such assertion, so a repository's own `core.worktree` turned them into a
file-disclosure primitive for any directory the operator can read: the host validates
`<root>/f.txt`, which exists, while the bytes git returned came from elsewhere. Reproduced by
review against all four. The worktree alone was not enough: an inherited
`GIT_DIR` leaves `--show-toplevel` reporting the admitted worktree.

The environment allowlist is what actually removes that variable; the binding is what catches a
repository that moved between proposal and approval.

## Consequences

Accepted:

- one policy, applied by construction, exercised directly by tests against real hostile
  repositories rather than only through the execution backend;
- config-defined hooks, hook-directory hooks, content filters, external diff, textconv, fsmonitor,
  pager, editor, askpass, credential helper, ssh command and gpg program cannot execute through
  any WAG Git invocation;
- no `GIT_*` and no unrelated secret is inherited by a Git child;
- the committed blob is the reviewed bytes, with one named and reported exception;
- the committer, not only the author, is bound and revalidated — `commit-tree` stamps both from
  the same untrusted configuration;
- an unapproved proposal writes no object into the repository.

Not accepted, and stated rather than implied:

- hooks and objects produced by the **execution backend's own** operations. Opening a workspace is
  the backend's MCP call and it writes a review checkpoint; WAG cannot pass git options into it.
  The tests attribute those invocations explicitly instead of subtracting them silently;
- repositories using a `filter` attribute, such as git-lfs, on a selected path;
- repositories using `working-tree-encoding` on a selected path;
- containment against a fully compromised same-user account, unchanged from ADR-0017/0019.

## Security invariants

```text
GIT_EXECUTION_POLICY = SINGLE_SHARED_MODULE
GIT_POLICY_DRIFT_BETWEEN_CALL_SITES = IMPOSSIBLE_BY_CONSTRUCTION
GIT_CHILD_ENVIRONMENT = ALLOWLIST_CONSTRUCTED
INHERITED_GIT_VARIABLES = NONE
HOOKS_DIRECTORY_AND_CONFIG_DEFINED_HOOKS = BOTH_SUPPRESSED
CONTENT_FILTERS = ENUMERATED_AND_DISABLED
PATHSPEC_MAGIC = DISABLED_GLOBALLY
COMMITTED_BLOB = REVIEWED_BYTES_PLUS_REPORTED_EOL_ONLY
GIT_ADD_IN_COMMIT_PATH = FORBIDDEN
TREE_ENTRY_MODE = CHOSEN_AND_VERIFIED
PROPOSAL_OBJECT_WRITES = NONE
REPOSITORY_IDENTITY = WORKTREE_PLUS_GITDIR_PLUS_COMMONDIR_PLUS_CWD
REPOSITORY_IDENTITY_ON_READ_TOOLS = ASSERTED
DRIVER_SUPPRESSION_CHANNEL = CONFIG_ENVIRONMENT_NOT_DASH_C
AUTHOR_AND_COMMITTER = BOTH_BOUND_AND_REVALIDATED
EOL_BINARY_HEURISTIC = MATCHES_GIT_CONVERT_IS_BINARY
EMITTED_RUNNER = TESTED_DIRECTLY_NOT_ONLY_MIRRORED
BACKEND_OWN_GIT = OUTSIDE_WAG_CONTROL_AND_ATTRIBUTED
```

## Decision markers

```text
ADR_0024 = ACCEPTED
ADR_0023_HOOK_CLAIM = NARROWED_BY_THIS_ADR
ADR_0023_UNAPPROVED_OBJECT_WRITES = CLOSED_BY_THIS_ADR
NEW_DEPENDENCY = NONE
NEW_EXECUTION_PRIMITIVE = NONE
PUSH_FETCH_REMOTE = STILL_NOT_AUTHORIZED
```
