# WAG Local M2 — First-Time Provisioning Wizard

Date: 2026-09-30
Branch: `feat/wag-local-m2-installer-onboarding-v1`
Installer fixture baseline: `40aa02fd37184eb77d8e821f9d4d095c1da90d5e`
Wizard implementation base: `0a101c087267c9ff404e6d55324009220f7e5022`

## Status

`M2_LOCAL_INSTALLER_PATH = PASS`

`M2_FIRST_TIME_PROVISIONING_WIZARD = PASS`

`M2_REAL_CLOUD_PROVISIONING = NOT_EXECUTED`

`M2_EXISTING_CHATGPT_CONNECTOR_WORKFLOW = PASS`

`M2_EXTERNAL_CLEAN_WINDOWS_ACCEPTANCE = NOT_MEASURED`

The user approved implementation of the first-time provisioning wizard. This batch implemented and
fixture-tested the local wizard behavior. It did **not** create or alter a real OpenAI tunnel, API key,
organization/workspace attachment, or ChatGPT connector.

## Product boundary

The normal WAG Local runtime must not retain OpenAI admin authority.

The implemented split is:

1. **Existing-profile path**
   - detect an existing tunnel-client profile first;
   - preserve the already-connected migration path;
   - run the ordinary local installer without requiring tunnel CRUD authority.

2. **Existing-tunnel first-time path**
   - accept a tunnel id, not an admin key;
   - accept only the runtime-key reference `env:CONTROL_PLANE_API_KEY`;
   - obtain the runtime secret through a secure local channel:
     - interactive `Read-Host -AsSecureString`, or
     - automation-only environment variable `WAG_SETUP_RUNTIME_API_KEY`;
   - protect the runtime secret with Windows DPAPI in the per-user WAG secret store;
   - create the local tunnel-client profile with `sample_mcp_stdio_local`;
   - never pass the raw runtime secret as a command-line argument.

3. **New-tunnel path**
   - remains an external account/control-plane operation;
   - the wizard emits `ACTION_REQUIRED_TUNNEL` and directs the user to create/select a tunnel;
   - no `OPENAI_ADMIN_KEY` input or persistence exists in the WAG wizard;
   - if admin authority is used outside WAG to create a tunnel, it remains provisioning-only.

4. **ChatGPT connector step**
   - after the local profile/runtime is provisioned, the wizard emits
     `ACTION_REQUIRED_CHATGPT_CONNECTOR`;
   - `--connector-confirmed` records a local user-confirmation marker;
   - that marker is an acknowledgment, not an independent proof that the remote ChatGPT connector
     successfully called WAG.

## Public setup surface

The one-command target remains:

```text
npx web-agent-gateway setup
```

Bounded first-time options are:

```text
--tunnel-id <tunnel_...>
--runtime-key-ref env:CONTROL_PLANE_API_KEY
--connector-confirmed
```

Raw runtime/admin credentials are not accepted as CLI arguments.

The wizard emits stable statuses:

- `ACTION_REQUIRED_TUNNEL`
- `ACTION_REQUIRED_RUNTIME_KEY`
- `ACTION_REQUIRED_CHATGPT_CONNECTOR`
- `ACTION_REQUIRED_PREREQUISITES`
- `READY`

and writes `WAG_LOCAL_PROVISION_V1` receipts for mutating runs.

## Implementation notes

The public CLI now dispatches `setup` through `scripts/wag-local-provision.ps1`. The existing
`scripts/wag-local-setup.ps1` remains the lower-level local installer.

The tunnel-client validates that a stdio command already exists when creating a profile. For a fresh
install the wizard therefore materializes a fail-closed placeholder WSL wrapper first. If profile
creation succeeds, the lower-level installer replaces that placeholder with the real WAG stdio
wrapper before the runtime may start. If profile creation fails, the placeholder is removed.

A PowerShell argument-forwarding defect was also found during fixture testing: array splatting into
the lower-level setup script could bind switch-like values positionally. The wizard now invokes the
lower-level installer with named hashtable splatting.

## Fixture acceptance

Fixture:

`scripts/wag-local-m2-provision-fixture.ps1`

Receipt:

`docs/benchmarks/2026-09-30-wag-local-product-m2-first-time-provision-fixture.json`

Result:

`M2_FIRST_TIME_PROVISION_FIXTURE = PASS`

The packaged first-time fixture used an isolated `LOCALAPPDATA`, an isolated WSL profile path, a
synthetic tunnel id, and a non-real runtime value. No remote tunnel or connector was created.

Measured flow:

1. first packaged run provisions the isolated local profile/runtime;
2. exit code = 2;
3. status = `ACTION_REQUIRED_CHATGPT_CONNECTOR`;
4. second packaged run uses `--connector-confirmed`;
5. exit code = 0;
6. status = `READY`.

The receipt also proves:

- the isolated tunnel-client profile was created;
- the runtime value was stored through the protected local secret path;
- the connector confirmation marker was written;
- the packaged runtime was installed;
- the fixture runtime value was not printed;
- the live WAG Startup shortcut and launcher files were unchanged;
- the live WAG stack was Ready before and after the fixture.

The original packaged-install fixture was rerun after the wizard integration and remained PASS.

## Source verification

At the wizard acceptance checkpoint:

- `npm run test:wag-product` = **16/16 PASS**
- `npx tsx --test test/cli.test.ts` = **8/8 PASS**
- `npm run typecheck` = **PASS**
- `npm run build` = **PASS**
- `git diff --check` = **PASS**

## Remaining M2 boundary

Full M2 remains **NOT ACCEPTED**.

Measured after wizard acceptance:

- the existing live ChatGPT connector completed a real WAG call from ChatGPT;
- WAG health returned `ok` with 53 MCP tools;
- a local Documents test directory was listed and its file read successfully;
- receipt: `docs/benchmarks/2026-09-30-wag-local-product-m2-live-connector-acceptance.json`.

Still not measured:

1. real first-time account/control-plane provisioning using a legitimate tunnel and runtime key;
2. creation/verification of a new connector as part of first-time onboarding;
3. a first useful list/read workflow from a truly fresh external Windows user;
4. reboot/login on that fresh environment;
5. repeat of the useful workflow after reboot without repository knowledge or manual tunnel/DevSpace
   intervention.

The next execution STOP point is therefore the first operation that would mutate real account/cloud
state or a separate clean-Windows external acceptance environment.
