# Live 42-tool native image read

Date: 2026-09-25
Status: PASS

## Runtime

```text
source commit:
aa12f6e228ad2f46b5587ea4dab4247ca695f385
feat: add native image read parity

runtime:
E:/WAG-Runtime/aa12f6e228ad

activation:
E:/WAG-Acceptance/promotion-logs/activate-aa12f6e228ad.json

state:
SUCCEEDED

previous runtime:
E:/WAG-Runtime/365100ef92c0/dist/cli.js
```

DevSpace was not restarted.

## Production surface

Fresh direct-MCP readiness projects 42 tools. The increment over the accepted 41-tool diagnostics
runtime is:

```text
machine.image.read
```

The local-machine image reader accepts one caller-owned workspace path and:

- applies the existing path/symlink confinement;
- requires a regular file;
- caps raw bytes at 4 MiB;
- validates content signature rather than trusting the extension;
- supports PNG, JPEG, WEBP and GIF;
- returns SHA-256 and bounded metadata;
- returns image bytes as a native MCP `image` content item;
- omits base64 from `structuredContent`.

The existing frozen `file.read` compatibility path also falls back to native image read for a
local-machine workspace. Therefore a ChatGPT conversation still holding the older connector catalog
does not need a manual connector refresh merely to inspect a supported local image.

## Verification before promotion

```text
local image/DC + machine MCP batch = 9/9 PASS
direct/frozen/MCP surface batch    = 27/27 PASS
surface profile                    = 24/24 PASS
bootstrap profile                  = 14/14 PASS
typecheck                          = PASS
build                              = PASS
diffcheck                          = PASS

projected full surface             = 42 tools
DIRECT_MCP_LOCAL_READINESS         = READY
```

The focused tests also prove:

- signature rejection for a fake image with an image-looking filename;
- native MCP image content on `machine.image.read`;
- frozen `file.read` image fallback without a DevSpace call;
- no base64 image payload in structured metadata.

## Live deployed acceptance

The live proof used only WAG after activation.

Opened local-machine root:

```text
C:/Users/PACMAP/AppData/Local/WAG-Local
```

WAG created a temporary 1x1 PNG through the existing frozen `command.run` bridge, then invoked the
existing frozen `file.read` name on that binary file.

Observed:

```text
path       = image-read-live.png
mime_type  = image/png
size_bytes = 68
sha256     = 749de74b69c1255b49e30dc2033b90521227e9f5575842cbec4b0b0d865ac83a

content[0].type     = image
content[0].mimeType = image/png

structuredContent contains base64 = false
```

The returned MCP result contained the PNG bytes in its native image content item plus a text metadata
item. The temporary image was deleted successfully after the proof.

## Automation consequence

Native local image inspection is no longer a DC-parity backlog item and does not depend on
provider-side tool-catalog refresh.

The next useful media parity work should focus on formats where native structured support materially
reduces shell/tool fallback: document/PDF extraction first, then audio/media metadata or preview if
a real workflow needs it. Persistent diagnostics and further frozen-catalog reduction remain useful
independent follow-ups.
