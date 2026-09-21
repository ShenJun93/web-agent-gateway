import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBootstrapRedirect, operatorOrigin, readBootstrapUrl } from '../src/operator-launch.js';

/**
 * The launch helper exists to open the operator page without handing the bootstrap token to
 * whoever asked for it. That is the property under test here: not that it opens a page — that is
 * the browser's job — but that the token does not escape into argv, output, or a second reader.
 */
const TOKEN = 'ThisIsTheSecretBootstrapToken-0123456789';
const BOOTSTRAP = `http://127.0.0.1:52999/bootstrap?token=${TOKEN}`;

/**
 * A browser navigation is made with a raw client here rather than `fetch`.
 *
 * `Sec-Fetch-*` are forbidden header names in the Fetch spec, so a browser page cannot set them.
 * Whether *Node's* `fetch` enforces that list is a separate question, and one the test below
 * settles by asking rather than by asserting a belief — an earlier version of this comment
 * claimed no `fetch()` anywhere could forge the check, which was never verified.
 */
function navigate(url: string): Promise<{ status: number; location: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        location: res.headers.location,
        body,
      }));
    });
    req.on('error', reject);
  });
}

test('the handoff URL carries no part of the token', async (t) => {
  const redirect = await createBootstrapRedirect({ bootstrapUrl: BOOTSTRAP });
  t.after(() => redirect.close());

  assert.match(redirect.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(redirect.url.includes(TOKEN), false);
  assert.equal(redirect.url.includes('bootstrap'), false);
});

test('a browser navigation is redirected to the bootstrap exactly once', async (t) => {
  const redirect = await createBootstrapRedirect({ bootstrapUrl: BOOTSTRAP });
  t.after(() => redirect.close());

  const first = await navigate(redirect.url);
  assert.equal(first.status, 303);
  assert.equal(first.location, BOOTSTRAP);
  assert.equal(await redirect.settled, 'handed-off');

  // Single-use: a reload, a prefetch, or anything racing the browser gets nothing.
  const second = await navigate(redirect.url);
  assert.equal(second.status, 410);
  assert.equal(second.location, undefined);
  assert.equal(second.body.includes(TOKEN), false);
});

test('the redirect is never cached and leaks no referrer', async (t) => {
  const redirect = await createBootstrapRedirect({ bootstrapUrl: BOOTSTRAP });
  t.after(() => redirect.close());

  const res = await new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
    const req = get(redirect.url, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } },
      (r) => { r.resume(); resolve(r.headers); });
    req.on('error', reject);
  });
  assert.equal(res['cache-control'], 'no-store', 'a credential-bearing redirect is never cached');
  assert.equal(res['referrer-policy'], 'no-referrer');
});

test('a non-navigation request does not receive the bootstrap', async (t) => {
  const redirect = await createBootstrapRedirect({ bootstrapUrl: BOOTSTRAP });
  t.after(() => redirect.close());

  // What a plain `curl` or `fetch` sends. This is a speed bump rather than a control — the
  // module says so — but it must at least be wired up, and it must not disarm the handoff.
  const plain = await fetch(redirect.url, { redirect: 'manual' });
  assert.equal(plain.status, 400);
  assert.equal(plain.headers.get('location'), null);
  assert.equal((await plain.text()).includes(TOKEN), false);

  // Still armed for the browser that follows: a refused probe must not burn the handoff.
  const real = await navigate(redirect.url);
  assert.equal(real.status, 303);
  assert.equal(real.location, BOOTSTRAP);
});

test('an expired handoff redirects nothing', async (t) => {
  const redirect = await createBootstrapRedirect({ bootstrapUrl: BOOTSTRAP, ttlMs: 1 });
  t.after(() => redirect.close());

  assert.equal(await redirect.settled, 'timeout');
  const late = await navigate(redirect.url);
  assert.equal(late.status, 410);
  assert.equal(late.location, undefined);
});

test('the redirect refuses a bootstrap that is not loopback', async () => {
  await assert.rejects(
    createBootstrapRedirect({ bootstrapUrl: 'https://example.com/bootstrap?token=x' }),
    /not loopback/,
    'a redirect to a remote origin would publish the token off this machine',
  );
});

test('the redirect refuses to bind anything but loopback', async () => {
  // Binding 0.0.0.0 would serve the token-bearing 303 to every interface for the whole TTL.
  // This was documented as loopback-only and validated nowhere until a review said so.
  //
  // Written to fail rather than hang: if the guard is ever removed, the call resolves and hands
  // back a listening server, and simply awaiting `assert.rejects` would leave that server holding
  // the event loop open — the test runner would stall instead of reporting. Found by mutating it.
  let leaked: Awaited<ReturnType<typeof createBootstrapRedirect>> | undefined;
  try {
    leaked = await createBootstrapRedirect({ bootstrapUrl: BOOTSTRAP, host: '0.0.0.0' });
  } catch (error) {
    assert.match((error as Error).message, /must bind loopback/);
    return;
  } finally {
    await leaked?.close();
  }
  assert.fail('a non-loopback bind must be refused');
});

