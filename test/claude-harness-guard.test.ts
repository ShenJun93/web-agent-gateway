import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * The Claude harness guard (`.claude/hooks/wag-human-gate-guard.mjs`).
 *
 * WAG's two human gestures are Run in the side panel and approve/reject on the local operator
 * (ADR-0026: RUN_AND_APPROVAL = HUMAN). The guard is the deterministic half of keeping Claude
 * automation off both. It is not the security boundary — WAG's own authority checks are — so
 * these tests cover what it actually enforces and pin the places it deliberately does not, so
 * that a later reader cannot mistake its strength.
 */
const guardUrl = new URL('../.claude/hooks/wag-human-gate-guard.mjs', import.meta.url);
const guardPath = fileURLToPath(guardUrl);
const settingsUrl = new URL('../.claude/settings.json', import.meta.url);
const run = promisify(execFile);

type Verdict = { deny: false } | { deny: true; reason: string };
const { decide } = (await import(guardUrl.href)) as { decide: (event: unknown) => Verdict };

const call = (tool_name: string, tool_input: unknown) => decide({ tool_name, tool_input });

const denied = (verdict: Verdict, what: string): string => {
  assert.equal(verdict.deny, true, `${what} must be refused`);
  return (verdict as { deny: true; reason: string }).reason;
};

test('the side panel Run control cannot be reached by browser automation', () => {
  // The Run button lives in the side panel document and sends `panel.execute`. Both the document
  // and the message are refused, and so is any other extension document: reaching one is the
  // precondition for clicking what is on it.
  for (const [tool, input] of [
    ['mcp__plugin_playwright_playwright__browser_navigate', { url: 'chrome-extension://abc/sidepanel.html' }],
    ['mcp__Claude_Browser__computer', { action: 'left_click', ref: 'ref_2', tabId: 'chrome-extension://abc/sidepanel.html' }],
    ['mcp__Claude_Browser__javascript_tool', { text: "chrome.runtime.sendMessage({type:'panel.execute',requestId:r})" }],
    ['mcp__claude-in-chrome__navigate', { url: 'chrome-extension://abc/sidepanel.html' }],
    ['mcp__plugin_chrome-devtools-mcp_chrome-devtools__evaluate_script', { function: "() => document.querySelector('#pending button').click()  // sidepanel.html" }],
    ['mcp__plugin_browser-use_browser-use__browser_exec', { code: "goto_url('chrome-extension://abc/sidepanel.html')" }],
  ] as const) {
    denied(call(tool, input), `${tool} aimed at the Run surface`);
  }
});

test('the operator approval routes and its single-use bootstrap are refused from a shell', () => {
  // The bootstrap is the operator's credential and it is single-use: spending it does not merely
  // bypass the gate, it takes their approval session away from them.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['Bash', 'curl -s http://127.0.0.1:52341/bootstrap > /tmp/b'],
    ['Bash', 'curl -X POST http://localhost:52341/mutations/mut_abc/approve'],
    ['Bash', 'curl -X POST http://127.0.0.1:9/commits/cmt_1/reject'],
    ['PowerShell', 'Invoke-WebRequest http://127.0.0.1:52341/verifications/vr_1/approve -Method POST'],
    ['PowerShell', 'Get-Content $env:LOCALAPPDATA\\WebAgentGateway\\browser-operator-v4.sqlite.operator-url'],
    ['Bash', "sqlite3 browser-operator-v4.sqlite \"update mutations set state='approved'\""],
  ];
  for (const [tool, command] of cases) denied(call(tool, { command }), command);
});

test('every actuating Computer Use verb is refused, and the observational ones are not', () => {
  // A screen coordinate carries no target, so the guard cannot tell a click on Run from any other
  // click. It refuses the whole actuating set rather than claim a precision it does not have.
  const actuating = [
    'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
    'left_click_drag', 'left_mouse_down', 'left_mouse_up',
    'type', 'key', 'hold_key', 'write_clipboard', 'teach_step', 'teach_batch', 'computer_batch',
  ];
  for (const verb of actuating) {
    const reason = denied(call(`mcp__computer-use__${verb}`, { coordinate: [10, 10] }), verb);
    assert.match(reason, /coordinate carries no target/, `${verb} must say why, not just refuse`);
  }

  // These are what keep ordinary window handling and visual evidence available, which is the
  // whole reason the refusal above can be this blunt without blocking the work.
  for (const verb of ['screenshot', 'zoom', 'cursor_position', 'wait', 'scroll', 'mouse_move',
    'open_application', 'request_access', 'list_granted_applications', 'read_clipboard']) {
    assert.equal(call(`mcp__computer-use__${verb}`, {}).deny, false, `${verb} must stay available`);
  }
});

