# Web Agent Gateway Design

Status: APPROVED for V0 benchmark spike.

## Problem
Remote Desktop Commander is useful for ChatGPT Web Plus but recent remote/session latency makes many small coding tool calls expensive and hard to diagnose.

## Objective
Create a provider-neutral gateway that exposes a small MCP tool surface to Web AI clients while delegating local execution to proven upstream components.

## Architecture
Web AI -> public MCP endpoint -> thin policy/telemetry gateway -> localhost DevSpace -> local repo/process/Git.

## Owned responsibilities
- provider capability mapping
- strict policy/risk classification
- one-time local approvals
- semantic tool aggregation
- audit and latency telemetry
- compatibility tests

## Reused responsibilities
- DevSpace: files, search, patch, PTY/process sessions, Git/worktrees, optional agent adapters.
- LocalAnt: donor patterns for risk, approvals, redaction, audit, path/command guards.
- Official MCP SDK: protocol.
- Cloudflare Tunnel: V0 public transport.

## V0 exclusions
No browser scraping, custom hosted relay, multi-device routing, ACP/A2A orchestration, skill marketplace, or production plugin submission.

## Success gate
Proceed beyond spike only with materially better end-to-end latency/reliability than Remote Desktop Commander, zero silent drops in acceptance runs, durable local jobs across transport loss, and passing strict path/destructive-action tests.
