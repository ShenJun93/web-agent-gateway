# WAG Live Browser Dogfood — post STOP 10

Date: 2026-10-01

Source commit:

```text
d9f7c27ce85b462a0280aab88f8faa81943c7505
```

Live runtime:

```text
E:\WAG-Runtime\d9f7c27ce85b
PID 28148
health = ok
authority = AUTONOMOUS_LOCAL
published MCP tools = 71
```

## Result

```text
LIVE_BROWSER_DOGFOOD = PASS
BROWSER_TARGETS = PASS
DIRECT_AI_TAB_GROUP_ATTACH = PASS
AUTO_EXACT_TARGET_TO_AI_TAB_GROUP = PASS
SEMANTIC_SNAPSHOT = PASS
RELEASE = PASS
USER_TABS_PRESERVED = PASS
EDGE_RESTART = NO
PUBLIC_PUSH = NO
LIVE_PROMOTION = NO
NPM_PUBLISH = NO
```

## Live observations

- `browser.targets` exposed the user's existing Edge targets without foreground focus changes.
- The active WAG chat target was discovered as `tab_836682541`, title `WAG dogfood update`.
- Direct `AI_TAB_GROUP` attach succeeded against the existing user tab with `ATTACHED_EXISTING` ownership.
- Semantic accessibility snapshot succeeded on the attached ChatGPT page.
- Releasing the attached session detached WAG control while preserving the user's WAG tabs and Edge process.
- `AUTO` without `target_id` resolved to `WAG_HEADLESS`, matching the accepted STOP 9/10 contract.
- `AUTO` with the exact target selected from `browser.targets` resolved to `AI_TAB_GROUP` and preserved the existing browser session.
- The no-target AUTO headless process created during validation was closed after the test.

## Contract clarified by live dogfood

```text
AUTO + no target_id    -> WAG_HEADLESS
AUTO + exact target_id -> AI_TAB_GROUP
```

Foreground activity is discovery evidence for the caller; AUTO does not implicitly infer a foreground target. The caller selects an exact target from `browser.targets` and passes that `target_id`.

## Acceptance evidence location

Local sanitized acceptance checkpoint:

```text
E:\WAG-Acceptance\promotion-logs\live-dogfood-d9f7c27c-pending-catalog-refresh.json
```

Final checkpoint state:

```text
LIVE_BROWSER_DOGFOOD_PASS
```

## Publication boundary

This live dogfood result adds production-local evidence only. It does not authorize or perform:

- public Git push;
- merge to public `main`;
- npm publication;
- additional live-runtime promotion.

Those remain separate explicit publication/promotion actions.