test('ordinary inspection is never blocked', () => {
  // The guard may only ever add denials. If it starts refusing reading, it has stopped being a
  // human-presence guard and become an obstacle, and the work routes around it instead.
  const allowed: ReadonlyArray<readonly [string, unknown]> = [
    ['mcp__Claude_Browser__read_page', { tabId: 'chrome-extension://abc/sidepanel.html' }],
    ['mcp__Claude_Browser__get_page_text', {}],
    ['mcp__Claude_Browser__read_console_messages', { onlyErrors: true }],
    ['mcp__plugin_playwright_playwright__browser_snapshot', {}],
    ['mcp__plugin_playwright_playwright__browser_type', { ref: 'ref_3', text: 'fixture data' }],
    ['mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_console_messages', {}],
    ['Bash', 'git log --oneline -5'],
    ['Bash', 'grep -rn bootstrap docs/adr/0019-separate-browser-proposal-from-consequential-authority.md'],
    ['Bash', 'node dist/cli.js serve-browser-operator --config C:/wag/config.json'],
    ['Read', { file_path: 'browser/extension/sidepanel.js' }],
    ['Edit', { file_path: 'src/operator-server.ts', old_string: 'a', new_string: 'b' }],
  ];
  for (const [tool, input] of allowed) {
    assert.equal(call(tool, input).deny, false, `${tool} must not be refused: ${JSON.stringify(input)}`);
  }
});

test('a tool call the guard cannot read is refused rather than waved through', () => {
  denied(call('', {}), 'a call with no tool name');
  denied(decide({ tool_input: { command: 'git status' } }), 'an event with no tool name');
});

test('selecting or opening a target is treated as reaching it, not as reading it', () => {
  // Tab selection is not inspection: making the panel the active target is how a later ref-based
  // click acquires something to click. Read-only listing stays allowed; changing focus does not.
  denied(
    call('mcp__plugin_playwright_playwright__browser_tabs', { action: 'select', url: 'chrome-extension://abc/sidepanel.html' }),
    'selecting the side panel tab',
  );
  denied(
    call('mcp__plugin_chrome-devtools-mcp_chrome-devtools__select_page', { pageIdx: 'chrome-extension://abc/sidepanel.html' }),
    'selecting the side panel page',
  );
  assert.equal(
    call('mcp__plugin_playwright_playwright__browser_tabs', { action: 'list' }).deny,
    false,
    'listing tabs is inspection and must stay allowed',
  );
});

test('the hook process honours the PreToolUse wire contract', async () => {
  // `decide` being right is not enough: Claude runs this as a process, and a malformed frame on
  // stdout would be read as "no opinion" and open the gate silently.
  const exec = async (stdin: string) => {
    const child = execFile(process.execPath, [guardPath], { encoding: 'utf8' });
    child.stdin?.end(stdin);
    const chunks: string[] = [];
    child.stdout?.on('data', (c: string) => chunks.push(c));
    await new Promise((resolve) => child.on('close', resolve));
    return chunks.join('');
  };

  const refused = JSON.parse(await exec(JSON.stringify({
    tool_name: 'mcp__computer-use__left_click',
    tool_input: { coordinate: [4, 4] },
  })));
  assert.equal(refused.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(refused.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(refused.hookSpecificOutput.permissionDecisionReason.length > 0);

  // Silence means "no opinion", which is what leaves ordinary calls to the normal permission flow.
  assert.equal(await exec(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })), '');

  // An unparseable frame fails closed. The guard cannot show the call is safe, and a loud
  // refusal that is fixed by editing one file beats silently opening the gate.
  const broken = JSON.parse(await exec('}{ not json'));
  assert.equal(broken.hookSpecificOutput.permissionDecision, 'deny');
});

