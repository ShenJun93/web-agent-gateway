#!/usr/bin/env node
/**
 * PreToolUse guard for WAG's human-authority controls.
 *
 * WAG's two human gestures are Run in the browser side panel and approve/reject on the local
 * operator review server (ADR-0019, ADR-0026: RUN_AND_APPROVAL = HUMAN). This hook is the
 * deterministic half of keeping Claude automation away from both. It is not the security
 * boundary — WAG's own authority checks are — and `.claude/rules/human-presence-boundary.md`
 * states exactly where it stops. Read that before trusting anything here.
 *
 * Contract, verified against the installed Claude Code (2.1.278):
 *   in  : JSON on stdin carrying `tool_name` and `tool_input`
 *   out : {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *          "permissionDecision":"deny","permissionDecisionReason":"..."}}
 *   Emitting nothing leaves the call to the normal permission flow, so this hook only ever
 *   *adds* denials. It can never widen what Claude may do.
 *
 * Two failure modes are known and neither is theoretical — both were produced while building it.
 * A hook that crashes, and a hook that exceeds its timeout, produce no frame, and no frame is
 * read as "no opinion": the call proceeds. So this file must stay syntactically valid and fast,
 * and `test/claude-harness-guard.test.ts` bounds both. Every match below is linear in the length
 * of the input; an independent review measured 60 seconds against a 10 second timeout on an
 * earlier version whose patterns backtracked.
 */
import { pathToFileURL } from 'node:url';

/**
 * Computer Use verbs that observe without actuating. This is an allowlist: an unknown verb is
 * refused, so a verb the server adds later is closed by default rather than open by default.
 * Everything not named here — every click, every key, the clipboard, the teach and batch
 * wrappers — is refused, because a screen coordinate carries no target and no honest guard can
 * tell a click on Run from any other click.
 *
 * `read_clipboard` is deliberately absent: the operator copies the bootstrap URL, and the
 * clipboard is the obvious way for that credential to reach Claude by accident.
 * `open_application`, `switch_display`, `scroll` and `mouse_move` do change focus, display or
 * scroll position — they are not observational in the strict sense. They are allowed because
 * none of them can press anything, which is what keeps ordinary window handling available.
 */
const COMPUTER_USE_ALLOWED = new Set([
  'screenshot', 'zoom', 'cursor_position', 'wait', 'mouse_move', 'scroll',
  'switch_display', 'open_application', 'request_access', 'request_teach_access',
  'list_granted_applications',
]);

/** Browser-automation servers whose calls are inspected for an authority target. */
const BROWSER_SERVERS = [
  'mcp__Claude_Browser__',
  'mcp__claude-in-chrome__',
  'mcp__plugin_playwright_playwright__',
  'mcp__plugin_chrome-devtools-mcp_chrome-devtools__',
  'mcp__plugin_browser-use_browser-use__',
];

/**
 * Read-only browser verbs, which may name an authority surface without being able to act on it.
 * Keeping these allowed is what stops the guard becoming an obstacle people route around.
 * Anything that selects a page or a tab is absent: making a document the active target is how a
 * later reference-based click acquires something to click.
 */
const BROWSER_READ_ONLY = new Set([
  'read_page', 'get_page_text', 'read_console_messages', 'read_network_requests',
  'browser_snapshot', 'browser_console_messages', 'browser_network_requests',
  'list_console_messages', 'list_network_requests', 'get_console_message',
  'get_network_request', 'take_snapshot', 'take_screenshot', 'browser_take_screenshot',
  'list_pages', 'tabs_context', 'tabs_context_mcp', 'browser_screenshot',
  'preview_list', 'preview_logs', 'find', 'browser_find',
]);

/** Tools that read a file or a URL, and so can carry a credential out of one. */
const READERS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'NotebookRead']);

/** Tools that write a file, and so could rewrite this guard. */
const WRITERS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

/**
 * The guard's own directory. Scope is deliberately narrow: `.claude/settings.json` and
 * `.claude/rules/` are declarative and are covered by deny rules in settings.json, while this
 * file is the executable one. A shell write here is a separate matter — Claude Code's own
 * auto-mode classifier refuses those as self-modification, which was observed while building
 * this, not designed here.
 */
const PROTECTED_DIR = '.claude/hooks/';

// --- Authority surfaces. Every regex below has a bounded quantifier or no quantifier at all. ---

/** The operator's single-use bootstrap credential, as an actual file name. Matching the bare
 *  word refused `rg operator-url src/`, which is reading, not reaching. */
