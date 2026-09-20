# Operator review server — referrer policy, denial diagnostics, and the browser probe

Date: 2026-09-20
Status: DECIDED — narrow production repair, locally authorised
Candidate: `3106b7b`
Base: `1d543ab`
Authority: operator decision of 2026-09-20 (recorded below), ADR-0019, ADR-0023, ADR-0026
Evidence: `docs/benchmarks/2026-09-20-claude-autonomous-wag-harness-v1-source-acceptance.md`

AGENTS.md requires that a trust-boundary decision be recorded with dated evidence before it is
promoted. The change was made first and this record follows the same day; the review that caught
the omission is cited below.

## What was decided, and by whom

The operator authorised a narrow repair of the local operator review server after a live dogfood
showed an operator could not approve anything through it. The instruction was explicit about the
limits:

> Preserve the production authority model. Do NOT remove or weaken Origin validation, CSRF
> validation, SameSite=Strict, HttpOnly, CSP form-action self, frame-ancestors none, or the human
> approval gate. Replace the operator HTML response Referrer-Policy `no-referrer` with
> `same-origin`, unless live browser evidence proves an even narrower policy that preserves a
> non-null same-origin Origin header. Treat Sec-Fetch-Site as optional defense-in-depth only, not
> a replacement for Origin + CSRF.

No narrower policy was found that preserves a usable Origin, so `same-origin` was adopted as
instructed.

## The evidence the decision rests on

Two independent things, both dated 2026-09-20:

1. **The specification.** Fetch's "append a request Origin header" algorithm sets the serialised
   origin to `null` when the request's mode is not `cors`, its method is not GET or HEAD, and its
   referrer policy is `no-referrer`. A form submission is a navigation, so it is caught; `fetch()`
   is mode `cors`, so it is exempt — which is why the whole existing test suite passed while the
   product did not.
2. **A controlled measurement in the acceptance browser.** An isolated server on its own port
   served two pages identical in every respect except that one header, each posting a dummy token:

   ```text
   control  (no referrer-policy)             Origin: http://127.0.0.1:51370   referer present
   strict   (referrer-policy: no-referrer)   Origin: null                     referer absent
   ```

## What the change costs, stated exactly

`same-origin` sends a `Referer` where `no-referrer` sent none: on the same-origin decision POST,
carrying the review page URL, which on a detail page contains a record id. It goes only to the
loopback review server, which logs no requests, inside the same trust boundary. Cross-origin, the
referrer is still withheld entirely — which is what the original header was buying. No subresource
can leak it (`default-src 'none'`) and the page contains no anchors. The bootstrap token cannot
ride along: it lives in a query string on a 303, and a redirect does not become the referrer of
the request it redirects to.

## What was not weakened

Origin is still compared exactly. CSRF is still compared in constant time. `SameSite=Strict`,
`HttpOnly`, `form-action 'self'`, `frame-ancestors 'none'` and the human approval gate are
unchanged. `Sec-Fetch-Site` is corroboration only: a browser that omits it is not penalised, and a
request that claims `same-origin` while carrying the wrong Origin is still refused. The check can
only ever *add* a refusal.

Two follow-on notes recorded rather than glossed:

- `SameSite=Strict` does not isolate loopback *ports* — site is scheme plus host, so any other
  loopback page is same-site. Consequence for this change: such a page can now cause the overdue
  sweep's durable writes by provoking a render. Bounded, because the sweep's compare-and-swap only
  moves records whose deadline has already passed, and the decision routes are still held by the
  exact Origin comparison.
- A `Sec-Fetch-Site` refusal reports `SITE_MISMATCH` rather than borrowing `ORIGIN_MISMATCH`, so
  the diagnostic can distinguish them.

## The browser probe is an accepted, bounded exception

`scripts/verify-operator-browser-origin.ts` drives the Approve control, which
`.claude/rules/human-presence-boundary.md` otherwise forbids automating, and ADR-0026's
`RUN_AND_APPROVAL = HUMAN` carries no stub carve-out. It exists because no test that uses
`fetch()` can produce a navigation, so without it the repair would be unverifiable in the request
mode that broke.

It is bounded structurally, not by promise:

- the coordinator is a stub defined in the file; approving it increments a counter and touches
  nothing else — no durable store, no workspace, no backend;
- the server is started by the script on an ephemeral port with its own bootstrap, sharing no
  session, cookie or token with the live runtime;
- it **refuses to run while a live browser-operator runtime is present**, so it cannot be aimed at
  a real review queue by editing a URL — verified: it refused on the first attempt and had to be
  run with the runtime stopped;
- it proves worker ownership from `OWNER.json` and the mandatory inventory probe before touching a
  browser, and it verifies it closed its own tab.

What it does **not** bound: the script is a file, and a file can be edited. This is the same
same-user shell exposure ADR-0019 already places outside the containment claim. The honest
statement is that this converts a known theoretical hatch into a maintained one, in exchange for
the only evidence that the repair works in the real path.

## Evidence at `3106b7b`

```text
npm run test:operator-browser
  ok  the review list renders, so the cookie was accepted
  ok  a real browser form POST reached the coordinator: its Origin and CSRF were both accepted
  ok  no refusal was recorded for the browser submission
  ok  an authenticated cross-origin POST is refused 403
  ok  and it was refused by the Origin check specifically, not by the session gate
  ok  a same-origin POST with a wrong CSRF token is refused by the CSRF check
  ok  exactly one approval occurred, and neither attempt added another
  ok  no denial event carries the bootstrap token or the session id
  ok  the probe closed its own tab and left the worker as it found it
```

The cross-origin and CSRF probes carry the session deliberately. An earlier version did not, so
they were turned away by the session gate and would have passed with the Origin check deleted
outright — the second review caught that, and it is the kind of assertion this work has had to
learn to distrust twice.

## What this does not authorise

Push, PR, merge, remote mutation, release, tag, signing, provider actions, machine-wide change, or
any widening of browser authority. No ADR, adapter identity, protocol version or capability
profile was touched; `browser.chatgpt.native.verify.v3` and `browser.chatgpt.native.operator.v4`
are unchanged.