test('the project settings deny what the guard denies, and wire the guard in', async () => {
  // Two independent layers only help while they agree. If a verb is added to the guard and not to
  // the deny list, the weaker layer silently stops covering it.
  const settings = JSON.parse(await readFile(settingsUrl, 'utf8')) as {
    permissions: { deny: string[] };
    hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; args?: string[] }> }> };
  };
  const guardSource = await readFile(guardUrl, 'utf8');
  const actuating = /const COMPUTER_USE_ACTUATING = new Set\(\[([\s\S]*?)\]\)/.exec(guardSource);
  assert.ok(actuating, 'the guard must keep declaring its actuating set');
  for (const verb of actuating[1].match(/'([a-z_]+)'/g) ?? []) {
    const name = `mcp__computer-use__${verb.slice(1, -1)}`;
    assert.ok(settings.permissions.deny.includes(name), `${name} is guarded but not denied in settings.json`);
  }

  // Desktop Commander is FALLBACK_ONLY, which is only true if reaching for it takes a deliberate act.
  assert.ok(
    settings.permissions.deny.some((rule) => rule.startsWith('mcp__2edf08a6-')),
    'Desktop Commander must stay denied so it cannot drift into an acceptance path',
  );

  const wired = settings.hooks.PreToolUse.flatMap((entry) => entry.hooks);
  assert.ok(
    wired.some((hook) => (hook.args ?? []).some((arg) => arg.includes('wag-human-gate-guard.mjs'))),
    'the guard must be wired as a PreToolUse hook or it enforces nothing',
  );

  // A matcher is a tool name, a pipe-separated list, or empty for "every tool". It is not a glob:
  // "*" is read as a literal tool name, matches nothing, and leaves the guard silently inert —
  // which is exactly how it was first written here, and the hook never fired.
  for (const entry of settings.hooks.PreToolUse) {
    const matcher = (entry as { matcher?: string }).matcher ?? '';
    assert.equal(matcher.includes('*'), false, `matcher ${JSON.stringify(matcher)} is read literally, so "*" matches no tool`);
    assert.ok(
      matcher === '' || entry.hooks.every((hook) => (hook.args ?? []).some((a) => a.includes('wag-human-gate-guard.mjs')) === false),
      'the guard must be registered against every tool, so its matcher has to be empty',
    );
  }
});

test('the hook command as configured actually resolves and runs', async () => {
  // A hook whose command cannot be executed does not fail closed — Claude Code logs the error and
  // lets the call through. That is how this one was first written: `$CLAUDE_PROJECT_DIR` is not
  // expanded inside `args`, node could not find the module, and every prohibited call was allowed
  // while the configuration looked correct. So run it exactly as configured, from the project root.
  const settings = JSON.parse(await readFile(settingsUrl, 'utf8')) as {
    hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; args?: string[] }> }> };
  };
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const hook = settings.hooks.PreToolUse
    .flatMap((entry) => entry.hooks)
    .find((candidate) => (candidate.args ?? []).some((arg) => arg.includes('wag-human-gate-guard.mjs')));
  assert.ok(hook, 'the guard must be configured as a PreToolUse hook');

  for (const arg of hook.args ?? []) {
    assert.equal(arg.includes('$'), false, `${arg} keeps a shell variable that the exec form does not expand`);
  }

  const child = execFile(hook.command, hook.args ?? [], { cwd: projectRoot, encoding: 'utf8' });
  child.stdin?.end(JSON.stringify({
    tool_name: 'mcp__computer-use__left_click',
    tool_input: { coordinate: [1, 1] },
  }));
  const out: string[] = [];
  const err: string[] = [];
  child.stdout?.on('data', (c: string) => out.push(c));
  child.stderr?.on('data', (c: string) => err.push(c));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

  assert.equal(err.join(''), '', 'the configured hook wrote to stderr, so it did not run cleanly');
  assert.equal(code, 0, 'the configured hook must exit 0; a crash is read as "no decision"');
  assert.equal(
    JSON.parse(out.join('')).hookSpecificOutput.permissionDecision,
    'deny',
    'the guard, run exactly as configured, must still refuse a prohibited call',
  );
});

test('no root CLAUDE.md, because one would silently displace AGENTS.md', async () => {
  // Claude Code 2.1.278 defaults `instructionFiles` to "claude-md-or-agents-md": a project gets
  // its AGENTS.md loaded only while it has no CLAUDE.md of its own. Adding one here would quietly
  // stop this repository's authority document from being read at all.
  const root = new URL('../', import.meta.url);
  for (const candidate of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    const exists = await readFile(new URL(candidate, root), 'utf8').then(() => true, () => false);
    assert.equal(exists, false, `${candidate} exists and would displace AGENTS.md as project instructions`);
  }
  await readFile(new URL('AGENTS.md', root), 'utf8');
});

test('the harness carries no secret and the guard shells out to nothing', async () => {
  // A PreToolUse hook runs before every tool call, so it is the most attractive place in the repo
  // to hide an execution foothold. It must stay a pure function of its stdin.
  const guardSource = await readFile(guardUrl, 'utf8');
  for (const forbidden of ['child_process', 'node:fs', 'node:net', 'node:http', 'fetch(', 'eval(']) {
    assert.equal(guardSource.includes(forbidden), false, `the guard must not reach for ${forbidden}`);
  }
  await run(process.execPath, ['--check', guardPath]);
});
