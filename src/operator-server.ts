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
}): Promise<OperatorServer> {
  if (!options.coordinator && !options.verifyCoordinator && !options.commitCoordinator) {
    throw new Error('Operator server requires a review coordinator');
  }
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('Operator server must bind loopback');
  let bootstrapToken: string | undefined = secret();
  const sessions = new Map<string, { csrf: string }>();
  let origin = '';

  const server = createServer(async (req, res) => {
    setSecurityHeaders(res);
    try {
      const url = new URL(req.url ?? '/', origin || `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/bootstrap') {
        const supplied = url.searchParams.get('token');
        if (!bootstrapToken || !supplied || !sameSecret(supplied, bootstrapToken)) return deny(res, 403);
        bootstrapToken = undefined;
        const sessionId = secret();
        sessions.set(sessionId, { csrf: secret() });
        res.setHeader('set-cookie', `wag_operator_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict`);
        res.writeHead(303, { location: '/' }).end();
        return;
      }

      const session = getSession(req, sessions);
      if (!session) return deny(res, 401);

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
        if (!review) return deny(res, 404);
        return html(res, renderMutationReview(review, session.csrf));
      }

      const verifyDetail = /^\/verifications\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && verifyDetail && options.verifyCoordinator) {
        const review = options.verifyCoordinator.reviewLocal(decodeURIComponent(verifyDetail[1]!));
        if (!review) return deny(res, 404);
        return html(res, renderVerifyReview(review, session.csrf));
      }

      const mutationAction = /^\/mutations\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
      if (req.method === 'POST' && mutationAction && options.coordinator) {
        if (!(await validPost(req, session.csrf, origin))) return deny(res, 403);
        const mutationId = decodeURIComponent(mutationAction[1]!);
        const ok = mutationAction[2] === 'approve'
          ? await options.coordinator.approveLocal(mutationId)
          : options.coordinator.rejectLocal(mutationId);
        if (!ok) return deny(res, 409);
        res.writeHead(303, { location: '/' }).end();
        return;
      }

      const commitDetail = /^\/commits\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && commitDetail && options.commitCoordinator) {
        const review = options.commitCoordinator.reviewLocal(decodeURIComponent(commitDetail[1]!));
        if (!review) return deny(res, 404);
        return html(res, renderCommitReview(review, session.csrf));
      }

      const commitAction = /^\/commits\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
      if (req.method === 'POST' && commitAction && options.commitCoordinator) {
        if (!(await validPost(req, session.csrf, origin))) return deny(res, 403);
        const commitId = decodeURIComponent(commitAction[1]!);
        const ok = commitAction[2] === 'approve'
          ? await options.commitCoordinator.approveLocal(commitId)
          : options.commitCoordinator.rejectLocal(commitId);
        if (!ok) return deny(res, 409);
        res.writeHead(303, { location: '/' }).end();
        return;
      }

      const verifyAction = /^\/verifications\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
      if (req.method === 'POST' && verifyAction && options.verifyCoordinator) {
        if (!(await validPost(req, session.csrf, origin))) return deny(res, 403);
        const requestId = decodeURIComponent(verifyAction[1]!);
        const ok = verifyAction[2] === 'approve'
          ? await options.verifyCoordinator.approveLocal(requestId)
          : options.verifyCoordinator.rejectLocal(requestId);
        if (!ok) return deny(res, 409);
        res.writeHead(303, { location: '/' }).end();
        return;
      }

      deny(res, 404);
    } catch {
      if (!res.headersSent) deny(res, 500);
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

async function validPost(req: IncomingMessage, csrf: string, origin: string): Promise<boolean> {
  if (req.headers.origin !== origin) return false;
  const form = await readForm(req);
  const supplied = form.get('csrf');
  return Boolean(supplied && sameSecret(supplied, csrf));
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
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
}

function deny(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end('Denied');
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
    + `<p>Fingerprint: ${escapeHtml(review.fingerprint)}</p>`
    + `<p>Review expires: ${review.reviewDeadline}</p>`
    + `<h3>Selected paths</h3><ul>${paths}</ul>`
    // The selected path set is what was asked for; the change set is what the commit actually
    // does. They differ whenever git resolves a directory/file conflict, so the operator is
    // shown the resulting delta rather than only the request.
    + `<h3>Resulting changes</h3><ul>${review.changes
      .map((change) => `<li>${escapeHtml(change.status)} ${escapeHtml(change.path)}</li>`)
      .join('')}</ul>`
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
