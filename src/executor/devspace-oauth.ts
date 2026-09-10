import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DevspaceTokenSource } from './devspace.js';

export interface DevspaceOAuthOptions {
  baseUrl: string;
  resourceUrl: string;
  ownerToken: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export interface DevspaceOAuthSession extends DevspaceTokenSource {
  refreshAfterUnauthorized(): Promise<string>;
  close(): void;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export async function createDevspaceOAuthSession(options: DevspaceOAuthOptions): Promise<DevspaceOAuthSession> {
  const session = new OAuthSession(options);
  try {
    await session.bootstrap();
    return session;
  } catch (error) {
    session.close();
    throw error;
  }
}
class OAuthSession implements DevspaceOAuthSession {
  private readonly baseUrl: string;
  private readonly resourceUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private ownerToken: string;
  private clientId?: string;
  private accessToken?: string;
  private refreshToken?: string;
  private refreshAtMs = 0;
  private refreshPromise?: Promise<string>;
  private closed = false;

  constructor(options: DevspaceOAuthOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.resourceUrl = options.resourceUrl;
    this.ownerToken = options.ownerToken;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    this.assertOpen();
    if (this.accessToken && this.now() < this.refreshAtMs) return this.accessToken;
    return this.refreshSingleFlight(false);
  }

  async refreshAfterUnauthorized(): Promise<string> {
    this.assertOpen();
    return this.refreshSingleFlight(true);
  }

  close(): void {
    this.closed = true;
    this.ownerToken = '';
    this.clientId = undefined;
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.refreshAtMs = 0;
    this.refreshPromise = undefined;
  }

  async bootstrap(): Promise<string> {
    this.assertOpen();
    const redirectUri = 'http://127.0.0.1/callback';
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomUUID();

    const registration = await this.fetchFn(`${this.baseUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Web Agent Gateway',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    if (registration.status !== 201) throw new Error(`DevSpace OAuth register failed: HTTP ${registration.status}`);
    const registered = await registration.json() as { client_id?: string };
    if (!registered.client_id) throw new Error('DevSpace OAuth register returned no client_id');
    this.clientId = registered.client_id;

    const approval = await this.fetchFn(`${this.baseUrl}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        client_id: this.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'devspace',
        resource: this.resourceUrl,
        state,
        owner_token: this.ownerToken,
      }),
    });
    const location = approval.headers.get('location');
    if (approval.status !== 302 || !location) throw new Error(`DevSpace OAuth authorize failed: HTTP ${approval.status}`);
    const redirect = new URL(location);
    if (redirect.searchParams.get('state') !== state) throw new Error('DevSpace OAuth authorize returned invalid state');
    const code = redirect.searchParams.get('code');
    if (!code) throw new Error('DevSpace OAuth authorize returned no code');

    const exchange = await this.fetchFn(`${this.baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: this.resourceUrl,
      }),
    });
    if (!exchange.ok) throw new Error(`DevSpace OAuth exchange failed: HTTP ${exchange.status}`);
    const tokens = this.parseTokens(await exchange.json());
    this.acceptTokens(tokens);
    return tokens.access_token;
  }

  private async refreshSingleFlight(force: boolean): Promise<string> {
    if (!force && this.accessToken && this.now() < this.refreshAtMs) return this.accessToken;
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshOrBootstrap().finally(() => { this.refreshPromise = undefined; });
    }
    return this.refreshPromise;
  }
  private async refreshOrBootstrap(): Promise<string> {
    if (!this.clientId || !this.refreshToken) return this.bootstrap();
    try {
      return await this.refresh();
    } catch {
      this.clientId = undefined;
      this.accessToken = undefined;
      this.refreshToken = undefined;
      this.refreshAtMs = 0;
      return this.bootstrap();
    }
  }

  private async refresh(): Promise<string> {
    if (!this.clientId || !this.refreshToken) throw new Error('DevSpace OAuth refresh state unavailable');
    const response = await this.fetchFn(`${this.baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        refresh_token: this.refreshToken,
        scope: 'devspace',
        resource: this.resourceUrl,
      }),
    });
    if (!response.ok) throw new Error(`DevSpace OAuth refresh failed: HTTP ${response.status}`);
    const tokens = this.parseTokens(await response.json());
    this.acceptTokens(tokens);
    return tokens.access_token;
  }
  private parseTokens(value: unknown): OAuthTokenResponse {
    if (!value || typeof value !== 'object') throw new Error('DevSpace OAuth token response was invalid');
    const token = value as Partial<OAuthTokenResponse>;
    if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('DevSpace OAuth token response had no access token');
    if (typeof token.refresh_token !== 'string' || !token.refresh_token) throw new Error('DevSpace OAuth token response had no refresh token');
    if (typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
      throw new Error('DevSpace OAuth token response had invalid expiry');
    }
    return token as OAuthTokenResponse;
  }

  private acceptTokens(tokens: OAuthTokenResponse): void {
    const lifetimeMs = tokens.expires_in * 1_000;
    const refreshLeadMs = lifetimeMs < 60_000 ? lifetimeMs / 2 : 30_000;
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    this.refreshAtMs = this.now() + lifetimeMs - refreshLeadMs;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('DevSpace OAuth session is closed');
  }
}
