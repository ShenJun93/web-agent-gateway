# Benchmark Evidence

This directory stores empirical evidence only. Do not copy benchmark claims from chat history.

Each run should record:
- timestamp and exact commit
- provider/client
- transport
- executor version
- scenario revision
- per-call latency
- end-to-end latency
- median and p95
- tool-call count
- dropped/failed calls
- reconnects and re-auth events
- security/recovery result

Failed runs stay in the dataset. Do not discard outliers without a documented reason.

The V0 decision receipt must reference the raw evidence files used for GO/NO-GO.
