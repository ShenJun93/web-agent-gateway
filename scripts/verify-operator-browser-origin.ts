/**
 * Browser-backed regression for the operator's CSRF Origin check.
 *
 * The unit suite drives the review server with `fetch()`, which is request mode "cors" and is
 * therefore exempt from the Fetch rule that serialises a navigation's Origin as "null" under a
 * `no-referrer` referrer policy. That exemption is exactly why the suite stayed green while a
 * real operator's Approve click was refused: a form submission is a navigation, not a fetch.
 *
 * So this proves the thing the unit suite structurally cannot — that a *real browser*, submitting
 * the *real review form*, sends an Origin the server accepts.
 *
 * It is deliberately isolated from WAG's durable state: the coordinator here is a stub, and no
 * mutation, workspace or session of the live runtime is touched. It needs an owned
 * `playwright-cli` session (see E:\AI-BROWSER\PLAYWRIGHT_HANDOFF.md) and is therefore run
 * explicitly, not as part of `npm test`.
 *
 *   npm run test:operator-browser            # uses WAG_BROWSER_SESSION, default wag-op-3
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startOperatorServer } from '../src/operator-server.js';

const run = promisify(execFile);
const session = process.env.WAG_BROWSER_SESSION ?? 'wag-op-3';

/**
 * The CLI's own entry script, run through this Node.
 *
 * Not the `playwright-cli` shim: on Windows that is a `.cmd`, which current Node refuses to spawn
 * without `shell: true` — and a shell here would put a single-use bootstrap token through a
 * command line. `WAG_PLAYWRIGHT_CLI` overrides the path for a non-default install.
 */
const cliEntry = process.env.WAG_PLAYWRIGHT_CLI
  ?? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@playwright', 'cli', 'playwright-cli.js');

const cli = async (...args: string[]): Promise<string> => {
  const { stdout } = await run(process.execPath, [cliEntry, `-s=${session}`, ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  return stdout;
};

function stubCoordinator() {
  const review = {
    mutationId: 'mut_browser_origin_probe', state: 'PENDING_APPROVAL' as const,
    path: 'probe.txt', before: 'before', after: 'after',
    workspaceRoot: 'C:\\probe', baseSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64),
    fingerprint: 'c'.repeat(64), additions: 1, removals: 1, reviewDeadline: Date.now() + 10 * 60_000,
  };
  let approvals = 0;
  return {
    listPendingLocal: () => (approvals === 0 ? [review] : []),
    reviewLocal: (id: string) => (id === review.mutationId ? review : undefined),
    approveLocal: async (id: string) => { if (id !== review.mutationId) return false; approvals += 1; return true; },
    rejectLocal: () => false,
    approvals: () => approvals,
  };
}

const check = (ok: boolean, label: string): boolean => {
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${label}\n`);
  return ok;
};

async function main(): Promise<number> {
  const denials: string[] = [];
  const coordinator = stubCoordinator();
  const server = await startOperatorServer({
    coordinator,
    onDeny: (event) => denials.push(`${event.status}:${event.code}`),
  });

  let failures = 0;
  let openedTab = false;
  const fail = (ok: boolean, label: string) => { if (!check(ok, label)) failures += 1; };

  try {
    const token = new URL(server.bootstrapUrl).searchParams.get('token') ?? '';
    if (!token) throw new Error('no bootstrap token minted');

    // Bootstrap in the browser: consumes the single-use token, sets the session cookie, redirects
    // to the review list. Everything after this is the operator's ordinary path.
    //
    // In its own tab, so a conversation open in this worker is left exactly as it was.
    await cli('tab-new', server.bootstrapUrl);
    openedTab = true;
    const listed = await cli('snapshot');
    fail(listed.includes('mut_browser_origin_probe'), 'the review list renders the pending record');
    fail(!listed.includes(token), 'the bootstrap token does not appear in the rendered page');

    // Click the real Approve button. This is a form submission — a navigation — which is the
    // request mode the unit tests cannot produce.
    const ref = /button "Approve"[\s\S]{0,60}?\[ref=([a-z0-9]+)\]/.exec(listed)?.[1]
      ?? /\[ref=([a-z0-9]+)\][^\n]*Approve/.exec(listed)?.[1];
    if (!ref) throw new Error(`no Approve button in the rendered list:\n${listed.slice(0, 2000)}`);
    await cli('click', ref);

    fail(coordinator.approvals() === 1,
      'a real browser form POST reached the coordinator, so its Origin and CSRF were accepted');
    fail(!denials.some((d) => d.includes('ORIGIN_MISMATCH')),
      'no Origin mismatch was recorded for the browser submission');
    fail(!denials.some((d) => d.includes('CSRF_INVALID')),
      'the CSRF field was parsed and validated, not merely present');

    // And the checks must still refuse everything else.
    const cross = await fetch(`${server.origin}/mutations/mut_browser_origin_probe/approve`, {
      method: 'POST',
      headers: { origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'whatever' }),
      redirect: 'manual',
    });
    fail(cross.status === 401 || cross.status === 403, `a cross-origin POST is refused (${cross.status})`);

    const afterPage = await cli('snapshot');
    fail(!afterPage.includes(token), 'the token does not appear after the decision either');
    fail(coordinator.approvals() === 1, 'exactly one approval occurred, not a replay');

    process.stdout.write(`\nlocal denial codes observed: ${denials.join(', ') || '(none)'}\n`);
  } finally {
    await server.close();
    if (openedTab) await cli('tab-close').catch(() => undefined);
  }

  process.stdout.write(failures === 0 ? '\nOPERATOR BROWSER ORIGIN: PASS\n' : `\nOPERATOR BROWSER ORIGIN: ${failures} FAILED\n`);
  return failures === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (error) => {
  process.stderr.write(`operator browser origin probe failed: ${String(error?.message ?? error)}\n`);
  process.exit(1);
});
