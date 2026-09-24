# Live 38-tool safe-append parity

Date: 2026-09-25
Status: PASS

## Runtime

```text
source commit:
3687bf3b5c18fc178080bc3bc1fba6041d77f017
feat: add suffix-guarded safe append

runtime:
E:/WAG-Runtime/3687bf3b5c18

activation receipt:
E:/WAG-Acceptance/promotion-logs/activate-3687bf3b5c18.json

activation state:
SUCCEEDED

previous runtime:
E:/WAG-Runtime/805165068f9f/dist/cli.js
```

No DevSpace restart was required.

## Production surface

The production private-stdio assembly now exposes 38 tools.

New tool:

```text
file.append
```

The append primitive accepts:

```text
workspace_id
path
expected_suffix
content
```

It does not require the caller to send the complete original file. WAG reads the target internally,
requires `expected_suffix` to be the exact current tail and to occur exactly once, derives the
base SHA-256 internally, then persists only the suffix and suffix+appended-content in the durable
mutation record. A concurrent file change still fails the normal exact-base mutation checks.

## Pre-promotion verification

```text
focused append/surface batch = 33/33 PASS
surface                     = 24/24 PASS
bootstrap                   = 14/14 PASS
typecheck                   = PASS
build                       = PASS
diffcheck                   = PASS
projected tool count        = 38
DIRECT_MCP_LOCAL_READINESS  = READY
```

## Live acceptance

The deployed runtime was loaded from `E:/WAG-Runtime/3687bf3b5c18` and assembled through the real
private-runtime + repository-engineering + MCP server path.

Fixture content deliberately contained a credential-shaped value:

```text
API_KEY=fixture-secret-value
marker=end
```

The live call was equivalent to:

```text
file.append(
  expected_suffix = "marker=end\n",
  content         = "next=value\n"
)
```

Observed result:

```text
toolCount           = 38
fileAppend          = live
mutationId          = mut_da676085-8b43-44af-84c1-a78d5e756a22
state               = SUCCEEDED
redactionObserved   = true
rawSecretPreserved  = true
staleSuffixRejected = true
finalSha256         = 87975e9e61c76ae9c9163d0143b237212073eb9db4862e36b7620bab7852d18f
```

The raw file retained the original secret-bearing prefix while the model-facing `machine.read`
result did not expose the raw credential value.

A second append using the old suffix was rejected because that suffix was no longer the current
file tail.

## Automation consequence

Explicit safe append is no longer a DC-parity backlog item. The next parity target is
restart-recoverable process/terminal session state, followed by large-tree continuation,
WAG-native tool/usage diagnostics, and richer binary/document/media support where it provides
more value than bounded argv.
