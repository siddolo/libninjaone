import { readResponse } from './response.js';

/* An unsuccessful API or OAuth response. The message never includes credentials. */
export class NinjaOneError extends Error {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;

  constructor(response: Response, body: unknown) {
    super(`NinjaOne request failed with HTTP ${response.status}`);
    this.name = 'NinjaOneError';
    this.status = response.status;
    this.headers = new Headers(response.headers);
    this.body = body;
  }
}

export async function responseError(response: Response, limit: number): Promise<NinjaOneError> {
  const text = new TextDecoder().decode(await readResponse(response, limit));
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* Keep non-JSON error bodies. */
  }
  return new NinjaOneError(response, body);
}
