/**
 * Browser-backed regression for the operator's CSRF Origin check.
 *
 * The unit suite drives the review server with `fetch()`, which is request mode "cors" and is
 * therefore exempt from the Fetch rule that serialises a navigation's Origin as "null" under a
 * `no-referrer` referrer policy. That exemption is why the suite stayed green while a real
 * operator's Approve click was refused: a form submission is a navigation, not a fetch. So this
 * proves the one thing `npm test` structurally cannot — that a *real browser*, submitting the
 * *real review form*, sends an Origin the server accepts.
 *
 * It drives the Approve control, which `.claude/rules/human-presence-boundary.md` otherwise
 * forbids automating. That is safe here only because of how it is isolated, and the isolation is
 * structural rather than a promise:
 *
 *   - the coordinator is a stub defined in this file; approving it increments a counter and
 *     touches nothing else. There is no durable store, no workspace and no backend;
 *   - the server is started here on an ephemeral port with its own freshly minted bootstrap, so
 *     it shares no session, cookie or token with the live runtime;
 *   - it refuses to run if a live browser-operator runtime is present, so it can never be aimed
 *     at a real review queue by editing a URL.
 *
 * The bootstrap URL *is* passed as an argument to the CLI, and therefore lands on a child process
 * command line — readable by any same-user process — and in the worker's history. That is stated
 * plainly because an earlier version of this file claimed otherwise. It is acceptable only
 * because this token belongs to a stub server on an ephemeral port and is spent immediately; it
 * would not be acceptable for the live runtime's credential, which this script never reads.
 *
 * It needs an owned `playwright-cli` worker (E:\AI-BROWSER\PLAYWRIGHT_HANDOFF.md) and so is run
 * explicitly, never as part of `npm test`:
 *
 *   npm run test:operator-browser          # WAG_BROWSER_SESSION, default wag-op-3
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { operatorDenialsToStderr, startOperatorServer, type OperatorDenialCode } from '../src/operator-server.js';

const run = promisify(execFile);
const session = process.env.WAG_BROWSER_SESSION ?? 'wag-op-3';

/**
 * The CLI's own entry script, run through this Node rather than the `playwright-cli` shim.
 *
 * On Windows the shim is a `.cmd`, which current Node refuses to spawn without `shell: true`.
 * Avoiding the shell avoids quoting and metacharacter handling. It does **not** hide arguments,
 * which land on the child's command line either way — see the note on the bootstrap URL above.
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

/**
 * Refuse to run beside a live browser-operator runtime.
 *
 * The discovery file exists only while that runtime is up. Stopping here keeps a test that drives
 * an Approve control from ever running in a session where a real review queue is reachable.
 */
async function refuseIfLiveRuntime(): Promise<void> {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return;
  const discovery = join(localAppData, 'WebAgentGateway', 'browser-adapter-v4.json');
  const present = await readFile(discovery, 'utf8').then(() => true, () => false);
  if (present) {
    throw new Error(
      'a live browser operator runtime is running (its discovery file is present). '
      + 'This probe drives an Approve control and must not run while a real review queue exists. '
      + 'Stop the runtime and retry.',
    );
  }
}

/** The mandatory pre-flight from the browser policy: never allocate or touch an unproven worker. */
async function provenOwnedWorker(): Promise<void> {
  const listing = await cli('list', '--all', '--json');
  let inventory: { browsers?: Array<{ name?: string; userDataDir?: string; status?: string }> };
  try { inventory = JSON.parse(listing); }
  catch { throw new Error('playwright inventory did not parse; stopping fail-closed'); }

  const worker = inventory.browsers?.find((b) => b.name === session);
  if (!worker) throw new Error(`no open worker named ${session}; this probe does not allocate one`);
  if (!worker.userDataDir) throw new Error(`worker ${session} reports no profile directory`);

  const owner = await readFile(join(worker.userDataDir, 'OWNER.json'), 'utf8').catch(() => '');
  if (!owner) throw new Error(`worker ${session} has no OWNER.json; ownership is unproven`);
  const claimed = JSON.parse(owner) as { session?: string };
  if (claimed.session !== session) {
    throw new Error(`OWNER.json in ${worker.userDataDir} claims ${claimed.session}, not ${session}`);
  }
}