test('what Node fetch actually does with Sec-Fetch headers, recorded rather than assumed', async (t) => {
  const redirect = await createBootstrapRedirect({ bootstrapUrl: BOOTSTRAP });
  t.after(() => redirect.close());

  const res = await fetch(redirect.url, {
    redirect: 'manual',
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
  });

  // Measured on Node v24.20.0: undici does *not* strip these wholesale. It forwarded
  // `sec-fetch-dest: document` verbatim and overrode only `sec-fetch-mode`, setting it to `cors`.
  // So a Node `fetch` misses this check on one header, not two, and only because undici happens
  // to set that one itself — an implementation detail, not a guarantee. Which is exactly why the
  // module calls it a speed bump. Either outcome is accepted here so that a future undici change
  // reports itself instead of failing a test that was never about security.
  if (res.status === 303) {
    assert.equal(res.headers.get('location'), BOOTSTRAP,
      'undici now forwards both: the bump stops only an incurious caller');
  } else {
    assert.equal(res.status, 400, 'undici sets sec-fetch-mode itself, so this fetch cannot pass');
    assert.equal(res.headers.get('location'), null);
  }
});

test('a bootstrap with an embedded newline cannot crash the handler', async (t) => {
  // WHATWG URL strips TAB/CR/LF before parsing, so this passes the loopback check. Emitting the
  // raw text as a header would throw ERR_INVALID_CHAR inside the handler, which has no try/catch
  // — a crash rather than a refusal. Emitting `target.href` is what makes it harmless.
  const redirect = await createBootstrapRedirect({
    bootstrapUrl: `http://127.0.0.1:52999/boot\nstrap?token=${TOKEN}`,
  });
  t.after(() => redirect.close());

  const res = await navigate(redirect.url);
  assert.equal(res.status, 303);
  assert.equal(res.location?.includes('\n'), false, 'the emitted location is the parsed URL');
});

test('reading the bootstrap never puts the file contents in an error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-launch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const missing = join(dir, 'absent.operator-url');
  await assert.rejects(readBootstrapUrl(missing), (error: Error) => {
    assert.match(error.message, /is the WAG runtime running/);
    return true;
  });

  // A corrupt file is the interesting case: the naive implementation echoes what it read.
  const corrupt = join(dir, 'corrupt.operator-url');
  await writeFile(corrupt, `not-a-url-but-still-secret-${TOKEN}`, 'utf8');
  await assert.rejects(readBootstrapUrl(corrupt), (error: Error) => {
    assert.equal(error.message.includes(TOKEN), false, 'the error must not echo the file');
    assert.match(error.message, /is not a URL/);
    return true;
  });

  const good = join(dir, 'good.operator-url');
  await writeFile(good, `${BOOTSTRAP}\n`, 'utf8');
  assert.equal(await readBootstrapUrl(good), BOOTSTRAP, 'and a good one is returned intact');
});

test('the origin alone is what may be printed', () => {
  assert.equal(operatorOrigin(BOOTSTRAP), 'http://127.0.0.1:52999');
  assert.equal(operatorOrigin(BOOTSTRAP).includes(TOKEN), false);
});

test('the CLI starts no process at all, so no command line can carry the token', async () => {
  const source = await readFile(new URL('../scripts/open-operator.ts', import.meta.url), 'utf8');

  // Stronger than checking *what* is passed to a spawn: there is no spawn. A review pointed out
  // that the previous assertions — that `openInBrowser` received `redirect.url` and not
  // `bootstrapUrl` — were satisfied by `const target = bootstrapUrl; openInBrowser(target)`,
  // which publishes the token to the process table exactly as before. This cannot be.
  for (const spawner of ['child_process', 'spawn(', 'exec(', 'execFile(', 'fork(']) {
    assert.equal(source.includes(spawner), false, `the CLI must not reach for ${spawner}`);
  }

  // And nothing prints the bootstrap itself; only the origin, which the runtime already logs.
  assert.equal(/console\.(log|error)\([^)]*bootstrapUrl/.test(source), false,
    'the bootstrap URL is never written to output');
  assert.match(source, /console\.log\(`open this\s+: \$\{redirect\.url\}`\)/,
    'the handoff link is what a human is given');
});

test('the handoff window is adjustable but bounded', async () => {
  // Five minutes matched walking to the browser and did not match the real workflow — an expired,
  // uncollected handoff was observed. An armed handoff is a live loopback route to a credential,
  // so it is adjustable rather than unbounded, and the cap is asserted here rather than trusted
  // to the comment above it.
  const source = await readFile(new URL('../scripts/open-operator.ts', import.meta.url), 'utf8');
  assert.match(source, /MAX_HANDOFF_MINUTES = (\d+)/);
  const cap = Number(/MAX_HANDOFF_MINUTES = (\d+)/.exec(source)?.[1]);
  assert.ok(cap > 5 && cap <= 240, `the cap must be usable and still bounded, saw ${cap}`);
  assert.match(source, /--wait is capped at/, 'exceeding it must be refused with a reason');
  assert.match(source, /--wait takes a positive number of minutes/, 'and a nonsense value refused');
  // The default stays short: a longer window is something you ask for, not something you get.
  assert.match(source, /DEFAULT_HANDOFF_MINUTES = 5/);
});

test('the CLI cannot approve: it has no HTTP client and names no approval route', async () => {
  const source = await readFile(new URL('../scripts/open-operator.ts', import.meta.url), 'utf8');
  for (const token of ['fetch(', 'node:http', 'request(', '/approve', '/reject']) {
    assert.equal(source.includes(token), false, `the launcher must not contain ${token}`);
  }
});
