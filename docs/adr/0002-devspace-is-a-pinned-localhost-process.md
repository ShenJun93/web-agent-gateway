# ADR-0002: DevSpace Is a Pinned Localhost Process

Date: 2026-09-09
Status: Accepted

## Context
External review raised three possible composition modes: import DevSpace as a library, call it as a separate MCP process, or introduce a custom internal service API.

## Decision
V0 uses DevSpace as a separately supervised localhost-only process behind a narrow owned adapter/MCP boundary.

Do not import DevSpace internals directly into the gateway in V0.
Do not invent an additional gRPC/custom service protocol in V0.
Pin the exact DevSpace version or commit used by each benchmark receipt.

## Rationale
- preserves upstream upgrade boundary;
- contains fast-moving DevSpace dependencies and SDK churn;
- lets compatibility tests detect tool/schema/behavior drift;
- keeps DevSpace off the public network;
- avoids optimizing a localhost hop before evidence identifies it as material latency.

## Known consequence
DevSpace process sessions are currently in-memory and are terminated by DevSpace shutdown. V0 requires local jobs to survive transport/tunnel loss, not DevSpace executor restart.

If executor-restart durability becomes a demonstrated requirement, evaluate a persistent job runtime as a separate architectural decision rather than silently coupling it into V0.

## Revisit conditions
Revisit library embedding only if measured localhost process/MCP overhead is a meaningful fraction of end-to-end latency and a stable public DevSpace library interface exists.
