# WAG M15 — Clean-Install Acceptance Kit v1

Date: 2026-10-03  
Branch: `feat/wag-m15-clean-install-acceptance-v1`

## Objective

Turn the remaining fresh-user installation gap into a bounded, receipt-driven acceptance workflow that can be executed on a legitimate separate clean Windows user/machine without conflating local fixtures with real external acceptance.

M15 does **not** create external accounts, tunnels, ChatGPT connectors, or provider approvals on behalf of a user. Those remain explicit external actions.

## Product surface

New packaged CLI workflow:

```text
web-agent-gateway clean-install-acceptance --stage baseline
web-agent-gateway clean-install-acceptance --stage install ...
web-agent-gateway clean-install-acceptance --stage connector-proof ...
web-agent-gateway clean-install-acceptance --stage post-reboot ...
web-agent-gateway clean-install-acceptance --stage post-reboot-proof ...
```

The CLI accepts only bounded non-secret parameters. A runtime credential may be referenced only as:

```text
--runtime-key-ref env:CONTROL_PLANE_API_KEY
```

Raw runtime/API secrets are not accepted as CLI values.

## Acceptance state machine

### 1. Baseline

A run is eligible for external clean-install acceptance only when the runner proves:

- no existing `%LOCALAPPDATA%\WAG-Local`;
- no WAG login-startup shortcut;
- no existing WAG tunnel profile;
- WAG DevSpace/tunnel ports are unused;
- the run belongs to the same Windows machine/user profile for all later stages.

Machine name and user-profile path are stored only as SHA-256 correlations.

An existing acceptance-state file is preserved and blocks a new baseline rather than being overwritten.

### 2. Install

The runner delegates to the existing bounded `wag-local-provision.ps1` path.

Expected first-user stop when local provisioning succeeds but ChatGPT has not yet been connected:

```text
ACTION_REQUIRED_CHATGPT_CONNECTOR
```

The runner then writes a random challenge inside the configured WAG workspace.

### 3. Connector proof

The challenge requires ChatGPT, through WAG, to:

1. read `.wag-acceptance/initial-challenge.txt`;
2. extract the random nonce;
3. create `.wag-acceptance/initial-response.txt` containing the exact response value.

The acceptance state stores the expected response SHA-256. Connector confirmation is accepted only after the response file verifies.

This is evidence of a WAG workspace round trip rather than a user checkbox.

### 4. Post-reboot

The runner requires:

- a different Windows boot identity from the install stage;
- packaged WAG product health = `READY`.

Only after both conditions pass is a second connector challenge issued.

### 5. Post-reboot proof

A second WAG workspace round trip must verify after reboot.

Only a non-fixture run may reach final external `PASS`.

## Fixture boundary

The repository fixture sets:

```text
WAG_CLEAN_ACCEPTANCE_FIXTURE=1
```

Fixture mode:

- uses isolated fake `LOCALAPPDATA`;
- does not start/autostart the fake install;
- cannot set `eligibleForExternalAcceptance=true`;
- may only report `FIXTURE_PASS_NOT_EXTERNAL_ACCEPTANCE` for the final simulated-proof path.

Therefore fixture evidence cannot be used to claim a real clean-user acceptance.

## Fixture acceptance

Receipt:

`docs/benchmarks/2026-10-03-wag-m15-clean-install-fixture.json`

Observed:

- baseline: PASS;
- install: exit 2 / `ACTION_REQUIRED_CHATGPT_CONNECTOR`;
- connector proof: PASS;
- immediate post-reboot stage without a real reboot: exit 2 / FAIL;
- no post-reboot challenge issued without a real reboot;
- fixture external eligibility: false;
- connector response verified;
- connector confirmation marker written;
- runtime secret stored through the existing protected path;
- runtime secret absent from M15 acceptance state;
- live WAG startup/launcher/supervisor/tunnel hashes unchanged;
- live WAG stack healthy before and after fixture.

Fixture result: **PASS**.

## Packaging acceptance

`npm pack --dry-run --json` confirms the package includes:

`scripts/wag-local-clean-install-acceptance.ps1`

The setup installer and autonomous-runtime promotion support-file list also include this runner.

## Local gates

- PowerShell parse for production runner + fixture: PASS.
- M15 static + CLI tests: 18/18 PASS.
- Full product suite: 72/72 PASS.
- TypeScript typecheck: PASS.
- Build: PASS.
- `git diff --check`: PASS.
- Fixture end-to-end: PASS.
- Live M14 WAG health after fixture: OK, 88 tools, extension release match true.

## External status

**External clean Windows/user acceptance: NOT MEASURED.**

A real final PASS still requires a legitimate separate clean Windows user/machine, real tunnel/runtime credential path, actual ChatGPT connector round trip, real reboot, and second connector round trip.

M15 closes the automation/evidence gap around that test; it does not fabricate the external prerequisites.
