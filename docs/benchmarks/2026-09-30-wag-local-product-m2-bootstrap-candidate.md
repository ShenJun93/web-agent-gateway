# WAG Local M2 — Installer / Onboarding Bootstrap Candidate

Date: 2026-09-30
Branch: `feat/wag-local-m2-installer-onboarding-v1`
Base: `122564a051077ce317932a3d90e037aaa7135802` (M1 full reboot acceptance closed)

## Verdict

`M2_BOOTSTRAP_CANDIDATE = PASS`

`M2_ISOLATED_PACKAGED_INSTALL_MUTATION = PASS`

`M2_FIRST_TIME_PROVISIONING_WIZARD = PASS`

`M2_REAL_CLOUD_PROVISIONING = NOT_EXECUTED`

`M2_EXISTING_CHATGPT_CONNECTOR_WORKFLOW = PASS`

`M2_EXTERNAL_CLEAN_WINDOWS_ACCEPTANCE = NOT_MEASURED`

This batch proves that the package/bootstrap shape is buildable and consumable from an unpacked npm
tarball without repository knowledge. It does **not** yet claim that a new external Windows user can
complete the full install + client connection + reboot flow on a clean machine.

## Candidate UX

The package exposes:

```text
web-agent-gateway setup --check-only
web-agent-gateway setup
```

and the npm script:

```text
npm run wag:setup
```

The intended public bootstrap remains:

```text
npx web-agent-gateway setup
```

once distribution/publication is explicitly approved.

## Implemented in this candidate

- npm `bin` entry for `web-agent-gateway`;
- packaged file allow-list instead of shipping the whole repository;
- production runtime package lock copied as `packaging/runtime-package-lock.json`;
- compiled product-health implementation in `dist/product-health.js`;
- PowerShell product-health wrapper uses `node.exe`, not `tsx` / `npx`;
- `setup --check-only` performs read-only prerequisite/client preflight;
- per-user install root under `%LOCALAPPDATA%\WAG-Local`;
- per-user runtime staging;
- per-user DPAPI-protected local secret store;
- default bounded allowed root `Documents\WAG-Workspace`;
- default local configuration does not enable remote Git push;
- canonical launcher install/start integration;
- login autostart integration;
- generic per-user `tunnel-client-path.txt` pin;
- migration away from a developer-specific hard-coded tunnel-client path;
- concise first-run fields: Version / Device / Status / Client / Doctor;
- machine-readable `WAG_LOCAL_SETUP_V1` receipt shape;
- first-time provisioning wrapper with bounded `ACTION_REQUIRED_*` states;
- existing-tunnel provisioning without persistent admin credentials;
- DPAPI-protected runtime-key storage without raw secret CLI arguments;
- local ChatGPT-connector confirmation checkpoint.

## Verification

Source candidate:

- `npm run test:wag-product` = **16/16 PASS**
- `npx tsx --test test/cli.test.ts` = **8/8 PASS**
- `npm run typecheck` = **PASS**
- `npm run build` = **PASS**
- `git diff --check` = **PASS**

Packaged consumer smoke:

1. `npm pack` from the M2 lane;
2. install the resulting tarball into a new empty consumer directory with
   `npm install --ignore-scripts --no-save <tarball>`;
3. invoke only the packaged CLI:
   `node node_modules/web-agent-gateway/dist/cli.js setup --check-only`.

Observed result:

```text
WAG Local
Version: 0.1.0
Status: READY_TO_INSTALL
Client: connected
Doctor: PASS
Receipt: not written (check-only)
```

Machine-readable result had:

- all prerequisite checks true;
- tunnel client resolved and executable;
- no required action codes;
- exit code 0.

The packed artifact contained the compiled runtime, setup/health/launcher scripts, DevSpace pin,
runtime package lock, LICENSE and notices.

### Isolated packaged install mutation

A bounded fixture lane then performed a real packaged `setup` mutation without touching the live WAG
installation. It used a fixture `LOCALAPPDATA`, a fixture WSL tunnel profile, `--no-start`, and
`--no-autostart`. Receipt:

`docs/benchmarks/2026-09-30-wag-local-product-m2-fixture-install.json`

Result: **PASS**. The receipt proves:

- packaged setup exited 0;
- setup receipt reported `INSTALLED`, client `connected`, doctor `DEFERRED`, autostart `false`;
- packaged runtime CLI was installed under the fixture root;
- gateway and DevSpace configs were created under the fixture root;
- canonical starter/supervisor/tunnel-client pin were installed under the fixture root;
- the fixture WSL wrapper was executable and pointed at the fixture packaged runtime;
- the live WAG Startup shortcut and installed launchers were byte-for-byte unchanged;
- the live tunnel-client profile hash was unchanged;
- the live 7677/8080 stack was Ready before and after the fixture install.

The fixture also found and closed a packaging defect: an npm package installed inside a Git working
tree could incorrectly inherit the ancestor repository HEAD and label itself as a development runtime.
Setup now accepts a source HEAD only when `git rev-parse --show-toplevel` exactly matches the package
root; consumer packages therefore use the stable package-version runtime tag.

The fixture profile override is environment-only (`WAG_SETUP_PROFILE_FILE`), validated as an absolute
WSL path without traversal, and is not exposed as a public CLI credential argument.

### First-time provisioning wizard fixture

The packaged first-time wizard was also exercised with an isolated user root, isolated WSL profile,
synthetic tunnel id, and non-real runtime value. Receipt:

`docs/benchmarks/2026-09-30-wag-local-product-m2-first-time-provision-fixture.json`

Result: **PASS**. The first run reached `ACTION_REQUIRED_CHATGPT_CONNECTOR`; the second run with the
local connector-confirmation checkpoint reached `READY`. The runtime value was protected through the
local DPAPI path and did not appear in fixture output. Live WAG launcher hashes and live readiness were
unchanged before/after the fixture. No real tunnel, API key, organization/workspace attachment, or
ChatGPT connector was created.

## Scope / limitations

Not measured yet:

1. a truly clean Windows user profile with no previous WAG state;
2. real tunnel/runtime-key provisioning against legitimate account/control-plane resources;
3. actual ChatGPT connector creation/verification and a successful connector call;
4. actual install mutation on a separate disposable/clean Windows environment;
5. first useful local list/read workflow from that fresh install;
6. reboot + repeat workflow from that fresh install.

The current machine already has a production WAG Local installation and live ChatGPT connector.
Therefore the real packaged mutation used a fixture-only per-user install root and fixture WSL profile,
not the live WAG root. This proves installer mutation behavior and live-state non-interference, but is
not a substitute for a separate clean-Windows external-user acceptance run.

## Remaining product gap

The local first-time provisioning wizard is now implemented and fixture-accepted. It deliberately
stops before creating real account/cloud resources. The already-configured live ChatGPT connector was
also verified end-to-end from this ChatGPT session: WAG health returned ok/53 tools, and a local
Documents test directory was listed and its test file read successfully. Receipt:
`docs/benchmarks/2026-09-30-wag-local-product-m2-live-connector-acceptance.json`.

This proves the existing connector workflow, not first-time connector creation. The remaining gap is
external acceptance using a legitimate first-time tunnel/runtime-key path or supported account flow,
followed by a truly fresh-user install/list/read workflow and reboot repeat.

## Next M2 task

The next execution boundary is real account/cloud or clean-environment mutation. Do not create a real
tunnel, API key, organization/workspace attachment, ChatGPT connector, Windows Sandbox environment,
or system user implicitly. Full M2 acceptance requires an explicitly approved external run.
