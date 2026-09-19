import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import {
  DC_FIXTURE_BASELINE_HEAD,
  DC_FIXTURE_BASELINE_TREE,
  DC_FIXTURE_FIXED_IMPLEMENTATION,
  DC_FIXTURE_IMPLEMENTATION,
  DC_FIXTURE_SENTINEL,
  DC_FIXTURE_TEST,
  fixtureStatus,
  materializeDcReplacementFixture,
} from './dc-replacement-fixture.js';
import { DEVSPACE_TEST_OWNER_TOKEN, startPinnedDevspace } from './devspace-fixture.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const builtCli = join(repoRoot, 'dist', 'cli.js');

const EXTENDED_TOOLS = [
  'health', 'workspace.open', 'repo.list', 'repo.search', 'repo.snapshot', 'repo.diff',
  'file.read', 'verify.run',
  'mutation.preview', 'file.create', 'mutation.result',
];

interface ToolText { content: { text: string }[] }
function parse<T>(response: unknown): T {
  return JSON.parse((response as ToolText).content[0]!.text) as T;
}

/**
 * Drives the local operator review server exactly as a human browser would: redeem the
 * one-time bootstrap URL, keep the session cookie, read the CSRF token out of the rendered
 * review page, and POST the approval with a matching Origin header.
 */
class OperatorBrowser {
  private cookie = '';
  constructor(private readonly origin: string) {}

  static async open(bootstrapUrl: string): Promise<OperatorBrowser> {
    const response = await fetch(bootstrapUrl, { redirect: 'manual' });
    assert.equal(response.status, 303, 'bootstrap redemption must redirect into an authenticated session');
    const setCookie = response.headers.get('set-cookie');
    assert.ok(setCookie, 'bootstrap must issue an operator session cookie');
    const browser = new OperatorBrowser(new URL(bootstrapUrl).origin);
    browser.cookie = setCookie.split(';')[0]!;
    return browser;
  }

  async review(mutationId: string): Promise<string> {
    const response = await fetch(`${this.origin}/mutations/${encodeURIComponent(mutationId)}`, {
      headers: { cookie: this.cookie },
    });
    assert.equal(response.status, 200, 'the operator must be able to read the exact pending review');
    return response.text();
  }

  async act(mutationId: string, action: 'approve' | 'reject', csrf: string, overrides: { origin?: string } = {}) {
    return fetch(`${this.origin}/mutations/${encodeURIComponent(mutationId)}/${action}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: this.cookie,
        origin: overrides.origin ?? this.origin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf }).toString(),
    });
  }

  /** An unauthenticated caller, i.e. anything that only learned the origin. */
  static async anonymous(origin: string, mutationId: string) {
    return fetch(`${origin}/mutations/${encodeURIComponent(mutationId)}/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'guessed' }).toString(),
    });
  }
}

function csrfFrom(html: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the review page must carry a CSRF token');
  return match[1]!;
}

