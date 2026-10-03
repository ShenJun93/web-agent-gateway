# WAG Private Beta — Operator Runbook

## Objective

Collect real external evidence from **5 completed private-beta installations** of the current full WAG product.

Do not substitute local fixtures, the maintainer's own machine, duplicate installations, or fabricated receipts for external users.

## Distribution policy

- Cost target: $0.
- Unsigned private beta is permitted for this cohort.
- Do not weaken Windows security controls for a tester.
- Do not distribute the maintainer's API key, tunnel id, runtime key, DPAPI state, tunnel profile, or tunnel-client binary.
- Each tester uses their own connector/tunnel context.
- Share the beta ZIP and its exact SHA-256 through a private channel.
- Do not use the historical `v0.1.0-preview.1` native-host asset for this beta; it is an older 5-tool preview.

## Cohort

Invite approximately 7–8 candidates to obtain 5 completed runs.

Use operator labels such as `P01`, `P02`, ... only for coordination. Do not place names, emails, machine fingerprints, or contact details inside WAG beta receipts or aggregate inputs.

A completed installation requires:

1. external clean-install baseline PASS;
2. install stage completed;
3. ChatGPT connector proof PASS;
4. one Windows reboot;
5. post-reboot proof PASS;
6. at least one real useful workflow.

A user who is blocked by security policy, prerequisites, connector enrollment, or install failure is a real beta outcome but is not a completed installation.

## Build the beta bundle

Build only from a clean exact source commit:

```powershell
npm run beta:bundle -- --source-sha <40-hex-main-sha> --output E:\WAG-Beta\web-agent-gateway-private-beta-<12hex>.zip
```

Record the command output:

- source SHA;
- release id;
- outer ZIP SHA-256;
- package SHA-256;
- extension tree SHA-256;
- entry count.

The release id is source-specific:

```text
0.1.0-beta-<first-12-source-sha>
```

Never reuse a beta ZIP under a different SHA or source commit.

## Before sending an invite

Verify:

```powershell
Get-FileHash <beta.zip> -Algorithm SHA256
```

Send the tester:

- the ZIP;
- the exact ZIP SHA-256;
- `docs/private-beta/windows-private-beta.md`;
- a reminder that it is unsigned and must not require disabling machine security.

## Receipt collection

A tester receipt is optional and requires explicit tester consent.

Do not instruct ChatGPT to call `product.beta.receipt` unless the tester has explicitly opted in.

Collect receipt JSON files privately into a local directory. Do not edit them. Do not rename or deduplicate by assumed real-world identity.

Aggregate offline:

```powershell
npm run beta:aggregate -- --input-dir E:\WAG-Beta\receipts --output E:\WAG-Beta\private-beta-summary.json
```

The aggregator deduplicates by WAG's pseudonymous installation id and rejects conflicting/future/invalid receipts.

## Acceptance target

M8 external-beta evidence can advance when there are at least 5 distinct real external completed installations and the evidence is internally consistent.

Do not claim metrics the receipt contract does not measure. In particular, do not turn receipt data into unsupported claims for:

- weekly active users;
- retention;
- recovery rate;
- uninstall reasons;
- support-incident rate.

## Operator ledger

Keep a separate minimal coordination ledger outside receipt JSON:

| Label | Invite state | Install state | Connector proof | Reboot proof | Useful workflow | Receipt consent | Receipt received |
|---|---|---|---|---|---|---|---|
| P01 | | | | | | | |

The coordination ledger may contain the private contact method necessary to communicate with testers, but it must not be merged into WAG telemetry/receipt files or published in the repository.

## Stop conditions

Stop a tester run instead of asking them to bypass controls when:

- SmartScreen/Smart App Control/enterprise policy blocks execution;
- WSL or the tester's connector/tunnel environment is unavailable;
- the ZIP hash does not match;
- installer integrity verification fails;
- the clean-install baseline reports existing WAG state;
- the connector challenge cannot be verified.

Record the blocker and move to another candidate if necessary.
