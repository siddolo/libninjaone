import { responseError } from './errors.js';
import { readResponse } from './response.js';

export type AccessToken = string | (() => string | Promise<string>);

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  /* Defaults to monitoring. Add management/control scopes when required. */
  scopes?: readonly string[];
}

interface Token {
  value: string;
}

export interface TokenProvider {
  get(): Promise<Token>;
  invalidate(token: Token): void;
}

/* OAuth Basic authentication form-encodes each component before Base64. */
function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice('value='.length);
}

export type Authentication = { accessToken: AccessToken } | { oauth: OAuthCredentials };

export function tokenProvider(options: {
  baseUrl: string;
  auth: Authentication;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  maxResponseBytes: number;
  maxErrorResponseBytes: number;
}): TokenProvider {
  const {
    baseUrl,
    auth,
    fetch: fetcher,
    timeoutMs,
    maxResponseBytes,
    maxErrorResponseBytes,
  } = options;

  if ('accessToken' in auth) {
    const source = auth.accessToken;
    return {
      async get() {
        const value = typeof source === 'function' ? await source() : source;
        if (typeof value !== 'string' || !value.trim()) {
          throw new Error('The access token must be a non-empty string');
        }
        return { value };
      },
      invalidate() {
        /* External token lifecycle belongs to the caller. */
      },
    };
  }

  const { clientId, clientSecret, scopes = ['monitoring'] } = auth.oauth;
  if (
    typeof clientId !== 'string' || !clientId ||
    typeof clientSecret !== 'string' || !clientSecret
  ) {
    throw new Error('OAuth clientId and clientSecret must be non-empty strings');
  }
  const authorization = `Basic ${btoa(`${formEncode(clientId)}:${formEncode(clientSecret)}`)}`;
  let cached: { token: Token; expiresAt: number } | undefined;
  let pending: Promise<Token> | undefined;

  async function acquire(): Promise<Token> {
    const startedAt = Date.now();
    const response = await fetcher(new Request(`${baseUrl}/ws/oauth/token`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', Authorization: authorization },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: scopes.join(' '),
      }),
    }));
    if (!response.ok) throw await responseError(response, maxErrorResponseBytes);

    const result: unknown = JSON.parse(
      new TextDecoder().decode(await readResponse(response, maxResponseBytes)),
    );
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('OAuth response must be a JSON object');
    }
    const data = result as Record<string, unknown>;
    if (typeof data.access_token !== 'string' || !data.access_token.trim()) {
      throw new Error('OAuth response is missing access_token');
    }
    if (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer') {
      throw new Error('OAuth response token_type must be Bearer');
    }
    if ('scope' in data && typeof data.scope !== 'string') {
      throw new Error('OAuth response scope must be a string');
    }

    let lifetime = 0;
    if ('expires_in' in data) {
      if (
        typeof data.expires_in !== 'number' ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in < 0
      ) {
        throw new Error('OAuth response expires_in must be a finite non-negative number');
      }
      lifetime = data.expires_in * 1000;
      if (!Number.isFinite(lifetime) || startedAt + lifetime > Number.MAX_SAFE_INTEGER) {
        throw new Error('OAuth response expires_in exceeds the supported timestamp range');
      }
    }
    cached = {
      token: { value: data.access_token },
      expiresAt: startedAt + Math.max(0, lifetime - Math.min(30_000, lifetime * 0.1)),
    };
    return cached.token;
  }

  return {
    async get() {
      if (cached && Date.now() < cached.expiresAt) return cached.token;
      if (!pending) {
        pending = acquire().finally(() => {
          pending = undefined;
        });
      }
      return pending;
    },
    invalidate(token) {
      /* A late 401 must not discard a token acquired by another request. */
      if (cached?.token === token) cached = undefined;
    },
  };
}
