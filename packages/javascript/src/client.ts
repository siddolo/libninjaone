import type { Method, ApiPath, ApiResponse, RequestArguments } from './types.js';
import {
  tokenProvider,
  type AccessToken,
  type OAuthCredentials,
  type Authentication,
  type TokenProvider,
} from './auth.js';
import { responseError } from './errors.js';
import { readResponse } from './response.js';

export type NinjaOneOptions = {
  /* Instance origin, for example https://eu.ninjarmm.com (without /v2). */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  /* Total timeout for one API request including authentication and retries. Default: 30000. */
  timeoutMs?: number;
  /* Extra attempts for GET/HEAD on 429, 502, 503 and 504. Default: 2. */
  maxRetries?: number;
  /* Maximum time to wait between attempts. Default: 30000. */
  maxRetryDelayMs?: number;
  /* Decoded body limit for request() and OAuth responses. Default: 10 MiB. */
  maxResponseBytes?: number;
  /* Body limit for API and OAuth errors, including requestRaw(). Default: 64 KiB. */
  maxErrorResponseBytes?: number;
} & (
  | { accessToken: AccessToken; oauth?: never }
  | { oauth: OAuthCredentials; accessToken?: never }
);

interface Configuration {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  maxRetries: number;
  maxRetryDelayMs: number;
  maxResponseBytes: number;
  maxErrorResponseBytes: number;
}

/* Node timers overflow above this value and fall back to a one-ms delay. */
const MAX_TIMER_MS = 2_147_483_647;

function configuration(options: NinjaOneOptions): Configuration {
  const url = new URL(options.baseUrl);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'baseUrl must be an HTTP(S) origin without credentials, a path, query, or fragment',
    );
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('baseUrl must use HTTPS except for localhost, 127.0.0.1, or [::1]');
  }
  const config: Configuration = {
    baseUrl: url.origin,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    timeoutMs: options.timeoutMs ?? 30_000,
    maxRetries: options.maxRetries ?? 2,
    maxRetryDelayMs: options.maxRetryDelayMs ?? 30_000,
    maxResponseBytes: options.maxResponseBytes ?? 10 * 1024 * 1024,
    maxErrorResponseBytes: options.maxErrorResponseBytes ?? 64 * 1024,
  };
  for (const [name, minimum, maximum] of [
    ['timeoutMs', 1, MAX_TIMER_MS],
    ['maxRetries', 0, Number.MAX_SAFE_INTEGER],
    ['maxRetryDelayMs', 0, MAX_TIMER_MS],
    ['maxResponseBytes', 1, Number.MAX_SAFE_INTEGER],
    ['maxErrorResponseBytes', 1, Number.MAX_SAFE_INTEGER],
  ] as const) {
    const value = config[name];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
  }
  return config;
}

function authentication(options: NinjaOneOptions): Authentication {
  if (options.accessToken !== undefined && options.oauth === undefined) {
    return { accessToken: options.accessToken };
  }
  if (options.oauth !== undefined && options.accessToken === undefined) {
    return { oauth: options.oauth };
  }
  throw new Error('Provide exactly one of accessToken or oauth');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/* Typed access to every operation in the bundled OpenAPI specification. */
export class NinjaOneClient {
  private readonly config: Configuration;
  private readonly tokens: TokenProvider;

  constructor(options: NinjaOneOptions) {
    this.config = configuration(options);
    this.tokens = tokenProvider({ ...this.config, auth: authentication(options) });
  }

  private async transport(request: Request): Promise<Response> {
    const {
      baseUrl,
      timeoutMs,
      maxRetries,
      maxRetryDelayMs: maxDelay,
      maxErrorResponseBytes,
    } = this.config;

    if (new URL(request.url).origin !== baseUrl) {
      throw new Error('Requests must use the configured instance origin');
    }

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    signal.throwIfAborted();
    const token = await withSignal(this.tokens.get(), signal);

    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${token.value}`);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    const template = new Request(request, { headers, signal, redirect: 'error' });
    const retryableMethod = ['GET', 'HEAD'].includes(template.method);

    for (let attempt = 0; ; attempt++) {
      const response = await this.config.fetch(retryableMethod ? template.clone() : template);
      if (response.status === 401) this.tokens.invalidate(token);
      if (response.ok) return response;
      if (
        retryableMethod &&
        attempt < maxRetries &&
        [429, 502, 503, 504].includes(response.status)
      ) {
        const retryAfter = response.headers.get('Retry-After');
        let delay = Math.min(500 * 2 ** attempt, maxDelay);
        if (retryAfter !== null) {
          const seconds = Number(retryAfter);
          const requested = Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retryAfter) - Date.now();

          if (Number.isFinite(requested)) {
            /* Never retry earlier than the server permits. */
            if (requested > maxDelay) {
              throw await responseError(response, maxErrorResponseBytes);
            }
            delay = Math.max(0, requested);
          }
        }
        await response.body?.cancel();
        await sleep(delay, signal);
        continue;
      }
      throw await responseError(response, maxErrorResponseBytes);
    }
  }

  /* Serialize path/query parameters and return the successful response body.
   * JSON stays typed; text and binary responses can use requestRaw instead. */
  async request<M extends Method, P extends ApiPath<M>>(
    method: M,
    path: P,
    ...args: RequestArguments<M, P>
  ): Promise<ApiResponse<M, P>> {
    const response = await this.send(method, path, args[0]);
    if (response.status === 204 || response.status === 205 || method === 'HEAD') {
      return undefined as ApiResponse<M, P>;
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    const bytes = await readResponse(response, this.config.maxResponseBytes);
    if (contentType.includes('json')) {
      const text = new TextDecoder().decode(bytes);
      return (text ? JSON.parse(text) : undefined) as ApiResponse<M, P>;
    }
    if (contentType.startsWith('text/')) {
      return new TextDecoder().decode(bytes) as ApiResponse<M, P>;
    }
    return bytes as ApiResponse<M, P>;
  }

  /* Keep the native response available for downloads, headers, and streaming. */
  async requestRaw<M extends Method, P extends ApiPath<M>>(
    method: M,
    path: P,
    ...args: RequestArguments<M, P>
  ): Promise<Response> {
    return this.send(method, path, args[0]);
  }

  private async send(method: Method, path: string, input: unknown): Promise<Response> {
    const options = (input ?? {}) as {
      path?: Record<string, unknown>;
      query?: Record<string, unknown>;
      body?: unknown;
      headers?: HeadersInit;
      signal?: AbortSignal;
    };

    const resolved = path.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const value = options.path?.[name];
      if (value === undefined || value === null) {
        throw new Error(`Missing path parameter: ${name}`);
      }
      const text = String(value);
      if (text === '.' || text === '..') {
        throw new Error('Path parameters must not be dot segments');
      }
      return encodeURIComponent(text);
    });
    const url = new URL(`${this.config.baseUrl}${resolved}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, String(item));
      }
    }

    const headers = new Headers(options.headers);
    let body: BodyInit | undefined;
    if (
      options.body instanceof FormData ||
      options.body instanceof Blob ||
      options.body instanceof URLSearchParams ||
      options.body instanceof ArrayBuffer
    ) {
      body = options.body;
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }
    return this.transport(new Request(url, {
      method,
      headers,
      body,
      signal: options.signal,
    }));
  }
}
