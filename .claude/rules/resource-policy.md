# Resource and process policy

This Windows machine runs out of CPU and RAM before it runs out of work. Many WAG worktrees,
browser profiles and MCP servers share it, and most `node.exe` processes here belong to someone
else.

## Never broad-kill

```text
taskkill /IM node.exe        # never
taskkill /IM python.exe      # never
Get-Process node | Stop-Process   # never
```

Clean up **only** processes whose command line contains this worktree's path, or which you can
trace to a process you started. Another worktree's orphan is another session's business, and
sharing a runtime executable is not evidence of ownership. The same applies to browser workers —
see `browser-automation.md`.

Before and after a heavy run, inventory what you own:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*claude-autonomous-wag-harness-v1*' } |
  Select-Object ProcessId, ParentProcessId, CommandLine
```

## Order of work

Focused tests, then targeted security and integration tests, then **one** sequential full suite.
Never two full suites at once. `npm test` takes roughly 7–9 minutes serially: start it in the
background writing to a log and poll the log — it is not hung.

Avoid concurrent browser profiles you do not need, duplicate long-lived `tsx` runners, orphan
esbuild services, and unbounded subagent fan-out. Subagents are for independent read-only review;
run a small number and let them finish.

`.claude/skills/wag-acceptance-gates` has the gate commands and the environment traps that
silently invalidate a run.
