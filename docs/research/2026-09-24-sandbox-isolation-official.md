# Sandbox isolation / network / credential architecture recheck — 2026-09-24

Status: CURRENT OFFICIAL-SOURCE INPUT / SOURCE-ONLY

## Isolation boundary

Current Docker Sandboxes security documentation describes the microVM as the primary trust boundary:
the agent may have broad privileges inside the VM while the hypervisor boundary prevents access to
unshared host resources. Workspace sharing, network access and credentials cross the boundary only
through explicit mechanisms.

Official sources:
- https://docs.docker.com/ai/sandboxes/security/
- https://docs.docker.com/ai/sandboxes/security/isolation/
- https://docs.docker.com/ai/sandboxes/architecture/

WAG disposition:
- "sandbox" is not synonymous with "subprocess";
- a backend must attest an explicit isolation level: host-bounded, container, or microvm;
- a WAG profile requiring microvm cannot run on a container/host-bounded backend;
- workspace scope and private process namespace are separately attestable requirements.

## Network policy

Docker documents all outbound TCP from its sandbox through host-side policy enforcement, with
deny-by-default/allow rules depending on policy. Current kit policy separates network allow/deny
from credential injection.

Official sources:
- https://docs.docker.com/ai/sandboxes/security/defaults/
- https://docs.docker.com/ai/sandboxes/customize/kit-reference/

WAG disposition:
- SandboxPort v1 accepts only deny-by-default TCP policy;
- outbound UDP is disabled in the v1 contract;
- allowed hosts are exact host[:port] values; no wildcard host patterns in v1;
- network enforcement is a backend capability that must be attested before admission.

## Host-side credentials

Docker documents credentials as host-side proxy-managed values: the real secret remains outside the
sandbox, while a placeholder/sentinel may be visible inside. The proxy injects credentials only for
matching requests.

Official source:
- https://docs.docker.com/ai/sandboxes/configuration/credentials/

WAG disposition:
- SandboxProfile carries credential IDs only, never raw values;
- any profile naming credentials requires backend hostCredentialInjection=true;
- the independent WAG CredentialBroker remains the authority for exact origin/method/path binding;
- SandboxPort does not reimplement secret storage.
