# Public Plugin Submission Readiness Plan

Date: 2026-09-10
Status: Planned / implementation not authorized
Decision authority: ADR-0007

## Goal
Define the evidence required before Web Agent Gateway can enter the OpenAI public plugin submission track. This plan does not authorize a universal relay, OAuth implementation, mutation tools, hosting purchases, or submission.

### Task 0: Product/distribution decision
- [ ] Explicitly decide that Plus/broad public distribution is worth a new hosted product surface.
- [ ] Compare that commitment against the supported private-use alternative: ChatGPT Business + Secure MCP Tunnel.
- [ ] Do not proceed to relay engineering merely to bypass a Plus plan limitation.

### Task 1: Publisher and submission eligibility
- [ ] Verify the owning OpenAI Platform organization has a verified developer/business identity.
- [ ] Verify the submitter has Apps Management write / required app submission permissions.
- [ ] Confirm current submission portal availability and requirements at execution time.
- [ ] Record these as external/account evidence without committing credentials or personal identity data.

### Task 2: Universal public transport design
- [ ] Design one stable public HTTPS MCP endpoint for all users/organizations.
- [ ] Keep localhost Gateway and DevSpace private; use an outbound local agent/session to reach the relay.
- [ ] Define authenticated user/device routing, replay resistance, disconnect behavior, and bounded session lifetime.
- [ ] Do not assume Template MCP URLs unless OpenAI explicitly approves that route.

### Task 3: Publication authentication
- [ ] Replace benchmark static-bearer assumptions with an OAuth 2.1 architecture conforming to MCP authorization requirements.
- [ ] Prefer an established identity provider over implementing an authorization server from scratch.
- [ ] Define resource metadata, OAuth discovery, PKCE, scopes, audience/resource validation, token expiry/revocation, and per-tool `securitySchemes`.
- [ ] Provide reviewer credentials that require no MFA, SMS/email confirmation, or private-network access.

### Task 4: Tool metadata and safety review
- [ ] Add accurate `readOnlyHint`, `openWorldHint`, and `destructiveHint` to every public tool.
- [ ] Keep the bounded read/verify surface until distribution feasibility is proven; mutation remains separately gated.
- [ ] Verify response payloads contain no credentials, unnecessary personal data, internal debug payloads, or undisclosed identifiers.
- [ ] Add at least five positive and three negative reviewer test cases with deterministic fixtures and expected results.

### Task 5: Publication assets and domain evidence
- [ ] Deploy the production MCP endpoint on a public domain and support the OpenAI domain-verification challenge.
- [ ] Publish website, privacy policy, terms, and support URLs matching the publisher identity.
- [ ] Prepare listing copy, starter prompts, supported-country choices, release notes, and any required CSP.

### Task 6: Acceptance gate
- [ ] Submit for review only after Tasks 0-5 pass.
- [ ] After approval/publication, prove the exact plugin is discoverable/installable on the target Plus account.
- [ ] Prove action-capable behavior on Plus rather than inferring it from other reviewed plugins.
- [ ] Keep private Business deployment and public Plus distribution as separate gate outcomes.
