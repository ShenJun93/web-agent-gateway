# WAG Git Execution Surface — Research Receipt

Date: 2026-09-20
Status: RESEARCH RECEIPT — dated evidence for a trust-boundary decision
Research cut: 2026-09-20
Git under test: `2.55.0.windows.2`, Windows 11 Pro 10.0.26200, `core.autocrlf=true` in the user's global config
Consumers: `docs/adr/0024-isolate-the-git-execution-surface.md`, `src/safe-git.ts`

## Question

WAG runs `git` on repositories it does not trust, on behalf of a caller it does not trust. Two
questions needed current answers rather than remembered ones:

1. what can a repository, or the inherited environment, make `git` execute; and
2. what can make the bytes WAG commits differ from the bytes a human approved.

Sources: the Git documentation shipped with the installed build (identical text to git-scm.com),
cross-checked against upstream `git/git` v2.55.0 where the docs are silent, and — for every claim
below — a purpose-built hostile repository on this machine. Where measurement disagreed with the
documentation, measurement is recorded.

## Finding 1 — `core.hooksPath` does not suppress config-defined hooks

Git 2.53 added hooks defined in configuration rather than on disk: `hook.<name>.command` plus
`hook.<name>.event`. They are honoured from the repository's **own** `.git/config`.

```text
git config hook.evil.command <script>
git config hook.evil.event   reference-transaction

git -c core.hooksPath=<empty dir> update-ref refs/heads/probe HEAD
  -> FIRED-CONFIG-HOOK x3
git update-ref refs/heads/probe2 HEAD            (control, no pin)
  -> FIRED-CONFIG-HOOK x3
```

The same mechanism reaches commit-class events: with `hook.evil2.event=pre-commit` a commit fired
the script eight times.

**This defeated the hook defence accepted in ADR-0023 outright.** That defence pinned
`core.hooksPath` at an empty directory, which is exactly the mechanism config-defined hooks do not
use.

Suppression, measured: `-c hook.<name>.command=`, `-c hook.<name>.enabled=false` and
`-c hook.<name>.event=` each stop it independently. The driver names are enumerable without
executing anything:

```text
git config --name-only --get-regexp '^(filter|hook)\.'
```

## Finding 2 — a content filter executes during `git diff`, and no diff flag stops it

With `.gitattributes` saying `filter=evil` and `filter.evil.clean` configured:

```text
git diff --no-ext-diff --no-textconv --no-color HEAD -- .     -> FIRED x2
git diff --no-ext-diff --no-textconv --stat -- .              -> FIRED x2
git status --short --branch                                   -> (nothing)
git ls-files -z                                               -> (nothing)
git grep -F -n -I --no-textconv -C1 -z -- changed             -> (nothing)
```

`--no-ext-diff` and `--no-textconv` are about diff drivers and textconv; neither touches the
filter machinery. Overriding the driver to empty does stop it, and leaves the diff correct:

```text
git -c filter.evil.clean= -c filter.evil.smudge= -c filter.evil.process= diff ... -> (nothing)
                                                                     and still prints -original/+changed
```

## Finding 3 — external diff and textconv, for completeness

| vector | without the flag | with the flag |
| --- | --- | --- |
| `GIT_EXTERNAL_DIFF` inherited, content diff | fires | `--no-ext-diff` stops it |
| `diff.external` in repo config, content diff | fires | `--no-ext-diff` stops it |
| `diff.<driver>.textconv` via attributes | fires twice | `--no-textconv` stops it |
| `git grep`, textconv configured | does not fire by default | — |
| `diff-tree --name-status` | does not fire | — |
| `git status`, `diff --stat` | external diff does not fire | — |

## Finding 4 — an inherited `GIT_DIR` passes the worktree assertion

The repository-identity assertion accepted in ADR-0023 compares `git rev-parse --show-toplevel`
with the admitted canonical root. With `GIT_DIR` inherited from the environment:

```text
cwd = <victim worktree>, GIT_DIR = <attacker>/.git

git rev-parse --show-toplevel     -> C:/.../victim        <- assertion passes
git rev-parse --absolute-git-dir  -> C:/.../attacker/.git
git symbolic-ref --quiet HEAD     -> refs/heads/main      <- the attacker's branch
```

So every ref, HEAD and branch comes from another repository while the check sees the right
worktree. Adding `GIT_WORK_TREE` does not change the outcome.

This is reachable in principle rather than only in theory: WAG's git children inherit the
environment of the execution backend, and WAG does not start that backend — in production it
connects to an already-running one over loopback HTTP, so whatever the operator's launcher
exported is what git sees.

## Finding 5 — `-c` beats environment config injection

```text
-c only:  core.hooksPath = FROM_DASH_C
env only: core.hooksPath = FROM_ENV
both:     core.hooksPath = FROM_DASH_C
```

`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` cannot displace a command-line `-c`.
Pinning on the command line is therefore the right level, and the environment allowlist is
defence in depth rather than the only defence.

## Finding 6 — the accepted commit pipeline did not commit the reviewed bytes

`git add` applies whatever the repository's attributes ask for. Measured against the pipeline as
accepted in ADR-0023, whose only content gate was the `filter` attribute:

```text
.gitattributes: * text=auto
reviewed bytes on disk : 61 6c 70 68 61 0d 0a 62 65 74 61 0d 0a   alpha\r\nbeta\r\n
git check-attr filter  : unspecified            <- the accepted gate saw nothing
committed blob         : 61 6c 70 68 61 0a 62 65 74 61 0a         alpha\nbeta\n
```

```text
.gitattributes: e.txt working-tree-encoding=UTF-16
reviewed file  : 30 bytes
committed blob : 14 bytes
git check-attr filter : unspecified
```

