# Security Policy

## Supported code

Security fixes target the current `main` branch and the latest supported release once public releases exist. Historical CI artifacts and superseded development snapshots are not supported releases.

## Reporting a vulnerability

Do not publish credentials, private repository contents, exploit details, or sensitive local-machine information in a public issue.

Use GitHub's private vulnerability-reporting flow when the repository offers a **Report a vulnerability** action. If that action is unavailable, open a minimal public issue stating that you need a private security contact; do not include sensitive technical details in that issue.

Include, when safely possible:

- affected WAG commit or release;
- affected platform and browser/provider path;
- the smallest reproduction;
- expected and observed authority boundary;
- whether local files, credentials, approvals, durable ownership, or native-host trust can be crossed.

## Security model

WAG treats provider/model output, repository content, page content, URLs, and ordinary tool arguments as untrusted. Local authority, approvals, durable ownership, secrets, and capability admission remain WAG-controlled.

A report that demonstrates a bypass of an explicit WAG capability or ownership boundary is security-relevant even if the same operation could be performed manually by the local user.

## Disclosure

Please allow maintainers reasonable time to investigate and prepare a fix before public disclosure. WAG does not promise a fixed embargo period.