const OPERATOR_URL_FILE = /[\w.-]+\.operator-url\b/i;
const OPERATOR_ROUTE = /\/(?:mutations|commits|verifications)\/[A-Za-z0-9_.:-]{1,64}\/(?:approve|reject)\b/i;
const OPERATOR_BOOTSTRAP = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\/bootstrap\b/i;
const OPERATOR_ORIGIN = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\b/i;
const WAG_STATE_FILE = 'browser-operator-v4.sqlite';
const SQL_WRITE = /\b(?:insert|update|delete|drop|attach)\b/i;

/** The Run surface: the side panel document, any extension document, and the message the Run
 *  button sends. */
const RUN_SURFACE = [
  [/panel\.execute/i, 'sends the side panel Run message'],
  [/sidepanel(?:\.html|\.js)?\b/i, 'targets the WAG side panel document'],
  [/chrome-extension:\/\//i, 'targets an extension document, where the Run control lives'],
];

/**
 * A shell cannot send the Run message or reach an extension document on its own; doing so means
 * driving a browser. Requiring a driver alongside the surface is what lets `grep panel.execute
 * browser/extension/service-worker.js` through — reading the gate you are reasoning about.
 * A leading word boundary cannot match in front of "--", so the flag-shaped drivers are a
 * separate branch.
 */
const BROWSER_DRIVER =
  /\b(?:playwright(?:-cli)?|puppeteer|browser-use|chrome-remote-interface|websocat|msedge|chrome\.exe|Runtime\.evaluate|Page\.navigate|devtools-protocol|microsoft-edge:)\b|--remote-debugging-port|--load-extension/i;

/** Something that actually performs an HTTP request, as opposed to a script that merely names a
 *  route while analysing one. */
const HTTP_CLIENT =
  /\b(?:curl|wget|httpie|fetch|axios|Invoke-WebRequest|Invoke-RestMethod|WebClient|HttpClient|urllib|requests\.(?:get|post)|http\.request|nc|telnet)\b/i;

/** Shell verbs that put a file's contents somewhere Claude can read them. A command that merely
 *  names the credential file while searching for it is doing neither, and is not refused. */
const FILE_READ_VERB =
  /\b(?:cat|type|more|less|head|tail|Get-Content|gc|Copy-Item|copy|cp|mv|Move-Item|xargs|base64|od|xxd|strings)\b|[<>|]/;

/**
 * Minting an authority that removes a human gesture, or naming one in local configuration.
 *
 * A Goal Lease lifts Approve (ADR-0028); a Goal UI Delegation lifts Run (ADR-0029). Both rules say
 * the same thing in the same words — issuance is human-only and out of band, Claude may *use* a
 * grant and must *report* on one but may never create, widen or renew one — and until this block
 * that was the only rule in `human-presence-boundary.md` with no pattern behind it anywhere.
 *
 * Two acts are refused, because there are two ways a shell reaches authority:
 *
 *   1. **running** issuance — the control CLI with an issuing flag, or a one-liner that calls the
 *      store or the control plane directly;
 *   2. **naming** a grant in local configuration — which is the quieter half and the one that
 *      actually matters. A delegation not named in config is inert whatever its row says, so
 *      writing the name is the act that turns a row into live authority.
 *
 * Deliberately **not** refused: `--show`, `--sessions`, `--workspaces`, every read of any of
 * these files, `--revoke`, and `npm run lease:stop`. Narrowing a grant and stopping automation
 * are things a person may need help with in a hurry, and a guard that refused them is a guard
 * people learn to turn off.
 */
const GRANT_CLI = /\bdelegation-control(?:\.[cm]?[jt]s)?\b/i;
const GRANT_CLI_FLAG = /--(?:issue|renew)\b/;
/** A *call*, not a mention: the open bracket is what separates invoking from describing. */
const GRANT_CALL =
  /\b(?:insertUiDelegation|renewUiDelegation|insertGoalLease)\s*\(|\bnew\s+UiDelegationControlPlane\s*\(/;
/**
 * The configuration fields that bind Claude to durable authority this process will honour: a Goal
 * Lease, a Goal UI Delegation, and the session correlation that selects which durable session a
 * lease's bindings are matched against. Naming any of them is the operator's edit, not Claude's.
 */
const GRANT_CONFIG_FIELD = /\b(?:goalUiDelegationId|goalLeaseId|sessionCorrelation)\b/;
/** Something that *runs* a script, as opposed to reading, grepping or quoting one. */
const SCRIPT_RUNNER = /\b(?:node|npx|npm|pnpm|yarn|bun|deno|tsx|ts-node)\b/i;

const BOUNDARY_RULE = 'See .claude/rules/human-presence-boundary.md.';

function serialize(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Whether a write is aimed at this guard itself.
 *
 * Only the target matters. An earlier version tested the whole serialised input, which refused
 * any edit whose *content* merely quoted the path — including the edits that repair this file,
 * and including ordinary documentation. Separators are normalised because a Windows path arrives
 * inside JSON with its backslashes doubled, so a single-separator form would never match one.
 */
function isProtectedTarget(input) {
  const target = input && typeof input === 'object'
    ? input.file_path ?? input.notebook_path
    : undefined;
  if (typeof target !== 'string') return false;
  return target.split('\\').join('/').includes(PROTECTED_DIR);
}

/** The operator's credential and decision surface. Linear: one `includes` and four anchored
 *  regexes, none of which can backtrack. */
function matchOperatorSurface(text) {
  if (OPERATOR_URL_FILE.test(text)) return 'names the operator single-use bootstrap file';
  if (OPERATOR_ROUTE.test(text)) return 'is a local operator approve/reject route';
  if (OPERATOR_BOOTSTRAP.test(text)) return 'is the operator single-use bootstrap URL';
  if (text.includes(WAG_STATE_FILE) && SQL_WRITE.test(text)) return 'writes WAG durable state directly';
  return undefined;
}

function matchRunSurface(text) {
  for (const [pattern, why] of RUN_SURFACE) if (pattern.test(text)) return why;
  return undefined;
}

/**
 * A shell command that mints or renews a grant.
 *
 * A runner is required for the same reason `BROWSER_DRIVER` is required beside the Run surface:
 * `grep -- --issue scripts/delegation-control.ts` is reading about issuance, not performing it,
 * and a guard that refused reading would be refusing the review of itself.
 */
function matchAuthorityIssuance(text) {
  if (!SCRIPT_RUNNER.test(text)) return undefined;
  if (GRANT_CLI.test(text) && GRANT_CLI_FLAG.test(text)) {
    return 'issues or renews a Goal UI Delegation';
  }
  if (GRANT_CALL.test(text)) return 'calls delegation or lease issuance directly';
  return undefined;
}

/**
 * A write that hands Claude an authority rather than describing one.
 *
 * Scoped to JSON, which is what a private gateway config is. It is deliberately **not** extended
 * to source files that merely contain these names: `durable-store.ts` defines the insert,
 * `goal-ui-delegation-dispatch.ts` discusses it in a comment, and refusing those would refuse
 * ordinary work and the analysis of this boundary alike — the same over-match that once refused a
 * commit message for quoting a filename. What a text rule can say precisely is "this JSON names a
 * grant", and that is the act that makes a row live.
 */
function matchAuthorityWrite(input) {
  const target = input && typeof input === 'object'
    ? input.file_path ?? input.notebook_path
    : undefined;
  if (typeof target !== 'string') return undefined;
  if (!/\.json$/i.test(target.split('\\').join('/'))) return undefined;
  return GRANT_CONFIG_FIELD.test(serialize(input))
    ? 'names a Goal Lease, a Goal UI Delegation, or a session correlation in a configuration file'
    : undefined;
}

export function decide(event) {
  const tool = typeof event?.tool_name === 'string' ? event.tool_name : '';
  if (!tool) {
    return {
      deny: true,
      reason: 'wag-human-gate-guard: the hook event carried no tool name, so this call cannot be shown to be safe.',
    };
  }
  const text = serialize(event?.tool_input);

  // Rewriting the guard is step three of the attack fixture in
  // test/fixtures/prompt-injection-page-capture.txt, and the hook is re-read on every call, so an
  // edit would take effect at once.
  if (WRITERS.has(tool) && isProtectedTarget(event?.tool_input)) {
    return {
      deny: true,
      reason: `wag-human-gate-guard: this writes the hook that decides what is refused. Changing it is the operator's call, made deliberately and reviewed. ${BOUNDARY_RULE}`,
    };
  }

  // Naming a grant in config is proposing to grant Claude authority, so it is the operator's
  // edit to make. Checked after the hook-directory rule because that one is the narrower target.
  if (WRITERS.has(tool)) {
    const why = matchAuthorityWrite(event?.tool_input);
    if (why) {
      return {
        deny: true,
        reason: `wag-human-gate-guard: this write ${why}. A delegation or lease that is not named in local configuration is inert, so writing the name is what turns a row into live authority — and issuance is human-only and out of band. ${BOUNDARY_RULE}`,
      };
    }
  }

  if (tool.startsWith('mcp__computer-use__')) {
    const verb = tool.slice('mcp__computer-use__'.length);
    if (COMPUTER_USE_ALLOWED.has(verb)) return { deny: false };
    return {
      deny: true,
      reason: `wag-human-gate-guard: Computer Use "${verb}" is refused in this project. A screen coordinate carries no target, so this hook cannot tell a click on WAG's Run button from any other click, and the project will not claim a guarantee it cannot enforce. Only the observational verbs are allowed, and an unrecognised verb is refused rather than assumed harmless. ${BOUNDARY_RULE}`,
    };
  }

  const server = BROWSER_SERVERS.find((prefix) => tool.startsWith(prefix));
  if (server) {
    if (BROWSER_READ_ONLY.has(tool.slice(server.length))) return { deny: false };
    // A browser tool has no reason to name either surface except to reach it.
    const why = matchRunSurface(text) ?? matchOperatorSurface(text);
    if (!why) return { deny: false };
    return {
      deny: true,
      reason: `wag-human-gate-guard: this browser call ${why}. Run in the side panel and approve/reject on the operator are human gestures (ADR-0026: RUN_AND_APPROVAL = HUMAN). Read WAG's durable state instead of driving its authority surfaces. ${BOUNDARY_RULE}`,
    };
  }

  // Reading a file or a URL cannot press a button, but it can carry the operator's single-use
  // credential out of the 0600 file it lives in — and spending that credential takes the
  // operator's own approval session away from them.
  if (READERS.has(tool)) {
    if (OPERATOR_URL_FILE.test(text)) {
      return {
        deny: true,
        reason: `wag-human-gate-guard: this reads the operator single-use bootstrap file. It is the operator's credential, it is spent on first use, and taking it locks them out of their own approval session. ${BOUNDARY_RULE}`,
      };
    }
    if (tool === 'WebFetch'
      && (OPERATOR_BOOTSTRAP.test(text) || OPERATOR_ROUTE.test(text) || OPERATOR_ORIGIN.test(text))) {
      return {
        deny: true,
        reason: `wag-human-gate-guard: this fetches the local operator review server, which is the human's channel and not an API for Claude. ${BOUNDARY_RULE}`,
      };
    }
    return { deny: false };
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const issuing = matchAuthorityIssuance(text);
    if (issuing) {
      return {
        deny: true,
        reason: `wag-human-gate-guard: this command ${issuing}. Claude may use a Goal Lease or a Goal UI Delegation and must report on one; it may not create, widen or renew one. Revocation and \`npm run lease:stop\` are not refused. ${BOUNDARY_RULE}`,
      };
    }
    // Naming a route or a credential is not reaching for one: an analysis script may quote both,
    // and refusing that refused the security review's own scripts. Requiring something that
    // actually performs a request, reads a file, or drives a browser is what separates the two.
    // A shell remains an accepted same-user escape hatch either way, so this is a tripwire.
    if (OPERATOR_URL_FILE.test(text) && FILE_READ_VERB.test(text)) {
      return {
        deny: true,
        reason: `wag-human-gate-guard: this command reads the operator single-use bootstrap file, which is spent on first use. A command that only names it is not refused. ${BOUNDARY_RULE}`,
      };
    }
    if (HTTP_CLIENT.test(text)) {
      const why = matchOperatorSurface(text);
      if (why) {
        return {
          deny: true,
          reason: `wag-human-gate-guard: this command requests something that ${why}. The local operator review server is the human's channel. ${BOUNDARY_RULE}`,
        };
      }
    }
    if (text.includes(WAG_STATE_FILE) && SQL_WRITE.test(text)) {
      return {
        deny: true,
        reason: `wag-human-gate-guard: this command writes WAG durable state directly, going around the review that decides it. ${BOUNDARY_RULE}`,
      };
    }
    if (BROWSER_DRIVER.test(text)) {
      const why = matchRunSurface(text);
      if (why) {
        return {
          deny: true,
          reason: `wag-human-gate-guard: this command drives a browser at something that ${why}. Run is a human gesture. ${BOUNDARY_RULE}`,
        };
      }
    }
    return { deny: false };
  }

  return { deny: false };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let verdict;
  try {
    verdict = decide(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    // Fail closed on an event that cannot be read or decided. The failure is loud and is repaired
    // by editing this file, which is preferable to silently opening the gate.
    verdict = {
      deny: true,
      reason: 'wag-human-gate-guard: the hook event could not be read or decided, so this call cannot be shown to be safe.',
    };
  }
  if (verdict.deny) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: verdict.reason,
      },
    }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
