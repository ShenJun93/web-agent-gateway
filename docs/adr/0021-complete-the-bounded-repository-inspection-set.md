# ADR-0021: Complete the Bounded Repository Inspection Set on the Private Stdio Surface

Date: 2026-09-19
Status: Accepted
Depends on: ADR-0003, ADR-0014, ADR-0015, ADR-0018, ADR-0020
Design: `docs/superpowers/specs/2026-09-19-wag-dc-replacement-v1-design.md`
Research: `docs/research/2026-09-19-wag-dc-replacement-v1-surface-selection.md`
Acceptance plan: `docs/superpowers/plans/2026-09-19-wag-dc-replacement-v1-acceptance.md`

## Context

ADR-0020 made the private stdio surface WAG's DC-replacement repository-engineering surface and
enabled `repo.search` plus reviewed mutation there. Working through a real engineering task on that
surface exposed two remaining gaps that no existing capability covers:

1. **No way to enumerate a directory.** The backend offers no listing or stat primitive at all;
   `git ls-files` through the execution port is the only route, and nothing exposed it. An operator
   could search for a known symbol but could not answer "what is in `src/lib`".
2. **No way to read a change.** `repo.snapshot` returns `git diff --stat`, a count of changed lines
   per file. Reviewing an applied change — the step that makes a reviewed mutation trustworthy —
   required leaving WAG for a shell.

Both are inspection, not effect. Neither needs an authority class the project has not already
accepted for `repo.search` and `repo.snapshot`.

## Decision

The private stdio surface's opt-in inspection profile is completed with two read-only tools:

```text
repo.list   immediate tracked and untracked-not-ignored entries of one workspace directory
repo.diff   bounded unified diff of the working tree against HEAD, optionally scoped to a path
```

The config flag that gates them is renamed from `repositoryEngineering.search` to
`repositoryEngineering.inspect`, because it now admits a set rather than one tool. The flag remains
a local opt-in that defaults to `false`; the shipped default surface is still exactly the five
accepted tools, and the Business stdio five-tool acceptance is unchanged.

Extended profile, in registration order:

```text
health, workspace.open, repo.list, repo.search, repo.snapshot, repo.diff, file.read, verify.run
  [+ mutation.preview, mutation.result when mutation is separately configured]
```

### Bounds

- `repo.list` returns immediate children only, never a recursive walk. Directories are derived from
  path prefixes, so no directory is reported that contains no listable entry.
- Ignored files are excluded, because both listings come from git with `--exclude-standard`.
- `repo.list` caps entries at a caller-supplied maximum, clamped to `[1, 1000]`, and then to the
  64 KiB result ceiling shared by every inspection response.
- `repo.diff` compares the working tree against `HEAD` only. It exposes no arbitrary revision range,
  no `show_changes` review checkpoint, and no untracked content.
- `repo.diff` truncates on a line boundary at the same 64 KiB ceiling and reports `truncated`.
- Both refuse any path that fails the existing workspace-relative path policy, which already denies
  traversal, absolute paths, Windows-reserved names and sensitive segments such as `.git`. Both also
  apply the same realpath confinement `file.read` applies, so the workspace boundary is asserted by
  WAG rather than inherited from whatever git happens to do with a symlink.
- An absent path means the whole workspace. A path that is *supplied* but normalizes to nothing —
  `"/"`, `"\\"`, `".//"` — is refused rather than silently widened to the whole workspace, because a
  confinement function must not fail open.
- `repo.diff` withholds whole per-file sections whose path is sensitive under that policy, and
  reports `truncated` when it does. Without this the one tool that returns bulk file bodies would
  hand over exactly the `.env` and `.npmrc` contents the denylist exists to withhold, which
  `repo.search`, `file.read` and `mutation.preview` all already refuse.
- Paths reach git as `:(literal)` pathspecs, so pathspec magic and wildmatch cannot expand a
  caller-supplied prefix into files it did not name.

### Caller input is never shell syntax

The execution port accepts a single shell command string and offers no argv form, so a
caller-supplied path could otherwise become shell syntax. Both tools reuse the mechanism already
accepted for `repo.search`: the path is base64url-encoded, decoded inside a WAG-owned helper, and
handed to git as one argv element via `spawnSync`. The helper source is a compile-time constant;
caller input is never evaluated.

This is an acceptance requirement, not an implementation detail, and is covered by a test that
creates a directory whose name is valid on NTFS but full of `cmd.exe` syntax and proves the embedded
command does not run.

## Consequences

Accepted:

- an operator can navigate, search, inspect state and review a diff entirely within WAG;
- the inspection half of the DC-replacement workflow no longer needs a shell or Desktop Commander;
- `repositoryEngineering.inspect` is the single gate for the read-only set.

Not accepted by this ADR:

- any browser surface change; the Browser Inspect and Browser Verify profiles are untouched and
  still expose neither `repo.list` nor `repo.diff`;
- recursive listing, file stat, size or mode reporting;
- arbitrary revision ranges, `git log`, blame, or branch/worktree enumeration;
- reviewed file creation, deletion or move, which remain unavailable and are deferred to their own
  gated milestone because the accepted durable mutation contract is defined over an existing file's
  before/after content;
- Git mutation of any kind;
- raw shell, process or argv-supplied execution.

## Security invariants

```text
NEW_AUTHORITY_CLASS = NONE
INSPECTION_TOOLS = READ_ONLY
CALLER_PATH_AS_SHELL_SYNTAX = FORBIDDEN
CALLER_PATH_AS_ARGV_ELEMENT = REQUIRED
CALLER_PATH_AS_GIT_PATHSPEC_MAGIC = FORBIDDEN
SCOPED_PATH_REALPATH_CONFINEMENT = REQUIRED
SUPPLIED_PATH_NORMALIZING_TO_EMPTY = DENIED
IGNORED_FILES_IN_LISTING = FORBIDDEN
SENSITIVE_FILE_BODIES_IN_DIFF = WITHHELD_AND_FLAGGED
RESULT_CEILING = 64_KIB_WITH_TRUNCATION_FLAG
DEFAULT_STDIO_PROFILE = FIVE_TOOLS_UNCHANGED
BROWSER_SURFACE_CHANGE = NONE
OPERATOR_BOOTSTRAP_TOKEN_ON_INHERITED_STDERR = FORBIDDEN
```

## Decision markers

```text
ADR_0021 = ACCEPTED
GATE_FLAG = repositoryEngineering.inspect
RENAMED_FROM = repositoryEngineering.search
ADDED_TOOLS = repo.list, repo.diff
FILE_CREATION = DEFERRED_SEPARATE_MILESTONE
GIT_MUTATION = NOT_AUTHORIZED
```
