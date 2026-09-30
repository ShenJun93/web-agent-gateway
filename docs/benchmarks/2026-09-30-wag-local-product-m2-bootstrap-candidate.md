# WAG Local M2 — Installer / Onboarding Bootstrap Candidate

Date: 2026-09-30
Branch: `feat/wag-local-m2-installer-onboarding-v1`
Base: `122564a051077ce317932a3d90e037aaa7135802` (M1 full reboot acceptance closed)

## Verdict

`M2_BOOTSTRAP_CANDIDATE = PASS`

`M2_ISOLATED_PACKAGED_INSTALL_MUTATION = PASS`

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
- machine-readable `WAG_LOCAL_SETUP_V1` receipt shape.

## Verification

Source candidate:

- `npm run test:wag-product` = **15/15 PASS**
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

## Scope / limitations

Not measured yet:

1. a truly clean Windows user profile with no previous WAG state;
2. first-time tunnel/control-plane provisioning for a user who has no existing client profile;
3. actual install mutation on a separate disposable/clean Windows environment;
4. first useful local list/read workflow from that fresh install;
5. reboot + repeat workflow from that fresh install.

The current machine already has a production WAG Local installation and live ChatGPT connector.
Therefore the real packaged mutation used a fixture-only per-user install root and fixture WSL profile,
not the live WAG root. This proves installer mutation behavior and live-state non-interference, but is
not a substitute for a separate clean-Windows external-user acceptance run.

## Product gap discovered

The installer can consume/migrate an existing valid tunnel-client profile and credential into the
per-user WAG store, but a completely new user still needs a supported first-time control-plane
provisioning path. Until that path is implemented or explicitly delegated to a supported official
flow, M2 must not be marked fully accepted.

## Next M2 task

The bounded fixture install lane is now complete. The next unresolved product requirement is the
first-time control-plane/client provisioning path for a user with no existing WAG/tunnel profile.
That path may create account/cloud state or require a browser authorization flow, so it is the next
roadmap STOP-point review before implementation. A later external acceptance run still needs a
separate clean/disposable Windows environment; do not enable Windows Sandbox, create system users,
or make other machine-wide changes implicitly.
