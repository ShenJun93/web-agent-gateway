# Credential Broker / sandbox credential isolation recheck — 2026-09-24

Status: CURRENT OFFICIAL-SOURCE INPUT / SOURCE-ONLY

## Host-side credential injection

Current Docker Sandboxes documentation describes a host-side HTTP/HTTPS proxy that intercepts
outbound requests, matches a configured service, and injects the real credential into the configured
header. The agent/sandbox sees a placeholder/sentinel instead of the raw secret. The documented
security model keeps credential values outside the VM.

Official sources:
- https://docs.docker.com/ai/sandboxes/configuration/credentials/
- https://docs.docker.com/ai/sandboxes/security/
- https://docs.docker.com/ai/sandboxes/security/defaults/
- https://docs.docker.com/ai/sandboxes/architecture/

WAG disposition:
- CredentialBroker is host-side and provider-neutral;
- agent-facing describe/request APIs never return credential material;
- a secret is acquired only after caller + origin + method + path + header policy passes;
- the request transport receives the injected header internally;
- redirects are manual and never auto-forward a credential to another origin;
- a future sandbox/egress proxy may implement the same contract without changing agent-facing tools.

## Network default-deny

Docker documents that outbound TCP from sandboxes passes through host-side network policy, with
destinations denied unless policy allows them under the configured posture. Credential injection and
network authorization remain distinct decisions.

Official sources:
- https://docs.docker.com/ai/sandboxes/security/isolation/
- https://docs.docker.com/ai/sandboxes/customize/kit-reference/

WAG disposition:
- one credential binding names exact HTTPS origins;
- origin authorization does not imply arbitrary network access;
- v1 uses exact origins rather than wildcard domains;
- method and path-prefix policy further narrow each binding.

## Secret sources

Docker documents host-side stored and dynamic sources, including command-backed credentials,
1Password references and AWS Secrets Manager references; the real value is resolved outside the
sandbox.

Official source:
- https://docs.docker.com/ai/sandboxes/workflows/authentication/

WAG disposition:
- CredentialSecretSource is injected behind the broker;
- this slice does not select or expose a concrete keychain/secret-manager backend;
- CredentialSecretLease has an explicit release hook so a concrete source can own cleanup/refresh
  semantics.

## Windows secret hygiene

Microsoft security guidance warns against hardcoding passwords/API keys/secrets and recommends
clearing sensitive buffers when finished where native memory control is available.

Official source:
- https://learn.microsoft.com/en-us/windows/win32/secbp/handling-passwords

WAG disposition:
- no credential is stored in source or WAG receipt data by this slice;
- JavaScript string handling cannot provide a hostile-same-process secure-memory claim;
- a later native/OS-keychain source can strengthen in-memory handling without widening the
  agent-facing broker contract.
