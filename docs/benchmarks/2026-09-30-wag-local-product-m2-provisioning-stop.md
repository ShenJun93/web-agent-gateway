# WAG Local M2 — First-Time Provisioning STOP Point

Date: 2026-09-30
Branch: `feat/wag-local-m2-installer-onboarding-v1`
Installer fixture baseline: `40aa02fd37184eb77d8e821f9d4d095c1da90d5e`

## Status

`M2_LOCAL_INSTALLER_PATH = PASS`

`M2_FIRST_TIME_CONTROL_PLANE_PROVISIONING = STOP_REVIEW_REQUIRED`

No account/cloud mutation was performed while producing this note.

## Measured tunnel-client surface

The installed tunnel-client reports:

- `tunnel-client init` creates a local profile but needs a tunnel id;
- a runtime daemon needs a runtime control-plane API key;
- `tunnel-client admin tunnels create` creates a remote tunnel and requires:
  - a real admin API key;
  - at least one organization or workspace id;
- `tunnel-client runtimes connect --tunnel-id ...` can attach to an existing tunnel without admin CRUD;
- `runtimes connect` accepts a runtime-key reference and can use managed local supervision;
- ChatGPT connector creation/verification remains a separate client-settings step.

Therefore a genuinely new user with no existing tunnel/profile cannot be brought to Connected by
local filesystem installation alone.

## Product boundary

The normal WAG Local installer should **not** retain an OpenAI admin key for long-lived runtime use.

Recommended split:

1. **Existing-tunnel path — default automation path**
   - user supplies or selects an existing tunnel id;
   - user supplies a runtime-key reference with Tunnels Read + Use;
   - WAG creates its local profile/config, stores only runtime material in the per-user protected store,
     starts the managed runtime, and verifies health;
   - no tunnel CRUD authority is needed by the running WAG service.

2. **New-tunnel path — bounded provisioning step**
   - create/select a tunnel in the supported account/control-plane flow;
   - create/select a runtime key;
   - immediately transition to the same existing-tunnel path above;
   - admin authority, if used for creation, is provisioning-only and must not be copied into the
     WAG long-lived runtime store.

3. **ChatGPT connector step**
   - while WAG/tunnel is running, create or verify the ChatGPT connector;
   - prove one useful list/read workflow;
   - reboot Windows and repeat the workflow for final external M2 acceptance.

## Why execution stops here

The next operation would create or alter remote account/cloud resources (tunnel, key, or connector),
or require a browser authorization/settings flow. That crosses the roadmap STOP boundary for
account/system-wide or external state changes.

## Next implementation after approval

Build the first-time provisioning wizard around the split above:

- detect existing tunnel/profile first;
- prefer existing tunnel + runtime key;
- show a bounded New tunnel path only when needed;
- never accept admin credentials as a persistent daemon credential;
- emit explicit statuses:
  - `ACTION_REQUIRED_TUNNEL`
  - `ACTION_REQUIRED_RUNTIME_KEY`
  - `ACTION_REQUIRED_CHATGPT_CONNECTOR`
  - `READY`;
- preserve the current one-command target:
  `npx web-agent-gateway setup`.

Full M2 remains **NOT ACCEPTED** until a separate clean Windows user completes install -> connect ->
list/read -> reboot -> list/read without repository knowledge or manual DevSpace/tunnel operation.
