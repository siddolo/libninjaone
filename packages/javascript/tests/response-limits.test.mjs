import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NinjaOneClient, NinjaOneError, ResponseTooLargeError } from '../dist/index.js';

function client(fetch, options = {}) {
  return new NinjaOneClient({ baseUrl: 'https://app.ninjarmm.com', accessToken: 'test', fetch, ...options });
}

test('HTTP is restricted to local origins for both authentication modes', () => {
  for (const auth of [{ accessToken: 'test' }, { oauth: { clientId: 'id', clientSecret: 'secret' } }]) {
    for (const host of ['example.com', '192.168.1.1', 'localhost.example.com', '127.0.0.2']) {
      assert.throws(() => new NinjaOneClient({ baseUrl: `http://${host}`, ...auth }), /HTTPS/);
    }
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      assert.doesNotThrow(() => new NinjaOneClient({ baseUrl: `http://${host}:8080`, ...auth }));
    }
    assert.doesNotThrow(() => new NinjaOneClient({ baseUrl: 'https://example.com', ...auth }));
  }
});

test('response limits are configurable and count UTF-8 bytes', async () => {
  for (const contentType of ['application/json', 'text/plain', 'application/octet-stream']) {
    const fetch = async () => new Response('"é"', { headers: { 'Content-Type': contentType } });
    const small = client(fetch, { maxResponseBytes: 3 });
    await assert.rejects(small.request('GET', '/v2/devices'), error =>
      error instanceof ResponseTooLargeError && error.limit === 3 && error.status === 200);
    const larger = client(fetch, { maxResponseBytes: 4 });
    const result = await larger.request('GET', '/v2/devices');
    if (contentType === 'application/json') assert.equal(result, 'é');
    else if (contentType === 'text/plain') assert.equal(result, '"é"');
    else assert.equal(result.byteLength, 4);
  }
});

test('oversized Content-Length cancels the body without reading it', async () => {
  let read = false;
  let cancelled = false;
  const sdk = client(async () => new Response(new ReadableStream({
    pull() { read = true; },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { 'Content-Length': '100' } }), { maxResponseBytes: 10 });
  await assert.rejects(sdk.request('GET', '/v2/devices'), ResponseTooLargeError);
  assert.equal(read, false);
  assert.equal(cancelled, true);
});

test('stream limit applies without Content-Length and with understated or compressed sizes', async () => {
  for (const headers of [{}, { 'Content-Length': '1' }, { 'Content-Length': '1', 'Content-Encoding': 'gzip' }]) {
    let reads = 0;
    let cancelled = false;
    const sdk = client(async () => new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(3)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers }), { maxResponseBytes: 5 });
    await assert.rejects(sdk.request('GET', '/v2/devices'), ResponseTooLargeError);
    assert.equal(reads, 2);
    assert.equal(cancelled, true);
  }
});

test('raw success responses bypass buffering limits but errors retain their separate limit', async () => {
  const fetch = async () => new Response('large-body');
  const sdk = client(fetch, { maxResponseBytes: 1 });
  const raw = await sdk.requestRaw('GET', '/v2/devices');
  assert.equal(await raw.text(), 'large-body');
  for (const method of ['request', 'requestRaw']) {
    const small = client(async () => new Response('denied', { status: 403 }), {
      maxResponseBytes: 1000, maxErrorResponseBytes: 5,
    });
    await assert.rejects(small[method]('GET', '/v2/devices'), error =>
      error instanceof ResponseTooLargeError && error.limit === 5 && error.status === 403);
    const larger = client(async () => new Response('denied', { status: 403 }), { maxErrorResponseBytes: 6 });
    await assert.rejects(larger[method]('GET', '/v2/devices'), error =>
      error instanceof NinjaOneError && error.body === 'denied');
  }
});

test('OAuth token and error bodies also obey configured limits', async () => {
  for (const status of [200, 401]) {
    let apiCalls = 0;
    const sdk = new NinjaOneClient({
      baseUrl: 'https://app.ninjarmm.com', oauth: { clientId: 'id', clientSecret: 'secret' },
      maxResponseBytes: 10, maxErrorResponseBytes: 5,
      fetch: async request => {
        if (!request.url.endsWith('/ws/oauth/token')) apiCalls++;
        return new Response('{"access_token":"long-token"}', { status });
      },
    });
    await assert.rejects(sdk.requestRaw('GET', '/v2/devices'), error =>
      error instanceof ResponseTooLargeError && error.limit === (status === 200 ? 10 : 5));
    assert.equal(apiCalls, 0);
  }
});

test('bounded buffering preserves bytes across growth and trims unused capacity', async () => {
  for (const size of [0, 1, 4096, 4097, 9000]) {
    const expected = Uint8Array.from({ length: size }, (_, i) => i % 251);
    let offset = 0;
    const sdk = client(async () => new Response(new ReadableStream({
      pull(controller) {
        if (offset === size) { controller.close(); return; }
        /* One-byte views also check that backing-buffer bytes are not copied. */
        controller.enqueue(expected.subarray(offset, ++offset));
      },
    })), { maxResponseBytes: Math.max(1, size) });
    const result = await sdk.request('GET', '/v2/devices');
    assert.equal(result.byteLength, size);
    assert.deepEqual(new Uint8Array(result), expected);
  }
});

test('byte limits reject invalid values', () => {
  for (const option of ['maxResponseBytes', 'maxErrorResponseBytes']) {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => client(fetch, { [option]: value }), new RegExp(option));
    }
  }
});