const check = (ok: boolean, label: string): boolean => {
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${label}\n`);
  return ok;
};

async function main(): Promise<number> {
  await refuseIfLiveRuntime();
  await provenOwnedWorker();

  const denials: Array<{ status: number; code: OperatorDenialCode; path: string }> = [];
  const coordinator = stubCoordinator();
  const server = await startOperatorServer({
    coordinator,
    onDeny: (event) => { denials.push(event); operatorDenialsToStderr()(event); },
  });

  let failures = 0;
  let tabIndex: string | undefined;
  const fail = (ok: boolean, label: string) => { if (!check(ok, label)) failures += 1; };

  try {
    const bootstrapUrl = server.bootstrapUrl;
    const token = new URL(bootstrapUrl).searchParams.get('token') ?? '';
    if (!token) throw new Error('no bootstrap token minted');

    // The browser spends the bootstrap, exactly as an operator's browser does. Its own tab, so a
    // conversation open in this worker is left exactly as it was.
    const before = (await cli('tab-list')).split('\n').filter((l) => /^- \d+:/.test(l.trim())).length;
    await cli('tab-new', bootstrapUrl);
    tabIndex = String(before);

    // Read the session back out of the browser, so the direct probes below can carry it. Without
    // a cookie they would be turned away by the session gate and never reach the Origin or CSRF
    // check at all — an earlier version asserted exactly that and proved nothing.
    const cookieOut = await cli('cookie-get', 'wag_operator_session');
    const cookieValue = /wag_operator_session=([^\s;]+)/.exec(cookieOut)?.[1]
      ?? /value:\s*([^\s]+)/i.exec(cookieOut)?.[1];
    if (!cookieValue) throw new Error(`could not read the session cookie back:\n${cookieOut.slice(0, 500)}`);

    const listed = await cli('snapshot');
    fail(listed.includes('mut_browser_origin_probe'), 'the review list renders, so the cookie was accepted');

    // Click the real Approve button: a form submission, which is the request mode — navigation,
    // not fetch — that the unit suite cannot produce and that this whole change is about.
    const ref = /button "Approve"[\s\S]{0,60}?\[ref=([a-z0-9]+)\]/.exec(listed)?.[1]
      ?? /\[ref=([a-z0-9]+)\][^\n]*Approve/.exec(listed)?.[1];
    if (!ref) throw new Error(`no Approve button in the rendered list:\n${listed.slice(0, 2000)}`);
    await cli('click', ref);

    fail(coordinator.approvals() === 1,
      'a real browser form POST reached the coordinator: its Origin and CSRF were both accepted');
    fail(denials.length === 0,
      `no refusal was recorded for the browser submission (saw: ${denials.map((d) => d.code).join(',') || 'none'})`);

    // The same session, deliberately misdirected: this reaches the Origin check rather than being
    // turned away for having no cookie, which is what makes the assertion mean anything.
    const authedCrossOrigin = await fetch(`${server.origin}/mutations/mut_browser_origin_probe/approve`, {
      method: 'POST',
      headers: {
        cookie: `wag_operator_session=${cookieValue}`,
        origin: 'http://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf: 'irrelevant' }),
      redirect: 'manual',
    });
    fail(authedCrossOrigin.status === 403, `an authenticated cross-origin POST is refused 403 (${authedCrossOrigin.status})`);
    fail(denials.some((d) => d.code === 'ORIGIN_MISMATCH'),
      'and it was refused by the Origin check specifically, not by the session gate');

    // And a same-origin POST with the wrong token must still fail, so the CSRF check is proved
    // present rather than merely not-complained-about.
    const badCsrf = await fetch(`${server.origin}/mutations/mut_browser_origin_probe/approve`, {
      method: 'POST',
      headers: {
        cookie: `wag_operator_session=${cookieValue}`,
        origin: server.origin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf: 'wrong' }),
      redirect: 'manual',
    });
    fail(badCsrf.status === 403 && denials.some((d) => d.code === 'CSRF_INVALID'),
      'a same-origin POST with a wrong CSRF token is refused by the CSRF check');

    fail(coordinator.approvals() === 1, 'exactly one approval occurred, and neither attempt added another');
    fail(!denials.some((d) => JSON.stringify(d).includes(token) || JSON.stringify(d).includes(cookieValue)),
      'no denial event carries the bootstrap token or the session id');

    process.stdout.write(`\nlocal denial codes observed: ${denials.map((d) => `${d.status}:${d.code}`).join(', ') || '(none)'}\n`);
  } finally {
    const probeOrigin = server.origin;
    await server.close();
    // Close the tab this probe opened, and *verify* it: swallowing the failure left a dead tab
    // behind in the worker, which is residue this script is responsible for.
    if (tabIndex !== undefined) {
      try {
        await cli('tab-close', tabIndex);
      } catch (error) {
        process.stderr.write(`could not close probe tab ${tabIndex}: ${String((error as Error)?.message ?? error)}\n`);
      }
      const remaining = await cli('tab-list').catch(() => '');
      if (remaining.includes(probeOrigin)) {
        failures += 1;
        check(false, `the probe tab at ${probeOrigin} is still open; close it before reusing this worker`);
      }
    }
  }

  process.stdout.write(failures === 0 ? '\nOPERATOR BROWSER ORIGIN: PASS\n' : `\nOPERATOR BROWSER ORIGIN: ${failures} FAILED\n`);
  return failures === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (error) => {
  process.stderr.write(`operator browser origin probe failed: ${String(error?.message ?? error)}\n`);
  process.exit(1);
});