`git hash-object --no-filters` produces a blob byte-identical to the file in both cases, and does
not execute the clean filter.

## Finding 7 — but exact bytes are not simply correct either

With `core.autocrlf=true`, which is this machine's global setting and a common Windows one:

```text
committed blob in HEAD : alpha\nbeta\n
file after git checkout: alpha\r\nbeta\r\n
```

Every text file git checks out has CRLF on disk while the object has LF. Committing worktree
bytes verbatim would rewrite every such file. The usable rule is therefore neither "exact bytes"
nor "let git decide": WAG performs the end-of-line conversion itself, only when the effective
attributes say git would, and reports which paths it converted.

`git hash-object -w --no-filters --stdin` fed LF bytes reproduces the HEAD blob id exactly, which
is what makes doing the conversion in WAG code equivalent to what git would have stored.

## Finding 8 — a preview need not write to the object store

Setting the primary object directory to a WAG-owned temporary one and reaching the repository's
own objects through an alternate lets a plan resolve reads and discard its writes:

```text
GIT_OBJECT_DIRECTORY            = <scratch>/objects
GIT_ALTERNATE_OBJECT_DIRECTORIES = <repo>/.git/objects

read-tree HEAD; hash-object -w --no-filters; update-index --cacheinfo; write-tree
  -> loose objects in the repository: 3 before, 3 after
  -> loose objects in the scratch directory: 2
```

This closes the gap ADR-0023 recorded as not accepted: an unapproved proposal no longer writes
blobs and trees into the operator's repository.

## Finding 9 — `update-index --cacheinfo` does not validate the mode

```text
mode 100644 -> 100644     mode 040000 -> no entry at all
mode 100755 -> 100755     mode 170000 -> 100644
mode 120000 -> 120000     mode 100000 -> 100644
mode 160000 -> 160000     mode 0      -> 100644
```

Every one of these exited 0. The mode must be chosen and then verified by reading the entry back;
the exit status proves nothing.

## Finding 10 — `--literal-pathspecs` and `:(literal)` are mutually exclusive

```text
git ls-files -- ':(literal)star[1].txt'                      -> star[1].txt
git --literal-pathspecs ls-files -- ':(literal)star[1].txt'  -> (nothing; exit 0)
git --literal-pathspecs ls-files -- 'star[1].txt'            -> star[1].txt
```

The global flag is the stronger of the two, because it applies to every argument of every command
rather than to the pathspecs a call site remembered to prefix. Directory pathspecs still match
their subtree under it.

## Finding 11 — `cmd.exe` refuses rather than truncates

```text
8146-character command line -> exit 0
8246-character command line -> exit 1, "The command line is too long."
```

The execution backend runs WAG's helper through `cmd.exe /d /s /c`, so this is the hard ceiling on
the whole encoded helper plus payload. It fails closed, but opaquely, which is why the assembled
command is measured and refused with a named reason before it is sent.

## What this receipt does not establish

- containment against a fully compromised same-user account, which ADR-0017 and ADR-0019 already
  exclude and this work does not change;
- anything about hooks or objects written by the **execution backend's** own operations, which WAG
  cannot pass git options into. Those are attributed, not suppressed.

## Addendum — findings from the independent review of the implementation

Added 2026-09-20, after an adversarial review of the change itself. Each was reproduced before
being acted on.

**A `-c` override cannot neutralize a driver whose name contains `=`.** Git splits a `-c`
argument on the first `=`:

```text
[filter "a=b"] clean = <command>        .gitattributes: * filter=a=b

git -c 'filter.a=b.clean=' config --get 'filter.a=b.clean'   -> <command>   (still live)
git -c 'filter.a=b.clean=' config --get 'filter.a'           -> b.clean=    (what it actually set)
```

The clean filter then runs on `repo.diff` and `repo.snapshot`, and a config-defined hook named the
same way runs on an unapproved commit *plan*. The environment form keeps key and value apart and
has the same precedence:

```text
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='filter.a=b.clean' GIT_CONFIG_VALUE_0=''
  -> git config --get 'filter.a=b.clean'  ->  (empty)
```

**A driver named `__proto__` is dropped by a plain-object accumulator.**

```text
const o = {}; o['__proto__'] = true; Object.keys(o)   -> []
Object.create(null) / new Set()                        -> ["__proto__"]
```

The exported policy used a `Set` and was correct; the emitted runner used `{}` and was not. This
is why the two renderings are now tested for equivalence rather than assumed equal.

**git's binary heuristic is wider than a NUL check.** `convert_is_binary` also refuses on a lone
CR and on too few printable characters in the first 8000 bytes. Measured against `git add` in an
identically configured repository, a NUL-only check made WAG differ on three inputs: content with
a lone CR, content with 300 `0x01` bytes, and a file carrying an unrecognized `text` value.

**The read tools asserted no repository identity.** A repository setting
`core.worktree = <any directory>` made `repo.diff` return that directory's file contents as diff
hunks, `repo.search` return matching lines from it, `repo.list` enumerate it and `repo.snapshot`
report its status — while the host-side path policy validated `<root>/f.txt`, which exists. The
commit path's assertion now applies to all four.

**`GIT_ALTERNATE_OBJECT_DIRECTORIES` is split on the platform path separator**, which is `;` on
Windows and a legal NTFS filename character. Quoting the value does not help: git then refuses
with `unable to normalize alternate object path`. The alternates *file*
(`<objects>/info/alternates`, one path per line) has no separator and works, including for a
workspace under a directory named `a;b`.

**`commit-tree` stamps a committer as well as an author**, from `committer.name`/`committer.email`
in the same untrusted configuration, and `git var GIT_AUTHOR_IDENT` does not report it.
