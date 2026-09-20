#!/usr/bin/env node
/**
 * PreToolUse guard for WAG's human-authority controls.
 *
 * WAG's two human gestures are Run in the browser side panel and approve/reject on the local
 * operator review server (ADR-0019, ADR-0026: RUN_AND_APPROVAL = HUMAN). This hook is the
 * deterministic half of keeping Claude automation away from both. It is not the security
 * boundary — WAG's own authority checks are — but it removes the easy paths, and it is the
 * strongest enforcement the installed Claude Code (2.1.278) can actually express.
 *
 * Contract, verified against the installed build:
 *   in  : JSON on stdin carrying `tool_name` and `tool_input`
 *   out : {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *          "permissionDecision":"deny","permissionDecisionReason":"..."}}
 *   Emitting nothing leaves the call to the normal permission flow, so this hook only ever
 *   *adds* denials. It can never widen what Claude may do.
 *
 * What it deliberately does not do: decide whether a screen coordinate is over the Run button.
 * A coordinate carries no target, so that question cannot be answered here. Rather than pretend
 * otherwise, the actuating Computer Use verbs are refused outright and the observational ones
 * are left alone.
 */
import { pathToFileURL } from 'node:url';

/**
 * Computer Use verbs that move the mouse buttons or the keyboard. Coordinates are opaque, so
 * there is no safe subset — a click is refused whatever it is aimed at. The observational verbs
 * (screenshot, zoom, cursor_position, wait, scroll, mouse_move, open_application, request_access,
 * list_granted_applications, read_clipboard, switch_display) are untouched, which is what keeps
 * ordinary window handling and visual inspection available.
 */
const COMPUTER_USE_ACTUATING = new Set([
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_click_drag', 'left_mouse_down', 'left_mouse_up',
  'type', 'key', 'hold_key', 'write_clipboard',
  'teach_step', 'teach_batch', 'computer_batch',
]);

/**
 * Browser-automation servers whose calls are inspected for an authority target. Every browser
 * tool from these servers is inspected, not only the clicking ones: reaching the side panel is
 * the precondition for clicking it, so navigation and tab selection are covered too.
 */
const BROWSER_SERVERS = [
  'mcp__Claude_Browser__',
  'mcp__claude-in-chrome__',
  'mcp__plugin_playwright_playwright__',
  'mcp__plugin_chrome-devtools-mcp_chrome-devtools__',
  'mcp__plugin_browser-use_browser-use__',
];

/**
 * Read-only browser verbs, which may name an authority surface without being able to act on it.
 * Keeping these allowed is what the mission means by "must not block ordinary inspection".
 */
const BROWSER_READ_ONLY = new Set([
  'read_page', 'get_page_text', 'read_console_messages', 'read_network_requests',
  'browser_snapshot', 'browser_console_messages', 'browser_network_requests',
  'list_console_messages', 'list_network_requests', 'get_console_message',
  'get_network_request', 'take_snapshot', 'take_screenshot', 'browser_take_screenshot',
  'list_pages', 'tabs_context', 'tabs_context_mcp', 'browser_screenshot',
  'preview_list', 'preview_logs', 'find', 'browser_find',
]);

/**
 * Strings that identify a WAG human-authority surface.
 *
 * - `panel.execute` is the message the Run button sends; nothing else may send it.
 * - the side panel document, and any chrome-extension:// document, are the Run surface.
 * - the approve/reject routes are the effect gate itself.
 * - the operator-url file is where the single-use bootstrap credential is written, 0600.
 *   Spending that credential does not merely bypass a gate; it takes the operator's approval
 *   session away from them.
 */
const AUTHORITY_PATTERNS = [
  [/panel\.execute/i, 'sends the side panel Run message'],
  [/sidepanel(\.html|\.js)?\b/i, 'targets the WAG side panel document'],
  [/chrome-extension:\/\//i, 'targets an extension document, where the Run control lives'],
  [/\/(mutations|commits|verifications)\/[^/\s"'`]+\/(approve|reject)/i,
    'is a local operator approve/reject route'],
  [/operator-url/i, 'reads the operator single-use bootstrap file'],
  [/browser-operator-v4\.sqlite[^\n]*\b(insert|update|delete|drop|attach)\b/i,
    'writes WAG durable state directly'],
  [/\b(insert|update|delete|drop)\b[^\n]*browser-operator-v4\.sqlite/i,
    'writes WAG durable state directly'],
];

/**
 * The operator bootstrap route, matched only where it is actually being fetched. A bare
 * "/bootstrap" appears in prose and in this repository's own documents, so a loopback origin is
 * required in front of it; that keeps the guard off ordinary reading and writing.
 */
const OPERATOR_BOOTSTRAP_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/bootstrap/i;
const OPERATOR_BOOTSTRAP_REASON = 'fetches the operator single-use bootstrap URL';

function serialize(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function matchAuthority(text) {
  for (const [pattern, why] of AUTHORITY_PATTERNS) if (pattern.test(text)) return why;
  if (OPERATOR_BOOTSTRAP_PATTERN.test(text)) return OPERATOR_BOOTSTRAP_REASON;
  return undefined;
}

const BOUNDARY_RULE = 'See .claude/rules/human-presence-boundary.md.';

/**
 * @param {{tool_name?: unknown, tool_input?: unknown}} event
 * @returns {{deny: false} | {deny: true, reason: string}}
 */
export function decide(event) {
  const tool = typeof event?.tool_name === 'string' ? event.tool_name : '';
  if (!tool) {
    return {
      deny: true,
      reason: 'wag-human-gate-guard: the hook event carried no tool name, so this call cannot be shown to be safe.',
    };
  }
  const text = serialize(event?.tool_input);

  if (tool.startsWith('mcp__computer-use__')) {
    const verb = tool.slice('mcp__computer-use__'.length);
    if (!COMPUTER_USE_ACTUATING.has(verb)) return { deny: false };
    return {
      deny: true,
      reason: `wag-human-gate-guard: Computer Use "${verb}" is refused in this project. A screen coordinate carries no target, so this hook cannot tell a click on WAG's Run button from any other click, and the project will not claim a guarantee it cannot enforce. Screenshot the screen to see it, and ask the operator to perform the gesture. ${BOUNDARY_RULE}`,
    };
  }

  const server = BROWSER_SERVERS.find((prefix) => tool.startsWith(prefix));
  if (server) {
    if (BROWSER_READ_ONLY.has(tool.slice(server.length))) return { deny: false };
    const why = matchAuthority(text);
    if (!why) return { deny: false };
    return {
      deny: true,
      reason: `wag-human-gate-guard: this browser call ${why}. Run in the side panel and approve/reject on the operator are human gestures (ADR-0026: RUN_AND_APPROVAL = HUMAN). Read WAG's durable state instead of driving its authority surfaces. ${BOUNDARY_RULE}`,
    };
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const why = matchAuthority(text);
    if (!why) return { deny: false };
    return {
      deny: true,
      reason: `wag-human-gate-guard: this command ${why}. A shell is a same-user escape hatch, so this check is a tripwire rather than a sandbox — ADR-0019 already puts a compromised same-user account outside the containment claim — but the gesture belongs to the operator, so the obvious forms are refused. ${BOUNDARY_RULE}`,
    };
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
    // Fail closed on an unparseable event: the guard cannot show the call is safe. The failure is
    // loud and is repaired by editing this file, which is preferable to silently opening the gate.
    verdict = {
      deny: true,
      reason: 'wag-human-gate-guard: the hook event did not parse, so this call cannot be shown to be safe.',
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
