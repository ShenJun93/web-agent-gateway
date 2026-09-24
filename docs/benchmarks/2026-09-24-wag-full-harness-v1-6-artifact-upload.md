# WAG Full Harness v1.6 — ArtifactPort + semantic upload bridge

Date: 2026-09-24
Branch: feat/full-harness-browserport-v1
Parent: 18e395df2a9440a8478819136e0524fe7cdb3088
Status: SOURCE-GREEN / NO LIVE BROWSER / NOT MCP-PUBLISHED

## Added

ArtifactPort:
- importFile
- get
- list
- remove

ArtifactPort authority:
- caller supplies a requested source path only to an injected authorizeSource seam;
- the seam must return an approved absolute path before ArtifactPort reads it;
- imported bytes are copied into a WAG-owned artifact root;
- artifact id is opaque and owner/session/adapter scoped;
- META.json stores filename, size, sha256, createdAt and authority but never the original source path;
- every get re-hashes bytes and fails if payload diverged from the manifest;
- a new ArtifactPort instance can recover valid owned artifacts from disk;
- unrelated/corrupt artifact directories are not adopted.

Browser upload:
- caller-facing upload references artifact ids, not local filesystem paths;
- artifact ids are owner-checked and resolved to WAG-internal payload paths;
- semantic setFiles accepts the current semantic ref plus bounded absolute internal paths;
- stale refs, relative paths, NUL paths, oversized paths and >20-file sets fail closed;
- final page operation is CDP DOM.setFileInputFiles with backendDOMNodeId.

## Measured gates

Artifact / upload / semantic focused:
```text
11 pass
0 fail
```

Browser + Process regression:
```text
36 pass
0 fail
```

Artifact + exact-once + autonomous-local/repository regression:
```text
29 pass
0 fail
```

Repository source build:
```text
npm run build
PASS
```

## Boundary

The model-facing design never needs an arbitrary local path for upload. Integration must wire
authorizeSource to an existing workspace/FilePort authority source, not to a public "read any path"
primitive.

Current CDP supports DOM.setFileInputFiles; this source slice uses it only behind a current
semantic ref and ArtifactPort ownership.

## Non-claims

- no browser/profile was opened;
- no file was uploaded to a real website;
- no download bridge exists yet;
- no public MCP artifact/browser tools exist;
- no server.ts/private config/runtime promotion changed;
- no source outside this isolated harness lane was modified.
