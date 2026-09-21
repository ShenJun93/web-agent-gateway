import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BROWSER_ADAPTER_V1_ID,
  BROWSER_DELEGATION_ADAPTER_ID,
  BROWSER_INSPECT_ADAPTER_ID,
  BROWSER_OPERATOR_ADAPTER_ID,
  BROWSER_VERIFY_ADAPTER_ID,
} from '../src/adapter-admission.js';
import {
  BROWSER_OPERATOR_PROTOCOL_VERSION,
  parseBrowserOperatorRequest,
} from '../src/browser-adapter/protocol-v4.js';
import {
  DELEGATED_DISPATCH_PROTOCOL_VERSION,
  DELEGATED_DISPATCH_VERBS,
} from '../src/browser-adapter/protocol-v5.js';

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
    join(repoRoot, 'src', 'delegated-dispatch-router.ts'),
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
      './authority-tuple.js', './browser-adapter/protocol-v5.js', './durable-store.js',
      './goal-ui-delegation.js', './proposal-fingerprint.js', './proposal-rate-limit.js',
    ],
    'a new import here is how issuance would arrive on the browser path by accident',
  );
  // `durable-store.js` is imported for its *type* only — the plane is constructed with a port.
  assert.match(source, /import type \{ SqliteDurableStore \}/, 'the store is a type here, not a value');
  // `protocol-v5.js` is here for `validateStageableArguments`, which bounds a staged candidate by
  // v4's own per-tool schemas. It looks like a layering inversion — the authority plane reaching
  // for a transport module — and it is deliberate: argument bounds are an authority concern, and a
  // review measured what their absence cost. The import brings one pure validator and no protocol
  // state, and the protocol module reaches nothing the plane could not already reach.
  assert.match(source, /validateStageableArguments/, 'and the protocol import is for that one validator');

  // `authority-tuple.js` is the shared "are these the same owner, session and adapter" predicate.
  // It was added to this list deliberately, and the reason it is safe is checkable rather than
  // asserted: the module has **no runtime imports at all**, so allowing it here cannot become a
  // route to anything. If it ever grows one, this fails and the decision gets made again.
  const tuple = await read('src/authority-tuple.ts');
  const tupleImports = [...tuple.matchAll(/^import (?!type )/gm)];
  assert.deepEqual(
    tupleImports.map((m) => m[0]), [],
    'authority-tuple.ts must stay import-free at runtime; it is on the browser path',
  );
  assert.match(tuple, /export function sameAuthorityTuple/, 'and it is there for that predicate');
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

test('the control plane is not wired into any shipped module', async () => {
  const sources = await walk(join(repoRoot, 'src'));
  const importers: string[] = [];
  for (const file of sources) {
    const name = relative(repoRoot, file).replace(/\\/g, '/');
    if (name.endsWith('goal-ui-delegation-control.ts')) continue;
    if (CONTROL_SPECIFIER.test(await readFile(file, 'utf8'))) importers.push(name);
  }
  // The fixture lane imports it deliberately (ADR-0027): it issues fixture delegations so the
  // zero-manual-Run proof needs no human act. That exemption has to be *earned*, not asserted, so
  // the assertions below are what make it one — the lane is excluded from the shipped build, and
  // `harness-authority.test.ts` separately proves no production module imports the lane. The
  // direction is the whole containment: the lane may reach into production, never the reverse.
  assert.deepEqual(
    importers, ['src/harness-authority.ts'],
    'only the fixture lane may import the control plane; anything else is a deliberate decision',
  );
  const build = JSON.parse(await read('tsconfig.build.json')) as { exclude: string[] };
  assert.ok(
    build.exclude.includes('src/harness-authority.ts'),
    'the lane is excluded from the shipped build, which is what makes its exemption safe',
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

test('the v5 transport has no issuance verb and no tool.call', async () => {
  // v5 is where delegated dispatch lives, so it is the surface that most needs checking. Its
  // verb list is a literal in the source and a runtime export; both are asserted, because a
  // source-text check alone would miss a list built at runtime and a runtime check alone would
  // miss a verb the schema accepts but the list forgot.
  assert.equal(DELEGATED_DISPATCH_PROTOCOL_VERSION, 5);
  assert.deepEqual(
    [...DELEGATED_DISPATCH_VERBS].filter((v) => /issue|grant|renew|revoke|widen|authori|lease|delegat/i.test(v)),
    [],
  );
  assert.equal([...DELEGATED_DISPATCH_VERBS].includes('tool.call' as never), false,
    'v5 is narrower than v4: the tool that runs is the stored one, not one the browser names');

  const source = await read('src/browser-adapter/protocol-v5.ts');
  const literals = [...source.matchAll(/z\.literal\('([^']+)'\)/g)]
    .map((m) => m[1])
    .filter((name): name is string => typeof name === 'string');
  const verbs = literals.filter((name) => [...DELEGATED_DISPATCH_VERBS].includes(name as never));
  assert.deepEqual(
    [...new Set(verbs)].sort(), [...DELEGATED_DISPATCH_VERBS].sort(),
    'every declared verb is a literal in the schema, and the schema declares no others',
  );
});

test('the transport seam cannot reach issuance either', async () => {
  // The router and the extension core are on the browser path by definition: everything they do
  // happens because a browser said something.
  for (const path of [
    'src/delegated-dispatch-router.ts',
    'src/browser-adapter/protocol-v5.ts',
    'browser/extension/delegated-dispatch-core-v5.js',
  ]) {
    const source = await read(path);
    assert.equal(CONTROL_SPECIFIER.test(source), false, `${path} must not reach issuance`);
    assert.equal(/createControllerPlaneKey|UiDelegationControlPlane/.test(source), false, path);
  }
  // And the router's imports are pinned, as the plane's are: a new one here is how issuance would
  // arrive on the transport by accident.
  const router = await read('src/delegated-dispatch-router.ts');
  const imports = [...router.matchAll(/from '([^']+)'/g)].map((m) => m[1]).filter(
    (m): m is string => typeof m === 'string' && m.startsWith('./'),
  );
  assert.deepEqual(
    [...new Set(imports)].sort(),
    [
      // `adapter-admission.js` for the v5 identity: the router refuses any connection that is not
      // a v5 one, which is what makes "a v4 session cannot speak these verbs" true rather than
      // merely stated. A review drove a full DELEGATED_RUN through a v4-identity connection before
      // this existed.
      './adapter-admission.js', './browser-adapter/protocol-v5.js',
      './goal-ui-delegation-dispatch.js', './goal-ui-delegation.js',
    ],
  );
});

test('the delegation adapter identity is distinct from every frozen one', async () => {
  // A delegation binds `adapterId`. If v5 shared an identity with v4, a v4 session would satisfy
  // that binding — which is exactly what the freeze exists to prevent.
  const ids = new Set([
    BROWSER_ADAPTER_V1_ID, BROWSER_INSPECT_ADAPTER_ID, BROWSER_VERIFY_ADAPTER_ID,
    BROWSER_OPERATOR_ADAPTER_ID, BROWSER_DELEGATION_ADAPTER_ID,
  ]);
  assert.equal(ids.size, 5, 'every adapter identity is distinct');
  assert.equal(BROWSER_DELEGATION_ADAPTER_ID, 'browser.chatgpt.native.delegation.v5');

  // And the frozen ones are unchanged by this milestone.
  assert.equal(BROWSER_VERIFY_ADAPTER_ID, 'browser.chatgpt.native.verify.v3');
  assert.equal(BROWSER_OPERATOR_ADAPTER_ID, 'browser.chatgpt.native.operator.v4');
});
