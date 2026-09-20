import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BrowserVerifyLocalReviewView } from './browser-verify-request.js';
import type { MutationLocalReviewView } from './durable-mutation.js';
import type { GitCommitLocalReviewView } from './git-commit.js';

interface OperatorMutationCoordinator {
  listPendingLocal(limit?: number): MutationLocalReviewView[];
  reviewLocal(mutationId: string): MutationLocalReviewView | undefined;
  approveLocal(mutationId: string): Promise<boolean>;
  rejectLocal(mutationId: string): boolean;
}

interface OperatorCommitCoordinator {
  listPendingLocal(limit?: number): GitCommitLocalReviewView[];
  reviewLocal(commitId: string): GitCommitLocalReviewView | undefined;
  approveLocal(commitId: string): Promise<boolean>;
  rejectLocal(commitId: string): boolean;
}

interface OperatorVerifyCoordinator {
  listPendingLocal(limit?: number): BrowserVerifyLocalReviewView[];
  reviewLocal(requestId: string): BrowserVerifyLocalReviewView | undefined;
  approveLocal(requestId: string): Promise<boolean>;
  rejectLocal(requestId: string): boolean;
}

export interface OperatorServer {
  origin: string;
  bootstrapUrl: string;
  close(): Promise<void>;
}

export async function startOperatorServer(options: {
  coordinator?: OperatorMutationCoordinator;
  verifyCoordinator?: OperatorVerifyCoordinator;
  commitCoordinator?: OperatorCommitCoordinator;
  host?: string;
  port?: number;
  /**
   * Called on every refusal, on this machine only. The review server answers the operator in a
   * browser, so it cannot explain itself in the body without also explaining itself to whatever
   * else reaches loopback; this is how the local process gets to say which check failed.
   */
  onDeny?: (event: { status: number; code: OperatorDenialCode; path: string }) => void;
}): Promise<OperatorServer> {
  if (!options.coordinator && !options.verifyCoordinator && !options.commitCoordinator) {
    throw new Error('Operator server requires a review coordinator');
  }
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('Operator server must bind loopback');
  let bootstrapToken: string | undefined = secret();
  const sessions = new Map<string, { csrf: string }>();
  let origin = '';

  const refuse = (res: ServerResponse, status: number, code: OperatorDenialCode, path: string): void => {
    options.onDeny?.({ status, code, path });
    deny(res, status, code);
  };

  const server = createServer(async (req, res) => {
    setSecurityHeaders(res);
    try {
      const url = new URL(req.url ?? '/', origin || `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/bootstrap') {
        const supplied = url.searchParams.get('token');
        if (!bootstrapToken || !supplied || !sameSecret(supplied, bootstrapToken)) return refuse(res, 403, 'BOOTSTRAP_INVALID', url.pathname);
        bootstrapToken = undefined;
        const sessionId = secret();
        sessions.set(sessionId, { csrf: secret() });
        res.setHeader('set-cookie', `wag_operator_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict`);
        res.writeHead(303, { location: '/' }).end();
        return;
      }

      const session = getSession(req, sessions);
      if (!session) return refuse(res, 401, 'UNAUTHENTICATED', url.pathname);

      if (req.method === 'GET' && url.pathname === '/') {
        return html(res, renderList(
          options.coordinator?.listPendingLocal(20) ?? [],
          options.verifyCoordinator?.listPendingLocal(20) ?? [],
          options.commitCoordinator?.listPendingLocal(20) ?? [],
          session.csrf,
        ));
      }

      const mutationDetail = /^\/mutations\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && mutationDetail && options.coordinator) {
        const review = options.coordinator.reviewLocal(decodeURIComponent(mutationDetail[1]!));
        if (!review) return refuse(res, 404, 'NOT_FOUND', url.pathname);
        return html(res, renderMutationReview(review, session.csrf));
      }

      const verifyDetail = /^\/verifications\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && verifyDetail && options.verifyCoordinator) {
        const review = options.verifyCoordinator.reviewLocal(decodeURIComponent(verifyDetail[1]!));
        if (!review) return refuse(res, 404, 'NOT_FOUND', url.pathname);
        return html(res, renderVerifyReview(review, session.csrf));
      }

      const mutationAction = /^\/mutations\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
      if (req.method === 'POST' && mutationAction && options.coordinator) {
        const failure = await postFailure(req, session.csrf, origin);
        if (failure) return refuse(res, 403, failure, url.pathname);
        const mutationId = decodeURIComponent(mutationAction[1]!);
        const ok = mutationAction[2] === 'approve'
          ? await options.coordinator.approveLocal(mutationId)
          : options.coordinator.rejectLocal(mutationId);
        if (!ok) return refuse(res, 409, 'NOT_ACTIONABLE', url.pathname);
        res.writeHead(303, { location: '/' }).end();
        return;
      }

      const commitDetail = /^\/commits\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && commitDetail && options.commitCoordinator) {
        const review = options.commitCoordinator.reviewLocal(decodeURIComponent(commitDetail[1]!));
        if (!review) return refuse(res, 404, 'NOT_FOUND', url.pathname);
        return html(res, renderCommitReview(review, session.csrf));
      }

      const commitAction = /^\/commits\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
      if (req.method === 'POST' && commitAction && options.commitCoordinator) {
        const failure = await postFailure(req, session.csrf, origin);
        if (failure) return refuse(res, 403, failure, url.pathname);
        const commitId = decodeURIComponent(commitAction[1]!);
        const ok = commitAction[2] === 'approve'
          ? await options.commitCoordinator.approveLocal(commitId)
          : options.commitCoordinator.rejectLocal(commitId);
        if (!ok) return refuse(res, 409, 'NOT_ACTIONABLE', url.pathname);
        res.writeHead(303, { location: '/' }).end();
        return;
      }

      const verifyAction = /^\/verifications\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
      if (req.method === 'POST' && verifyAction && options.verifyCoordinator) {
        const failure = await postFailure(req, session.csrf, origin);
        if (failure) return refuse(res, 403, failure, url.pathname);
        const requestId = decodeURIComponent(verifyAction[1]!);
        const ok = verifyAction[2] === 'approve'
          ? await options.verifyCoordinator.approveLocal(requestId)
          : options.verifyCoordinator.rejectLocal(requestId);
        if (!ok) return refuse(res, 409, 'NOT_ACTIONABLE', url.pathname);
        res.writeHead(303, { location: '/' }).end();
        return;
      }

      refuse(res, 404, 'NO_ROUTE', url.pathname);
    } catch {
      if (!res.headersSent) refuse(res, 500, 'INTERNAL', '');
      else res.end();
    }
  });

  const port = await listen(server, host, options.port ?? 0);
  origin = `http://${host === '::1' ? '[::1]' : host}:${port}`;
  const token = bootstrapToken!;
  return {
    origin,
    bootstrapUrl: `${origin}/bootstrap?token=${encodeURIComponent(token)}`,
    async close() {
      sessions.clear();
      await closeServer(server);
    },
  };
}

/**
 * Returns the reason a decision POST is unacceptable, or undefined when it is fine.
 *
 * Origin is still compared exactly, and the CSRF token is still compared in constant time; the
 * only change from returning a bare boolean is that the caller can now say *which* check failed.
 * `Sec-Fetch-Site` is read as corroboration and never as a substitute: a browser that omits it
 * is not penalised, and a request that claims `same-origin` while carrying the wrong Origin is
 * still refused.
 */
async function postFailure(
  req: IncomingMessage, csrf: string, origin: string,
): Promise<'ORIGIN_MISMATCH' | 'CSRF_INVALID' | undefined> {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return 'ORIGIN_MISMATCH';
  if (req.headers.origin !== origin) return 'ORIGIN_MISMATCH';
  const form = await readForm(req);
  const supplied = form.get('csrf');
  return supplied && sameSecret(supplied, csrf) ? undefined : 'CSRF_INVALID';
}

function getSession(req: IncomingMessage, sessions: Map<string, { csrf: string }>) {
  const cookie = req.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const [name, value] = part.trim().split('=', 2);
    if (name === 'wag_operator_session' && value) return sessions.get(value);
  }
  return undefined;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(body, 'utf8') > 8 * 1024) throw new Error('Operator form too large');
  }
  return new URLSearchParams(body);
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('content-security-policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('x-frame-options', 'DENY');
  // `same-origin`, not `no-referrer`.
  //
  // Per Fetch, a request whose mode is not "cors" and whose method is not GET or HEAD serialises
  // its Origin as the string "null" when the referrer policy is `no-referrer`. A form submission
  // is a navigation, so the Approve button sent `Origin: null` and the CSRF Origin check refused
  // it before ever reading the form — measured in Edge, and the reason a live approval failed
  // while every test passed, because `fetch()` is mode "cors" and is exempt from that rule.
  //
  // `same-origin` still withholds the referrer entirely on cross-origin requests, which is what
  // the original header was protecting, while preserving a real Origin on our own form POST.
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
}

/**
 * Why a request was refused.
 *
 * The body used to be `Denied` for every case, and the server logs no requests, so an operator
 * who was refused could not tell an expired record from a failed CSRF check — during a live
 * dogfood the cause had to be inferred from durable state instead. The codes below are reported
 * to the local process through `onDeny`, and echoed in the body only once the caller has already
 * proved it holds a session. Unauthenticated callers still learn nothing.
 */
export type OperatorDenialCode =
  | 'BOOTSTRAP_INVALID'
  | 'UNAUTHENTICATED'
  | 'ORIGIN_MISMATCH'
  | 'CSRF_INVALID'
  | 'NOT_ACTIONABLE'
  | 'NOT_FOUND'
  | 'NO_ROUTE'
  | 'INTERNAL';

/** Codes that must not be echoed to the caller, because the caller is not yet trusted. */
const OPAQUE_DENIALS: ReadonlySet<OperatorDenialCode> = new Set(['BOOTSTRAP_INVALID', 'UNAUTHENTICATED']);

function deny(res: ServerResponse, status: number, code: OperatorDenialCode): void {
  const body = OPAQUE_DENIALS.has(code) ? 'Denied' : `Denied: ${code}`;
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(body);
}
function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
}

function renderList(
  mutations: MutationLocalReviewView[],
  verifications: BrowserVerifyLocalReviewView[],
  commits: GitCommitLocalReviewView[],
  csrf: string,
): string {
  const mutationItems = mutations.map((review) => renderMutationReview(review, csrf)).join('');
  const verifyItems = verifications.map((review) => renderVerifyReview(review, csrf)).join('');
  const commitItems = commits.map((review) => renderCommitReview(review, csrf)).join('');
  return '<!doctype html><meta charset="utf-8"><title>WAG Review</title><h1>Pending reviews</h1>'
    + '<h2>Mutations</h2>' + (mutationItems || '<p>None</p>')
    + '<h2>Verifications</h2>' + (verifyItems || '<p>None</p>')
    + '<h2>Commits</h2>' + (commitItems || '<p>None</p>');
}

function renderMutationReview(review: MutationLocalReviewView, csrf: string): string {
  const id = escapeHtml(review.mutationId);
  const actionId = encodeURIComponent(review.mutationId);
  return `<article><h2>${escapeHtml(review.path)}</h2>`
    + `<p>Repository: ${escapeHtml(review.workspaceRoot)}</p>`
    + `<p>State: ${escapeHtml(review.state)}</p>`
    + `<p>Mutation: ${id}</p>`
    + `<p>Base SHA-256: ${escapeHtml(review.baseSha256)}</p>`
    + `<p>Result SHA-256: ${escapeHtml(review.resultSha256)}</p>`
    + `<p>Fingerprint: ${escapeHtml(review.fingerprint)}</p>`
    + `<p>Additions: ${review.additions}; removals: ${review.removals}</p>`
    + `<h3>Before</h3><pre>${escapeHtml(review.before)}</pre>`
    + `<h3>After</h3><pre>${escapeHtml(review.after)}</pre>`
    + actionForm('mutations', actionId, 'approve', csrf)
    + actionForm('mutations', actionId, 'reject', csrf)
    + '</article>';
}

function renderVerifyReview(review: BrowserVerifyLocalReviewView, csrf: string): string {
  const actionId = encodeURIComponent(review.requestId);
  return '<article>'
    + `<h2>Verify ${escapeHtml(review.profileName)}</h2>`
    + `<p>Workspace: ${escapeHtml(review.workspaceRoot)}</p>`
    + `<p>State: ${escapeHtml(review.state)}</p>`
    + `<p>Request: ${escapeHtml(review.requestId)}</p>`
    + `<p>Plan SHA-256: ${escapeHtml(review.planSha256)}</p>`
    + `<p>Fingerprint: ${escapeHtml(review.fingerprint)}</p>`
    + `<p>Created: ${review.createdAt}; review expires: ${review.reviewDeadline}</p>`
    + '<p>Approval executes this configured named verification profile.</p>'
    + actionForm('verifications', actionId, 'approve', csrf)
    + actionForm('verifications', actionId, 'reject', csrf)
    + '</article>';
}

function renderCommitReview(review: GitCommitLocalReviewView, csrf: string): string {
  const actionId = encodeURIComponent(review.commitId);
  const paths = review.paths.map((path) => '<li>' + escapeHtml(path) + '</li>').join('');
  return '<article>'
    + `<h2>Commit on ${escapeHtml(review.branch)}</h2>`
    + `<p>Repository: ${escapeHtml(review.workspaceRoot)}</p>`
    + `<p>State: ${escapeHtml(review.state)}</p>`
    + `<p>Commit request: ${escapeHtml(review.commitId)}</p>`
    + `<p>Parent HEAD: ${escapeHtml(review.oldHead)}</p>`
    + `<p>Resulting tree: ${escapeHtml(review.treeSha)}</p>`
    // The author comes from the repository's own configuration, which is untrusted, so the
    // operator is told who the commit will be attributed to rather than left to assume.
    + `<p>Author: ${escapeHtml(review.author)}</p>`
    + (review.committer === review.author ? ''
      : `<p>Committer: ${escapeHtml(review.committer)}</p>`)
    + `<p>Fingerprint: ${escapeHtml(review.fingerprint)}</p>`
    + `<p>Review expires: ${review.reviewDeadline}</p>`
    + `<h3>Selected paths</h3><ul>${paths}</ul>`
    // The selected path set is what was asked for; the change set is what the commit actually
    // does. They differ whenever git resolves a directory/file conflict, so the operator is
    // shown the resulting delta rather than only the request.
    + `<h3>Resulting changes</h3><ul>${review.changes
      .map((change) => `<li>${escapeHtml(change.status)} ${escapeHtml(change.path)}</li>`)
      .join('')}</ul>`
    + (review.eolNormalized.length === 0 ? ''
      : `<p>End-of-line normalized, as this repository asks: ${review.eolNormalized.map(escapeHtml).join(', ')}</p>`)
    + `<h3>Message</h3><pre>${escapeHtml(review.message)}</pre>`
    + '<p>Approval creates one commit and moves the branch only if HEAD and content are unchanged.</p>'
    + actionForm('commits', actionId, 'approve', csrf)
    + actionForm('commits', actionId, 'reject', csrf)
    + '</article>';
}

function actionForm(kind: 'mutations' | 'verifications' | 'commits', id: string, action: 'approve' | 'reject', csrf: string): string {
  return `<form method="post" action="/${kind}/${id}/${action}">`
    + `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`
    + `<button type="submit">${action === 'approve' ? 'Approve' : 'Reject'}</button></form>`;
}

/**
 * Bidi overrides, isolates and zero-width characters. A repository controls its own filenames and
 * a caller controls the commit message, so both reach this page; rendered verbatim they let text
 * display in an order other than the one that will be committed. Escaping them as visible code
 * points keeps the review page an honest statement of what is being approved.
 */
const INVISIBLE_OR_BIDI = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

function escapeHtml(value: string): string {
  return value
    .replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]!)
    .replace(INVISIBLE_OR_BIDI, (char) => `&lt;U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}&gt;`);
}

function secret(): string {
  return randomBytes(32).toString('base64url');
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function listen(server: Server, host: string, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => server.listen(port, host, resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Operator server has no TCP address');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
