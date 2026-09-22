# AI Workbench Program Decisions — 2026-09-21

**Status:** Coordination record. Research snapshots are immutable evidence; supersede them with new dated artifacts rather than silently rewriting historical research.

## Canonical research set

The following reports are archived beside this file and should be treated as the 2026-09-21 research baseline:

| Artifact | Source SHA-256 | Source lines | Role |
|---|---|---:|---|
| `COMMON_AI_WORKBENCH_CONTRACTS_AND_BENCHMARKS_2026-09-21.md` | `98ab6a6444073ccbe4e1bc85f5b2dbab8c4cb371161dbce8d482893e40388e54` | 1632 | Shared semantic contract, lifecycle, authority references, audit/error model, cross-platform benchmark contract |
| `P1_CHATGPT_WAG_DIRECT_ACCESS_RESEARCH_2026-09-21.md` | `287939db84823420a78ff63f66d38c55a8dc93474748367beed43350f633ec22` | 1156 | ChatGPT → Secure MCP Tunnel → WAG direct-access research |
| `P2_WINDOWS_NATIVE_AI_WORKBENCH_RESEARCH_2026-09-21.md` | `ea487a32f1aa219f7662554e962ba5361d9e6ac0863ec372c3b269c0d11b7a57` | 1353 | Windows-native workbench architecture/benchmark research |
| `P3_AI_NATIVE_LINUX_WORKSTATION_RESEARCH_2026-09-21.md` | `fa5e6a95c950b71fa7e39da6fd9ca2cefd098df5216937114de7d22447e7d6e6` | 1235 | Linux workstation prototype/migration research |

The hashes above are for the original uploaded source files before GitHub archival. They provide provenance for later reconciliation.

## Program ordering

1. **P0 — close Autonomous Goal Lease + policy alignment first.**
   - P0 remains the immediate prerequisite for consequential follow-on authority work.
   - Final acceptance requires bounded Goal Lease autonomous execution, manual no-lease behavior preserved, no unresolved security blocker, and all required gates green.
   - After P0 is merged, create a separate dated Goal Lease reconciliation artifact recording the exact merged commit, canonical schema/files, acceptance receipt, and which P1/COMMON assumptions are superseded.

2. **P1 — highest implementation priority after P0.**
   - Preferred topology: ChatGPT Business custom MCP app → OpenAI Secure MCP Tunnel → one local tunnel-client → WAG `serve-stdio` → existing bounded local resources.
   - Do not add a P1 runtime proxy unless a live metadata/admission spike proves it necessary.
   - First prove one-session read/verify, then OpenAI-session correlation, then five-session isolation/restart/performance.
   - Only after those gates pass should WAG separately design/authorize Business mutation projection and bounded Git semantics.
   - Do not replace the short path with a browser bridge, public relay, raw shell, or generic Git proxy.

3. **P2 — bounded Windows A/B benchmark track.**
   - Candidate A: .NET 10 + WPF + WebView2 + ConPTY + Job Objects + structured IPC + WAG client.
   - Candidate B: the same control plane with externally managed Edge/CDP replacing WebView2.
   - Keep the core identical and vary the browser surface so the benchmark answers the actual embedded-vs-external-browser question.
   - Do not productize UI/updater/terminal-renderer architecture before the A/B evidence exists.

4. **P3 — bounded Linux prototype, not migration.**
   - Leading prototype: Ubuntu 26.04 LTS + systemd transient service/slice per session + cgroup v2 + native hardening/namespaces + dedicated authenticated browser profiles + Playwright-native control + WAG unchanged.
   - P3 must use the shared benchmark and beat a competent Windows baseline on measurable operational value before migration is considered.
   - P3 must not delay P1/Windows delivery.

5. **COMMON — freeze semantic/benchmark contract before implementation proliferation.**
   - Shared semantics: explicit logical IDs, lifecycle, request/result binding, opaque Goal Lease references, trusted authority-decision refs, event/audit envelope, error taxonomy, recovery semantics, process ownership semantics, and benchmark contract.
   - Transport profiles: NDJSON JSON-RPC over stdio for spawned adapters; same framing over Windows named pipe or pathname Unix-domain socket for resident local control planes.
   - Transport/process/connection identity is never authority.
   - Model/browser content cannot self-assert `HUMAN_APPROVED` or `POLICY_APPROVED`.
   - Crash recovery uses `INTERRUPTED` + new `attempt_id`, not blind replay.

6. **P4 — do not create yet.**
   - A portable authority core is justified only after independent P2/P3 implementation demonstrates recurring duplication of authority-critical logic that causes defects, semantic/security divergence, or material maintenance cost.
   - An attractive abstraction alone is not a trigger.

## Reconciliation note: Goal Lease

P1 and COMMON were researched against the remote WAG snapshot `main@bd2727a1c3792f60b72f6c470b3034481b294e72` and therefore classify the exact canonical Goal Lease contract as unresolved/opaque.

That is a **snapshot mismatch**, not an architecture disagreement, while P0 develops newer local Goal Lease implementation/policy evidence.

After P0 merge:
- Git/spec/tests/acceptance evidence from the merged WAG commit becomes authoritative;
- P1/P2/P3/COMMON consume the canonical Goal Lease interface rather than inventing another lease model;
- preserve these reports as historical research snapshots and add a dated reconciliation record instead of rewriting them.

## Durable invariants

- Model/browser/page content is not local authority.
- WAG remains the authority/effect boundary.
- Structured semantic tools outrank UI automation.
- Security controls are not auto-clicked to increase autonomy.
- Provider/transport/session metadata is correlation unless WAG explicitly turns it into a locally owned identity.
- Process ownership uses native containment primitives (Windows Job Objects / Linux cgroup v2), not PID-name scanning.
- Raw credentials do not enter model-visible arguments, audit payloads, or fingerprints.
- No candidate is called lightweight without measured CPU/RAM/process/startup/recovery evidence.
- Repository/spec/tests/live evidence outrank chat summaries and handoffs.

## Next coordination action

Finish and merge P0 first. Then create the Goal Lease reconciliation artifact and start P1 single-session Secure MCP Tunnel → WAG read/verify acceptance. P2 may proceed as a bounded benchmark track when it does not interfere with P0/P1. P3 remains a bounded prototype track. COMMON is the cross-project contract authority until superseded by a dated evidence-backed revision.
