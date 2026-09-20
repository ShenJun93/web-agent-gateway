/**
 * Open the operator review page for a running WAG runtime.
 *
 * `npm run operator:open`
 *
 * Exists so a runtime restart does not mean running a PowerShell line by hand. It prints the
 * origin — which the runtime already logs — and never the bootstrap URL or its token. See
 * `src/operator-launch.ts` for why it goes through a loopback redirect instead of handing the URL
 * to the browser on a command line.
 *
 * This opens a page. It does not approve anything: approval is a human gesture on the page that
 * opens, and nothing here touches it.
 */
import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { createBootstrapRedirect, operatorOrigin, readBootstrapUrl } from '../src/operator-launch.js';

const DEFAULT_STORE = 'browser-operator-v4.sqlite';

function stateFile(env: NodeJS.ProcessEnv, store: string): string {
  if (isAbsolute(store)) return `${store}.operator-url`;
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData || !isAbsolute(localAppData)) {
    throw new Error('LOCALAPPDATA is not set, so the WAG state directory cannot be located');
  }
  return join(localAppData, 'WebAgentGateway', `${store}.operator-url`);
}

/**
 * Hands the URL to the platform's default browser.
 *
 * The URL here is the loopback redirect, never the bootstrap — so although this *is* a command
 * line, there is no secret on it.
 */
function openInBrowser(url: string): void {
  const [command, args] = process.platform === 'win32'
    // `start` is a cmd builtin; the empty string is the window title, which `start` otherwise
    // takes from the first quoted argument and then fails to open anything.
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.unref();
}

async function main(): Promise<number> {
  const store = process.argv[2] ?? DEFAULT_STORE;
  const file = stateFile(process.env, store);
  const bootstrapUrl = await readBootstrapUrl(file);

  const redirect = await createBootstrapRedirect({ bootstrapUrl });
  // Reduced to the origin *before* any output, so that no logging statement in this file so much
  // as names the bootstrap URL. A test pins that, which makes the rule mechanical rather than a
  // thing a later edit has to remember.
  const origin = operatorOrigin(bootstrapUrl);
  console.log(`operator origin : ${origin}`);
  console.log(`handoff         : ${redirect.url}  (single-use, carries no secret)`);
  openInBrowser(redirect.url);

  const outcome = await redirect.settled;
  await redirect.close();

  if (outcome === 'handed-off') {
    console.log('opened          : the review page should now be in your browser');
    return 0;
  }
  console.error('not opened      : the browser did not collect the handoff before it expired');
  console.error('                  the bootstrap is unspent; run this again');
  return 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    // `readBootstrapUrl` is careful never to include file contents in its messages.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
