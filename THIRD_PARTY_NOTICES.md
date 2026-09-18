# Third-Party Notices

Web Agent Gateway is licensed under Apache-2.0. The Windows native-host executable also incorporates third-party software.

## Node.js runtime

The native host is built as a Node.js Single Executable Application using Node.js 24.20.0.

The complete license and third-party notices for the exact Node.js runtime are tracked at:

`third_party/native-host/NODE-v24.20.0-LICENSE`

That file is copied from the Node.js v24.20.0 upstream release license.

## JavaScript bundled into the native host

The exact currently bundled npm packages are:

- `@modelcontextprotocol/client@2.0.0` — MIT
- `@modelcontextprotocol/core@2.0.0` — MIT
- `eventsource@3.0.7` — MIT
- `eventsource-parser@3.1.1` — MIT
- `jose@6.2.12` — MIT
- `pkce-challenge@5.0.1` — MIT
- `zod@4.5.4` — MIT

Exact upstream license files for these packages are tracked under:

`third_party/native-host/npm/`

The native-host license compliance gate derives the actual bundle inputs from esbuild metadata and fails if this list, the installed package metadata, or tracked license bytes drift.

Build-time tools that are not incorporated into the native-host executable are not listed as runtime components here.
