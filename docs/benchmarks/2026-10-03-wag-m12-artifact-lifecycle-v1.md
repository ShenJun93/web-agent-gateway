# WAG M12 — Artifact Lifecycle / Workspace Export v1

Date: 2026-10-03
Branch: feat/wag-m12-artifact-lifecycle-v1
Base public main: e36ad00c36567b61db6882ec749a7e3eaf6832d5

## Objective

Close the usability gap created by M11 semantic downloads: browser.download returns a caller-owned artifact handle, but the model previously had no bounded way to inspect that artifact or place its verified bytes into an already caller-owned workspace.

## Public tools

- artifact.list
- artifact.describe
- artifact.export

With the current live M11 surface at 82 tools, M12 is expected to publish 85 tools when browser integration is enabled.

## Authority model

Artifacts remain owned by the existing caller authority tuple.

artifact.list:
- bounded limit 1..100, default 50;
- returns metadata only;
- never exposes owner tuple, bytes, or WAG internal paths.

artifact.describe:
- owner-checks the artifact;
- re-reads payload bytes and verifies size + SHA-256 against the manifest;
- returns metadata only.

artifact.export:
- accepts artifact_id, an already opened local-machine workspace_id, and one relative destination path;
- re-verifies artifact bytes before export;
- reuses LocalMachineContext workspace identity, containment, symlink, and kill-switch guards;
- is create-only: it never overwrites different existing bytes;
- exact same-path/same-byte replay returns ALREADY_PRESENT;
- a differing existing target fails closed;
- verifies written bytes after creation;
- returns only the workspace id, relative path, state, size, and SHA-256.

## Storage continuity

M12 injects one shared ArtifactPort into browser.download and artifact lifecycle tools.

The root is unchanged from M11:

mutation state path + ".harness-effects.sqlite.browser-artifacts"

Therefore promotion does not move or orphan M11 artifacts.

## Bounded binary export

LocalMachineContext adds an internal createBinaryFile primitive:
- maximum 32 MiB, matching the default ArtifactPort ceiling;
- caller cannot provide an expected digest different from the artifact bytes;
- destination must pass existing workspace-relative path policy;
- target creation uses exclusive create;
- same-byte replay is observation-only and idempotent;
- conflicting file, symlink, or non-file target fails closed.

This primitive is not separately published as an MCP tool.

## Product health

When browser integration is enabled, product.doctor now requires:
- artifact.list
- artifact.describe
- artifact.export

Browser-disabled profiles do not require the artifact lifecycle surface.

## Non-goals

- no artifact.remove in M12;
- no arbitrary WAG internal filesystem path exposure;
- no overwrite/replace export;
- no MIME guessing;
- no expansion of browser extension permissions;
- no change to browser.download non-idempotency semantics.

## Acceptance

Current revalidation on the final worktree:
- focused artifact/browser/local-machine/product-doctor/wiring regression: 45/45 PASS;
- browser projection + direct-MCP readiness regression: 12/12 PASS;
- WAG product suite: 65/65 PASS;
- live-config projected inventory: 85 tools, including 3 artifact lifecycle tools and the configured remote-Git surface;
- TypeScript typecheck: PASS;
- Build: PASS;
- git diff --check: PASS.

A projection drift found during final review was fixed before commit: the read-only direct-MCP inventory helper previously omitted configured remote-Git tools even though the runtime published them. The helper now projects `git.remote.inspect`, `git.push`, and `git.push.result` whenever remote Git push is configured.

No public push, merge, or live promotion is claimed yet.
