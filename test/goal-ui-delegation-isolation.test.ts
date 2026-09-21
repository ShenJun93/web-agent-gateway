import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BROWSER_OPERATOR_PROTOCOL_VERSION,
  parseBrowserOperatorRequest,
} from '../src/browser-adapter/protocol-v4.js';

/**
 * "The browser cannot reach issuance" is a claim about the shape of the program, so it is checked
 * against the program rather than asserted in a comment.
 *
 * These tests are the *structural* half. They are not sufficient on their own, and a review
 * proved it: an earlier draft passed every one of them while the dispatch plane held the whole
 * store and could therefore call `insertUiDelegation` directly — no import of the control module,
 * no mention of its class name. The dynamic half now lives in the plane suite, which calls the
 * port and watches the forbidden methods be absent. Both halves, or neither means much.
 */
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * The module *specifier*, not the bare name. Matching the quoted `.js` form catches a static
 * import, a dynamic `import()` and a `require()` alike, while leaving prose free to name the file
 * — which the dispatch plane does, to explain precisely what it is not allowed to reach.
 */
const CONTROL_SPECIFIER = /['"][^'"]*goal-ui-delegation-control\.js['"]/;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const read = async (path: string) => readFile(join(repoRoot, path), 'utf8');

test('nothing on the browser path can reach the control plane', async () => {
  const browserPath = [
    ...await walk(join(repoRoot, 'src', 'browser-adapter')),
    ...await walk(join(repoRoot, 'browser', 'extension')),
    join(repoRoot, 'src', 'browser-operator-runtime.ts'),
    join(repoRoot, 'src', 'goal-ui-delegation-dispatch.ts'),
    join(repoRoot, 'src', 'goal-ui-delegation.ts'),
  ];
  assert.ok(browserPath.length >= 15, `expected to walk the browser path, saw ${browserPath.length}`);

  for (const file of browserPath) {
    const source = await readFile(file, 'utf8');
    const name = relative(repoRoot, file);
    assert.equal(
      CONTROL_SPECIFIER.test(source), false,
      `${name} must not be able to reach delegation issuance`,
    );
    assert.equal(
      /createControllerPlaneKey|UiDelegationControlPlane/.test(source), false,
      `${name} must not name the control plane`,
    );
  }
});

test('the dispatch plane imports only what a browser-facing decision needs', async () => {
  const source = await read('src/goal-ui-delegation-dispatch.ts');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).filter(
    (m): m is string => typeof m === 'string' && m.startsWith('./'),
  );
  assert.deepEqual(
    [...new Set(imports)].sort(),
    [
      './durable-store.js', './goal-ui-delegation.js',
      './proposal-fingerprint.js', './proposal-rate-limit.js',
    ],
    'a new import here is how issuance would arrive on the browser path by accident',
  );
  // `durable-store.js` is imported for its *type* only — the plane is constructed with a port.
  assert.match(source, /import type \{ SqliteDurableStore \}/, 'the store is a type here, not a value');
});

test('the v4 protocol has no verb that issues, renews or revokes anything', async () => {
  assert.equal(BROWSER_OPERATOR_PROTOCOL_VERSION, 4, 'the frozen adapter revision');
  const source = await read('src/browser-adapter/protocol-v4.ts');
  // Case-insensitive and not restricted to dotted names: a camelCase or mixed-case verb would
  // have slipped past the previous extractor entirely.
  const literals = [...source.matchAll(/z\.literal\('([^']+)'\)/g)]
    .map((m) => m[1])
    .filter((name): name is string => typeof name === 'string');
  assert.ok(literals.length >= 20, `expected to extract the protocol literals, saw ${literals.length}`);
  const forbidden = literals.filter((name) => /delegat|lease|grant|issue|revoke|renew|authori|claim/i.test(name));
  assert.deepEqual(forbidden, [], 'the browser surface must expose no authority verb');
});

test('the v4 protocol fails closed on unknown fields', () => {
  // Dynamic, not a grep for `.strict()`. An extra field is how authority would be smuggled in if
  // the schema merely ignored what it did not recognise.
  const valid = {
    version: 4, type: 'tool.call', requestId: 'req_12345678', sessionId: 'session_12345678',
    tool: 'repo.search', arguments: { workspace_id: 'ws_1', query: 'needle' },
  };
  assert.doesNotThrow(() => parseBrowserOperatorRequest(valid));
  for (const extra of [
    { delegationId: 'uidel_0123456789abcdef' },
    { goalId: 'goal_abc' },
    { controllerId: 'claude.local.controller' },
    { authority: 'DELEGATED_RUN' },
    { maxActions: 999 },
  ]) {
    assert.throws(
      () => parseBrowserOperatorRequest({ ...valid, ...extra }),
      `${Object.keys(extra)[0]} must be refused, not ignored`,
    );
  }
  // And inside `arguments`, which is the part a page most influences.
  assert.throws(() => parseBrowserOperatorRequest({
    ...valid, arguments: { ...valid.arguments, delegationId: 'uidel_0123456789abcdef' },
  }));
});

test('the control plane is not wired into any shipped browser runtime', async () => {
  const sources = await walk(join(repoRoot, 'src'));
  const importers: string[] = [];
  for (const file of sources) {
    const name = relative(repoRoot, file).replace(/\\/g, '/');
    if (name.endsWith('goal-ui-delegation-control.ts')) continue;
    if (CONTROL_SPECIFIER.test(await readFile(file, 'utf8'))) importers.push(name);
  }
  assert.deepEqual(
    importers, [],
    'no runtime module imports the control plane yet; adding one is a deliberate decision',
  );
});

test('the state transitions take the write lock up front', async () => {
  // `BEGIN IMMEDIATE` is what actually serialises two claims: measured, a second connection's
  // `BEGIN IMMEDIATE` is refused within about a millisecond while one is open, whereas
  // `BEGIN DEFERRED` is granted. The difference is not observable through the store's own API in a
  // single-threaded test — both end in a throw — so the isolation level is pinned here instead of
  // left as an assumption a later edit could quietly drop.
  const source = await read('src/durable-store.ts');
  for (const method of [
    'claimDelegatedDispatch', 'markDelegatedDispatched', 'recordHumanRun',
    'renewUiDelegation', 'recordDelegatedRunRefusal', 'attachRunResult',
  ]) {
    const start = source.indexOf(`  ${method}(`);
    assert.ok(start > 0, `${method} must exist`);
    const body = source.slice(start, start + 2600);
    assert.match(body, /BEGIN IMMEDIATE/, `${method} must not run at a weaker isolation level`);
    assert.equal(/BEGIN (DEFERRED|TRANSACTION)/.test(body), false, `${method} isolation level`);
  }
});
