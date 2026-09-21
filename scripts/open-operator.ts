/**
 * Prepare the operator review page for a running WAG runtime.
 *
 * `npm run operator:open`
 *
 * Exists so a runtime restart does not mean running a PowerShell line by hand. It prints a
 * handoff link — loopback, single-use, carrying no secret — which a human opens. It prints the
 * origin, which the runtime already logs. It never prints the bootstrap URL or its token.
 *
 * ## Why it does not open the browser itself
 *
 * It used to. A security review pointed out what that composes into: opening the review page is
 * the step that previously required the operator to act, so automating it means an *authenticated
 * operator session can come into existence with no human present*. Put that beside two residuals
 * this branch already records — a reference-based click is invisible to the guard, and a shell is
 * a same-user escape hatch — and the chain "open the page, then click Approve by reference" has
 * no human gesture anywhere in it.
 *
 * So the last step is deliberately left to a person. Running this is safe for anyone, including
 * an agent: on its own it produces a link and nothing else. Only a human opening that link
 * creates a session. That keeps the human-presence boundary where ADR-0026 puts it while still
 * removing the thing the operator actually complained about, which was the PowerShell.
 *
 * It approves nothing, and it has no HTTP client in it with which it could.
 */
import { isAbsolute, join } from 'node:path';
import { createBootstrapRedirect, operatorOrigin, readBootstrapUrl } from '../src/operator-launch.js';

const DEFAULT_STORE = 'browser-operator-v4.sqlite';
/** Long enough to walk to the browser, short enough that a forgotten handoff is not left armed. */
const DEFAULT_HANDOFF_MINUTES = 5;
/**
 * The ceiling on `--wait`.
 *
 * Five minutes matches walking to the browser, and turned out not to match the real workflow: an
 * operator who steps away for an hour comes back to an expired handoff, and the default was
 * observed failing that way. So it is adjustable — but bounded, because an armed handoff is a
 * live loopback route to a credential, and one left waiting overnight is a worse trade than
 * running this again.
 */
const MAX_HANDOFF_MINUTES = 120;

function handoffMinutes(args: readonly string[]): number {
  const index = args.indexOf('--wait');
  if (index === -1) return DEFAULT_HANDOFF_MINUTES;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('--wait takes a positive number of minutes');
  }
  if (value > MAX_HANDOFF_MINUTES) {
    throw new Error(`--wait is capped at ${MAX_HANDOFF_MINUTES} minutes; an armed handoff is a live route to a credential`);
  }
  return value;
}

function stateFile(env: NodeJS.ProcessEnv, store: string): string {
  if (isAbsolute(store)) return `${store}.operator-url`;
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData || !isAbsolute(localAppData)) {
    throw new Error('LOCALAPPDATA is not set, so the WAG state directory cannot be located');
  }
  return join(localAppData, 'WebAgentGateway', `${store}.operator-url`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const minutes = handoffMinutes(args);
  const store = args.find((a) => !a.startsWith('--') && Number.isNaN(Number(a))) ?? DEFAULT_STORE;
  const file = stateFile(process.env, store);
  const bootstrapUrl = await readBootstrapUrl(file);

  const redirect = await createBootstrapRedirect({ bootstrapUrl, ttlMs: minutes * 60_000 });
  // Reduced to the origin *before* any output, so that no logging statement in this file so much
  // as names the bootstrap URL. A test pins that, which makes the rule mechanical rather than a
  // thing a later edit has to remember.
  const origin = operatorOrigin(bootstrapUrl);

  console.log(`operator origin : ${origin}`);
  console.log(`open this       : ${redirect.url}`);
  console.log('');
  console.log('That link is single-use and carries no secret. Opening it in your browser');
  console.log('collects the bootstrap and signs you in to the review page.');
  console.log(`Waiting up to ${minutes} minutes...  (npm run operator:open -- --wait 60)`);

  const outcome = await redirect.settled;
  await redirect.close();

  if (outcome === 'handed-off') {
    // Deliberately not "signed in": all that is known here is that the redirect was collected.
    // Whether the bootstrap was still unspent is something only the browser can report.
    console.log('collected       : the review page should now be open in your browser');
    console.log('                  if it shows Denied, the bootstrap was already spent —');
    console.log('                  restart the runtime to mint a fresh one');
    return 0;
  }
  console.error('not collected   : nobody opened the handoff before it expired');
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
