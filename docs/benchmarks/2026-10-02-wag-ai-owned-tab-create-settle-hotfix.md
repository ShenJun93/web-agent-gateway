# WAG AI-Owned Tab Create Settle Hotfix

Date: 2026-10-02

## Trigger

After Batch A/B/C reached public main and runtime 30a3ae0427c214d2afdbb449d7f8772fa64d5070 was promoted, live smoke for explicit AI_TAB_GROUP without target_id failed with:

```text
AI-owned browser target creation failed
```

The extension files were synchronized and reloaded. The remaining failure was caused by Edge resolving chrome.tabs.create() before the new tab URL metadata had settled.

## Fix

The extension-created target path now:

1. creates exactly one inactive about:blank tab;
2. keeps the exact created tab id;
3. re-reads only that exact tab for a bounded 5 attempts / 20 ms interval;
4. requires the tab to settle to an already-allowed attachable URL (about:blank);
5. fails closed immediately if it settles to any other non-empty/internal URL.

No attachability rule for user-existing tabs was broadened.

## Regression

The existing control fixture now simulates Edge returning tabs.create() metadata without url while tabs.get() returns the settled about:blank tab.

```text
focused browser bridge/runtime tests: 28/28 PASS
typecheck: PASS
build: PASS
git diff --check: PASS
```

Publication and live promotion are handled through the normal public-main boundary.
