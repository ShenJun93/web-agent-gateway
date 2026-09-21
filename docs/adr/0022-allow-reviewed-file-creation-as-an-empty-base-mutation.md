# ADR-0022: Allow Reviewed File Creation as an Empty-Base Mutation

Date: 2026-09-19
Status: Accepted
Depends on: ADR-0008, ADR-0009, ADR-0011, ADR-0014, ADR-0015, ADR-0018, ADR-0020
Design: `docs/superpowers/specs/2026-09-19-wag-dc-replacement-v1-design.md`
Acceptance plan: `docs/superpowers/plans/2026-09-19-wag-dc-replacement-v1-acceptance.md`

## Context

WAG can now navigate, search, read, inspect, verify and make reviewed edits to existing files on the
private stdio surface. It cannot create a file. That is the one gap that still forces an operator
doing ordinary repository work to reach for another tool, and it is the gap that keeps the DC
replacement claim from covering normal use rather than only the measured benchmark scenarios.

The accepted durable mutation contract (ADR-0008, ADR-0009, ADR-0011, locked by ADR-0014) is defined
over an existing file: a `before` fragment that must occur exactly once in the current content, a
`base_sha256` of that content, and an `after` fragment that replaces it. Nothing in that contract
describes a file that does not exist yet.

Two ways to extend it were considered.

**A new `operation` column** on the `mutations` table. Rejected: `SqliteDurableStore` creates its
schema with `CREATE TABLE IF NOT EXISTS` and has no migration framework or schema version. Adding a
column means writing one, and an unmigrated database would silently diverge — a poor trade for one
capability.

**An empty-base encoding**, adopted here.

## Decision

A creation is a mutation whose base is the empty file:

```text
base_sha256 = sha256("")
before      = ""
after       = the complete new file content, non-empty
```

This needs no new column and no migration. Both fields already exist and are `TEXT NOT NULL`, and
the encoding is unambiguous against every existing record, because the current contract requires
`before` to be non-empty — so no historical row can be mistaken for a creation.

It also needs no new candidate-computation path. The coordinator computes
`original.replace(before, after)`, and for a creation `original` is `""` and `before` is `""`, so
that expression already yields exactly `after`. The state machine, the fingerprint, the review TTL,
the admission TTL, the atomic approval, the claim, and every restart transition are reused unchanged.

### What the encoding must enforce

- `before === ""` is accepted **only** when `base_sha256 === sha256("")`. Everywhere else the
  existing "before must be non-empty" rule stands.
- `after` must be non-empty for a creation. The backend cannot create an empty file, and a creation
  that writes nothing is not a reviewed change.
- The occurrence check — `before` must appear exactly once — is skipped for a creation, because it
  is meaningless against empty content and because counting empty-string occurrences does not
  terminate.
- The target must genuinely not exist at preview **and** must still not exist at execution. A
  creation whose target appeared in between is not silently converted into an overwrite; it fails.
- The write must be proven to have created rather than replaced. The backend reports the operation
  it performed, and anything other than a create is rejected.
- Every existing path-policy denial applies unchanged, so a creation cannot target `.git`, `.env`,
  `.ssh`, a traversal, an absolute path or a Windows-reserved name.

### Surface

One tool is added to the mutation half of the opt-in repository-engineering profile:

```text
file.create   propose creating one new file; writes nothing until locally approved
```

It shares `mutation.result`, the operator review page, the single-use approval, and the TTLs. It is
not a second approval path and not a second authority.

## Why this is not authority widening

The caller could already cause a write to an existing file after local approval. It can now cause a
write to a new path after the same local approval, reviewed the same way, bounded by the same path
policy and the same size ceilings. The operator sees the target path and the full proposed content
before approving.

What remains unavailable is unchanged: deletion, move, directory creation or removal, overwriting an
existing file through the creation path, Git writes, and arbitrary argv or shell execution.

## Consequences

Accepted:

- an operator can create a reviewed new file through WAG, closing the last everyday gap that forced
  another tool;
- the durable mutation state machine, its storage schema and its restart semantics are reused
  without relaxation;
- existing databases keep working with no migration.

Not accepted by this ADR:

- file deletion, move or rename;
- directory creation or removal;
- creation that overwrites an existing path;
- empty-file creation;
- any browser surface change;
- Git mutation.

## Backend coupling worth stating

Detecting "this path does not exist" is not free. The execution backend's read tool surfaces a
missing file as an error string rather than a typed condition, so the backend adapter recognises
that condition and reports absence, and a test pins that behaviour against the pinned backend
revision. If the upstream wording changes, that test fails loudly rather than a creation silently
becoming an overwrite — which is the failure this ADR most wants to avoid.

The create path additionally asserts the backend reported an `add`, so even if absence were
misdetected the write is rejected rather than replacing content.

## Security invariants

```text
CREATION_ENCODING = EMPTY_BASE_SHA256_AND_EMPTY_BEFORE
NEW_SCHEMA_COLUMN = NONE
HISTORICAL_RECORD_REINTERPRETATION = IMPOSSIBLE
CREATION_WITHOUT_LOCAL_APPROVAL = FORBIDDEN
CREATION_OVER_EXISTING_PATH = FORBIDDEN
EMPTY_FILE_CREATION = FORBIDDEN
PATH_POLICY = UNCHANGED_AND_ENFORCED
APPROVAL_SINGLE_USE_AND_TTL_BOUNDED = UNCHANGED
DELETE_MOVE_DIRECTORY_GIT_WRITE = STILL_FORBIDDEN
```

## Decision markers

```text
ADR_0022 = ACCEPTED
ADDED_TOOL = file.create
GATED_BY = repositoryEngineering.mutation
STORE_MIGRATION_REQUIRED = NO
STATE_MACHINE_CHANGE = NONE
```