test('WAG DC Replacement v1 production-local acceptance', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'wag-dc-acceptance-'));
  const fixture = await materializeDcReplacementFixture(temp);
  assert.equal(fixture.head, DC_FIXTURE_BASELINE_HEAD);
  assert.equal(fixture.tree, DC_FIXTURE_BASELINE_TREE);

  const devspace = await startPinnedDevspace({ workspaceRoot: fixture.workspaceRoot });
  t.after(async () => { await devspace.stop(); await rm(temp, { recursive: true, force: true }); });

  const statePath = join(temp, 'control-plane.sqlite');
  const configPath = join(temp, 'private.json');
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [fixture.workspaceRoot],
    devspace: { baseUrl: devspace.baseUrl, resourceUrl: devspace.resourceUrl },
    verifyProfiles: { unit: { argv: ['npm', 'test'], timeoutMs: 30_000, maxOutputTokens: 4_000 } },
    repositoryEngineering: { inspect: true, mutation: { statePath, ownerId: 'local.private.stdio' } },
  }), 'utf8');

  // The measured path is the built artifact spawned as a real child over a real stdio transport.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [builtCli, 'serve-stdio', '--config', configPath],
    env: { ...getDefaultEnvironment(), DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN },
    stderr: 'pipe',
    cwd: repoRoot,
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: 'dc-replacement-acceptance', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  t.after(async () => { await client.close().catch(() => undefined); });
  const gatewayPid = transport.pid;
  assert.ok(gatewayPid, 'the gateway must run as a separate process');

  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), EXTENDED_TOOLS);

  const { workspaceId } = parse<{ workspaceId: string }>(
    await client.callTool({ name: 'workspace.open', arguments: { path: fixture.workspaceRoot } }));

  // R0
  assert.equal(parse<{ content: string }>(await client.callTool({
    name: 'file.read', arguments: { workspace_id: workspaceId, path: 'docs/sentinel.txt' },
  })).content, DC_FIXTURE_SENTINEL);

  // R1 — the prompt-equivalent input names only the behaviour, never the file.
  const search = parse<{ matches: { path: string; line: number }[] }>(await client.callTool({
    name: 'repo.search', arguments: { workspace_id: workspaceId, query: 'canonicalizeTicketId' },
  }));
  const located = new Set(search.matches.map((match) => match.path));
  assert.ok(located.has(DC_FIXTURE_IMPLEMENTATION));
  assert.ok(located.has(DC_FIXTURE_TEST));

  // R1b — navigate the tree the way an engineer would, without a shell.
  const listed = parse<{ path: string; entries: { name: string; type: string }[] }>(await client.callTool({
    name: 'repo.list', arguments: { workspace_id: workspaceId, path: 'src/lib' },
  }));
  assert.deepEqual(listed.entries, [{ name: 'ticket-id.js', type: 'file', tracked: true }]);

  const rootListing = parse<{ entries: { name: string; type: string }[] }>(
    await client.callTool({ name: 'repo.list', arguments: { workspace_id: workspaceId } }));
  assert.deepEqual(
    rootListing.entries.filter((entry) => entry.type === 'directory').map((entry) => entry.name),
    ['docs', 'notes', 'src', 'test'],
  );

  // R2
  const snapshot = parse<{ branch: string; head: string; dirty: boolean }>(
    await client.callTool({ name: 'repo.snapshot', arguments: { workspace_id: workspaceId } }));
  assert.deepEqual(
    { branch: snapshot.branch, head: snapshot.head, dirty: snapshot.dirty },
    { branch: 'main', head: DC_FIXTURE_BASELINE_HEAD, dirty: false },
  );

  // V1 — baseline oracle
  const baseline = parse<{ exitCode: number; output: string }>(
    await client.callTool({ name: 'verify.run', arguments: { workspace_id: workspaceId, profile: 'unit' } }));
  assert.equal(baseline.exitCode, 1);
  assert.match(baseline.output, /tests 2/);
  assert.match(baseline.output, /pass 1/);
  assert.match(baseline.output, /fail 1/);

  // C1 — propose, then approve through the real loopback operator server.
  const original = await readFile(join(fixture.workspaceRoot, DC_FIXTURE_IMPLEMENTATION), 'utf8');
  const preview = parse<{ status: string; mutationId: string; fingerprint: string }>(await client.callTool({
    name: 'mutation.preview',
    arguments: {
      workspace_id: workspaceId,
      path: DC_FIXTURE_IMPLEMENTATION,
      base_sha256: createHash('sha256').update(original, 'utf8').digest('hex'),
      before: 'return value.toLowerCase();',
      after: 'return value.trim().toLowerCase();',
    },
  }));
  assert.equal(preview.status, 'approval_required');
  assert.equal(await readFile(join(fixture.workspaceRoot, DC_FIXTURE_IMPLEMENTATION), 'utf8'), original);
  assert.deepEqual(await fixtureStatus(fixture.workspaceRoot), []);

  const operatorMatch = /"type":"gateway\.operator","origin":"([^"]+)","urlFile":"([^"]+)"/.exec(stderr);
  assert.ok(operatorMatch, `the gateway must announce the operator origin locally; stderr was: ${stderr}`);
  const operatorOrigin = operatorMatch[1]!;
  assert.match(operatorOrigin, /^http:\/\/127\.0\.0\.1:/, 'operator review must bind loopback only');
  assert.equal(/token=/.test(stderr), false,
    'the single-use bootstrap token must not reach the stderr pipe the spawning client inherits');

  // The operator reads the single-use token from disk, beside the state database.
  const bootstrapUrl = (await readFile(JSON.parse(`"${operatorMatch[2]!}"`) as string, 'utf8')).trim();
  assert.equal(new URL(bootstrapUrl).origin, operatorOrigin);

  const anonymous = await OperatorBrowser.anonymous(operatorOrigin, preview.mutationId);
  assert.equal(anonymous.status, 401, 'knowing the operator origin must not grant approval authority');
  assert.equal(await readFile(join(fixture.workspaceRoot, DC_FIXTURE_IMPLEMENTATION), 'utf8'), original);

  const operator = await OperatorBrowser.open(bootstrapUrl);
  const reviewPage = await operator.review(preview.mutationId);
  assert.ok(reviewPage.includes(DC_FIXTURE_IMPLEMENTATION), 'the operator must see the exact target path');
  const csrf = csrfFrom(reviewPage);

  const replayedBootstrap = await fetch(bootstrapUrl, { redirect: 'manual' });
  assert.equal(replayedBootstrap.status, 403, 'the bootstrap token must be single use');

  const wrongOrigin = await operator.act(preview.mutationId, 'approve', csrf, { origin: 'http://evil.invalid' });
  assert.equal(wrongOrigin.status, 403, 'a cross-origin approval must be refused');
  assert.equal(await readFile(join(fixture.workspaceRoot, DC_FIXTURE_IMPLEMENTATION), 'utf8'), original);

  const approved = await operator.act(preview.mutationId, 'approve', csrf);
  assert.equal(approved.status, 303, 'the local operator approval must succeed');

  const replayed = await operator.act(preview.mutationId, 'approve', csrf);
  assert.equal(replayed.status, 409, 'approval must be single use');

  assert.equal(parse<{ state: string }>(await client.callTool({
    name: 'mutation.result', arguments: { mutation_id: preview.mutationId },
  })).state, 'SUCCEEDED');
  assert.equal(await readFile(join(fixture.workspaceRoot, DC_FIXTURE_IMPLEMENTATION), 'utf8'),
    DC_FIXTURE_FIXED_IMPLEMENTATION);

  // D1 — close the loop on the same built surface.
  const afterFix = parse<{ exitCode: number; output: string }>(
    await client.callTool({ name: 'verify.run', arguments: { workspace_id: workspaceId, profile: 'unit' } }));
  assert.equal(afterFix.exitCode, 0);
  assert.match(afterFix.output, /pass 2/);
  assert.match(afterFix.output, /fail 0/);

  // C2 — a brand new file, the step that previously forced another tool entirely.
  const createdPath = 'test/ticket-id.extra.test.js';
  const createdContent = [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { canonicalizeTicketId } from '../src/lib/ticket-id.js';",
    '',
    "test('created by WAG', () => {",
    "  assert.equal(canonicalizeTicketId('  QQ-7  '), 'qq-7');",
    '});',
    '',
  ].join('\n');
  const createPreview = parse<{ status: string; mutationId: string }>(await client.callTool({
    name: 'file.create',
    arguments: { workspace_id: workspaceId, path: createdPath, content: createdContent },
  }));
  assert.equal(createPreview.status, 'approval_required');
  await assert.rejects(() => readFile(join(fixture.workspaceRoot, createdPath), 'utf8'),
    'a creation proposal must not touch the workspace');

  const createReview = await operator.review(createPreview.mutationId);
  assert.ok(createReview.includes(createdPath), 'the operator must see the exact new path');
  assert.equal((await operator.act(createPreview.mutationId, 'approve', csrfFrom(createReview))).status, 303);
  assert.equal(await readFile(join(fixture.workspaceRoot, createdPath), 'utf8'), createdContent);

  // The created test must actually run, proving the file landed usable rather than merely present.
  const afterCreate = parse<{ exitCode: number; output: string }>(
    await client.callTool({ name: 'verify.run', arguments: { workspace_id: workspaceId, profile: 'unit' } }));
  assert.equal(afterCreate.exitCode, 0);
  assert.match(afterCreate.output, /tests 3/, 'the newly created test must be picked up and pass');

  // Review the applied change through WAG itself rather than an outside shell.
  const reviewDiff = parse<{ diff: string; truncated: boolean }>(await client.callTool({
    name: 'repo.diff', arguments: { workspace_id: workspaceId, path: DC_FIXTURE_IMPLEMENTATION },
  }));
  assert.equal(reviewDiff.truncated, false);
  assert.match(reviewDiff.diff, /-\s*return value\.toLowerCase\(\);/);
  assert.match(reviewDiff.diff, /\+\s*return value\.trim\(\)\.toLowerCase\(\);/);

  const finalSnapshot = parse<{ branch: string; head: string; dirty: boolean }>(
    await client.callTool({ name: 'repo.snapshot', arguments: { workspace_id: workspaceId } }));
  assert.equal(finalSnapshot.head, DC_FIXTURE_BASELINE_HEAD, 'no commit may be created');
  assert.equal(finalSnapshot.dirty, true);
  assert.deepEqual(await fixtureStatus(fixture.workspaceRoot), [
    `M ${DC_FIXTURE_IMPLEMENTATION}`,
    `?? ${createdPath}`,
  ], 'exactly one modified tracked file and exactly one new untracked file');

  // Containment: the untrusted repository note must not reach outside the workspace.
  const note = parse<{ content: string }>(await client.callTool({
    name: 'file.read', arguments: { workspace_id: workspaceId, path: 'notes/operator-notes.md' },
  }));
  assert.ok(note.content.length > 0);
  const escape = await client.callTool({
    name: 'file.read', arguments: { workspace_id: workspaceId, path: '../outside-canary.txt' },
  });
  assert.equal((escape as { isError?: boolean }).isError, true);
  assert.equal(JSON.stringify(escape).includes('DO_NOT_DISCLOSE'), false);

  // Secret containment on the local diagnostic channel and the remote transport alike.
  assert.equal(stderr.includes(DEVSPACE_TEST_OWNER_TOKEN), false,
    'the DevSpace owner token must never appear in gateway diagnostics');

  await client.close();

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    acceptance: 'WAG_DC_REPLACEMENT_V1_PRODUCTION_LOCAL',
    builtCli,
    gatewayPid,
    devspacePid: devspace.pid,
    tools: EXTENDED_TOOLS,
    fixtureHead: fixture.head,
    fixtureTree: fixture.tree,
    baselineExitCode: baseline.exitCode,
    afterFixExitCode: afterFix.exitCode,
    operatorApprovals: 2,
    createdFile: createdPath,
    finalStatus: await fixtureStatus(fixture.workspaceRoot),
  }));
});
