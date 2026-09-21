/**
 * Opening the operator review page without handing the bootstrap token to whoever asked.
 *
 * WAG mints a single-use bootstrap URL and writes it beside the durable store. Opening it is an
 * ordinary, safe act — it is navigation, not approval — but until now it meant the operator ran a
 * PowerShell line by hand after every runtime restart, because the obvious automation hands the
 * token to the automating agent.
 *
 * ## Why this is not just `start <url>`
 *
 * On Windows a URL passed to a browser is a command-line argument, and a command line is readable
 * by any process on the same account — `Get-CimInstance Win32_Process` prints it. Launching the
 * browser with the bootstrap URL would therefore publish the token to the process table for as
 * long as the browser ran, which is precisely the exposure this helper exists to avoid. Writing it
 * to a temporary `.url` shortcut has the same problem in a different place: a readable file.
 *
 * So the token is never passed anywhere. Instead this serves one loopback redirect on a random
 * port, and a *human* opens that — a URL with no secret in it. The first navigation gets a 303 to
 * the real bootstrap URL, and the redirect disarms. The token exists only in this process's
 * memory and in one HTTP response to the browser.
 *
 * `scripts/open-operator.ts` explains why the browser is not opened automatically: doing that
 * would let an authenticated operator session come into existence with nobody present, which is
 * the boundary ADR-0026 is about.
 *
 * ## What this does not defend against, stated plainly
 *
 * A same-user process that reaches the redirect before the human does gets the token. The
 * `Sec-Fetch` check below is a speed bump and nothing more: it makes an incurious `curl` miss,
 * and a raw HTTP client sets those headers trivially. ADR-0019 already places a same-user
 * adversary outside the containment claim, and this does not move that line.
 *
 * What it does buy is real: in ordinary operation the token never reaches argv, a log, a file, or
 * this tool's output. And because the bootstrap is single-use, a theft is *loud* — the operator's
 * own browser then fails to authenticate, rather than the theft passing unnoticed.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';

/** How long the redirect waits for the browser before giving up and closing. */
const DEFAULT_TTL_MS = 60_000;

export interface BootstrapRedirect {
  /** The address to open. Contains no secret, and is safe to print. */
  readonly url: string;
  /** Resolves 'handed-off' once the browser has been redirected, or 'timeout'. */
  readonly settled: Promise<'handed-off' | 'timeout' | 'closed'>;
  close(): Promise<void>;
}

/**
 * Serves exactly one redirect to `bootstrapUrl`, then stops.
 *
 * Single-use by construction: the first accepted navigation disarms it, so a second request — a
 * reload, a prefetch, a racing process — gets 410 rather than the token a second time.
 */
export async function createBootstrapRedirect(options: {
  bootstrapUrl: string;
  ttlMs?: number;
  /** Bound loopback-only. Present for tests; there is no reason to change it. */
  host?: string;
}): Promise<BootstrapRedirect> {
  const target = new URL(options.bootstrapUrl);
  if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost' && target.hostname !== '::1') {
    throw new Error('Operator launch refuses a bootstrap URL that is not loopback');
  }
  const host = options.host ?? '127.0.0.1';
  // Validated rather than merely documented. An earlier version said "loopback-only" in a comment
  // and checked nothing, which would have published the token-bearing redirect to every interface
  // for the life of the TTL. `operator-server.ts` refuses the same way, and so does this.
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('Operator launch must bind loopback');
  }
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  let armed = true;
  let settle: (outcome: 'handed-off' | 'timeout' | 'closed') => void;
  const settled = new Promise<'handed-off' | 'timeout' | 'closed'>((resolve) => { settle = resolve; });

  const server: Server = createServer((req, res) => {
    // Never cache a redirect that carries a credential, and never leak the target as a referrer.
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');

    if (!armed) {
      res.writeHead(410, { 'content-type': 'text/plain' }).end('Operator handoff already used\n');
      return;
    }
    if (!looksLikeNavigation(req)) {
      // A speed bump, not a control — see the header comment. It is a 400 rather than a redirect
      // so that a non-browser caller does not get the token by accident.
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Operator handoff expects a browser navigation\n');
      return;
    }
    armed = false;
    // `target.href`, not the raw text that was validated. Validating one string and emitting
    // another is how an emitter and its check drift apart: WHATWG URL strips TAB/CR/LF before
    // parsing, so a file containing an embedded newline would pass the loopback check above and
    // then reach Node's header validation as a raw value — which throws inside this handler.
    res.writeHead(303, { location: target.href, 'content-type': 'text/plain' }).end('Opening the operator review page\n');
    settle('handed-off');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });

  const timer = setTimeout(() => { armed = false; settle('timeout'); }, ttlMs);
  timer.unref?.();

  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}/`,
    settled,
    async close() {
      clearTimeout(timer);
      armed = false;
      settle('closed');
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Whether this request looks like a top-level browser navigation.
 *
 * Chromium and Firefox both send `Sec-Fetch-Mode: navigate` with `Sec-Fetch-Dest: document` for
 * an address-bar navigation. Absent headers fail closed.
 */
function looksLikeNavigation(req: IncomingMessage): boolean {
  const mode = req.headers['sec-fetch-mode'];
  const dest = req.headers['sec-fetch-dest'];
  return mode === 'navigate' && dest === 'document';
}

/**
 * Reads the bootstrap URL WAG wrote beside its store.
 *
 * The caller gets the URL; nothing here logs it. The error paths deliberately name the *file* and
 * never its contents, because an error message is output and output is the thing being protected.
 */
export async function readBootstrapUrl(operatorUrlFile: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(operatorUrlFile, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new Error(`No operator bootstrap at ${operatorUrlFile} — is the WAG runtime running?`);
    }
    throw new Error(`Could not read the operator bootstrap at ${operatorUrlFile} (${code ?? 'unknown error'})`);
  }
  const url = raw.trim();
  if (!url) throw new Error(`The operator bootstrap at ${operatorUrlFile} is empty`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Deliberately does not echo the contents.
    throw new Error(`The operator bootstrap at ${operatorUrlFile} is not a URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`The operator bootstrap at ${operatorUrlFile} is not an http(s) URL`);
  }
  return url;
}

/** The origin alone, which the runtime already prints and which carries no secret. */
export function operatorOrigin(bootstrapUrl: string): string {
  return new URL(bootstrapUrl).origin;
}
