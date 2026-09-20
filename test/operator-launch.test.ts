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
 * A browser navigation has to be made with a raw client, not `fetch`.
 *
 * `Sec-Fetch-*` are forbidden header names: the Fetch spec bars script from setting them, and
 * undici strips them silently, so a `fetch` here arrives looking exactly like the non-navigation
 * case. That is itself worth knowing — it means no `fetch()`, in Node or in a page, can forge the
 * check. A raw socket still can, which is why the module calls it a speed bump and not a control.
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

test('the launcher never passes the bootstrap on a command line', async () => {
  // The whole reason this module exists. A command line is readable by any process on this
  // account, so the CLI must hand the browser the redirect and nothing else.
  const source = await readFile(new URL('../scripts/open-operator.ts', import.meta.url), 'utf8');
  assert.match(source, /openInBrowser\(redirect\.url\)/, 'the browser is opened at the redirect');
  assert.equal(/openInBrowser\(\s*bootstrapUrl/.test(source), false, 'and never at the bootstrap');
  // Nothing prints the bootstrap itself.
  assert.equal(/console\.(log|error)\([^)]*bootstrapUrl/.test(source), false,
    'the bootstrap URL is never written to output');
});
