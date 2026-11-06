import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { NinjaOneClient, NinjaOneError, paginate } from '../dist/index.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});
const client = (fetch, options = {}) => new NinjaOneClient({
  baseUrl: 'https://eu.ninjarmm.com', accessToken: 'test-token', fetch, ...options,
});

test('native HTTP transport encodes parameters and sends bearer authentication', async t => {
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    assert.equal(req.url, '/v2/contact/a%2Fb?filter=a%26b&enabled=false&ids=1&ids=2');
    res.setHeader('Content-Type', 'application/json');
    res.end('{"id":12}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const sdk = new NinjaOneClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 'test-token' });
  assert.deepEqual(await sdk.request('GET', '/v2/contact/{id}', {
    path: { id: 'a/b' }, query: { filter: 'a&b', enabled: false, ids: [1, 2], omitted: undefined },
  }), { id: 12 });
});

test('JSON writes, empty responses, and multipart boundaries', async () => {
  const sdk = client(async request => {
    assert.equal(request.method, 'POST');
    if (request.headers.get('Content-Type').includes('multipart/form-data')) {
      assert.equal((await request.formData()).get('file').name, 'test.txt');
    } else {
      assert.equal(request.headers.get('Content-Type'), 'application/json');
      assert.deepEqual(await request.json(), { email: 'test@example.com' });
    }
    return new Response(null, { status: 204 });
  });
  assert.equal(await sdk.request('POST', '/v2/contacts', { body: { email: 'test@example.com' } }), undefined);
  const form = new FormData();
  form.append('file', new Blob(['sample']), 'test.txt');
  await sdk.request('POST', '/v2/contacts', { body: form });
});

test('exposes binary data and raw response headers', async () => {
  const sdk = client(async () => new Response(new Uint8Array([0, 255]), {
    headers: { 'Content-Type': 'application/octet-stream', 'X-Request-Id': 'request-1' },
  }));
  assert.deepEqual(new Uint8Array(await sdk.request('GET', '/v2/devices')), new Uint8Array([0, 255]));
  assert.equal((await sdk.requestRaw('GET', '/v2/devices')).headers.get('X-Request-Id'), 'request-1');
});

test('OAuth token requests are form encoded and shared across concurrent API calls', async () => {
  let tokenRequests = 0;
  let apiRequests = 0;
  const sdk = new NinjaOneClient({
    baseUrl: 'https://eu.ninjarmm.com',
    oauth: { clientId: 'client+id', clientSecret: 's&cret', scopes: ['monitoring', 'management'] },
    fetch: async request => {
      if (request.url.endsWith('/ws/oauth/token')) {
        tokenRequests++;
        assert.equal(request.redirect, 'error');
        const form = new URLSearchParams(await request.text());
        assert.equal(form.has('client_id'), false);
        assert.equal(form.has('client_secret'), false);
        assert.equal(request.headers.get('Authorization'), `Basic ${btoa('client%2Bid:s%26cret')}`);
        assert.equal(form.get('scope'), 'monitoring management');
        assert.equal(form.get('grant_type'), 'client_credentials');
        return json({ access_token: 'oauth-token', token_type: 'Bearer', expires_in: 3600 });
      }
      apiRequests++;
      assert.equal(request.headers.get('Authorization'), 'Bearer oauth-token');
      return json([]);
    },
  });
  await Promise.all([sdk.request('GET', '/v2/devices'), sdk.request('GET', '/v2/devices')]);
  await sdk.request('GET', '/v2/devices');
  assert.equal(tokenRequests, 1);
  assert.equal(apiRequests, 3);
});

test('expired tokens are reacquired and failed acquisitions can be retried', async () => {
  let calls = 0;
  const sdk = new NinjaOneClient({
    baseUrl: 'https://app.ninjarmm.com', oauth: { clientId: 'id', clientSecret: 'secret' },
    fetch: async request => {
      if (!request.url.endsWith('/ws/oauth/token')) return json([]);
      calls++;
      if (calls === 1) return json({ error: 'invalid_client' }, 401);
      return json({ access_token: 'short-lived', token_type: 'Bearer', expires_in: 0 });
    },
  });
  await assert.rejects(sdk.request('GET', '/v2/devices'), error => error instanceof NinjaOneError && error.status === 401);
  await sdk.request('GET', '/v2/devices');
  await sdk.request('GET', '/v2/devices');
  assert.equal(calls, 3);
});

test('OAuth rejects malformed responses before making an API call', async () => {
  const valid = { access_token: 'test', token_type: 'Bearer', expires_in: 3600 };
  for (const payload of [null, [], 'text', { ...valid, token_type: 'DPoP' },
    { access_token: 'test' }, { ...valid, access_token: ' ' },
    { ...valid, expires_in: -1 }, { ...valid, expires_in: '3600' },
    { ...valid, expires_in: 1e308 }, { ...valid, scope: [] }]) {
    let apiCalls = 0;
    const sdk = new NinjaOneClient({
      baseUrl: 'https://app.ninjarmm.com', oauth: { clientId: 'id', clientSecret: 'secret' },
      fetch: async request => {
        if (request.url.endsWith('/ws/oauth/token')) return json(payload);
        apiCalls++;
        return json([]);
      },
    });
    await assert.rejects(sdk.request('GET', '/v2/devices'), /OAuth response/);
    assert.equal(apiCalls, 0);
  }
});

test('OAuth Basic handles Unicode and delimiters; missing expiry disables reuse', async () => {
  let tokens = 0;
  const sdk = new NinjaOneClient({
    baseUrl: 'https://app.ninjarmm.com', oauth: { clientId: 'é: +', clientSecret: '密&=' },
    fetch: async request => {
      if (!request.url.endsWith('/ws/oauth/token')) return json([]);
      tokens++;
      assert.equal(atob(request.headers.get('Authorization').slice(6)), '%C3%A9%3A+%2B:%E5%AF%86%26%3D');
      return json({ access_token: 'test', token_type: 'bEaReR' });
    },
  });
  await sdk.request('GET', '/v2/devices');
  await sdk.request('GET', '/v2/devices');
  assert.equal(tokens, 2);
});

test('a 401 invalidates the OAuth cache without replaying writes or discarding newer tokens', async () => {
  let tokens = 0;
  let apiCalls = 0;
  let releaseLate;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const late = new Promise(resolve => { releaseLate = resolve; });
  const sdk = new NinjaOneClient({
    baseUrl: 'https://app.ninjarmm.com', oauth: { clientId: 'id', clientSecret: 'secret' },
    fetch: async request => {
      if (request.url.endsWith('/ws/oauth/token')) {
        tokens++;
        /* Return the same value to verify cache identity, not string comparison. */
        return json({ access_token: 'test', token_type: 'Bearer', expires_in: 3600 });
      }
      apiCalls++;
      if (apiCalls === 1) { markStarted(); await late; return json({}, 401); }
      return json([], apiCalls === 2 ? 401 : 200);
    },
  });
  const slow = assert.rejects(sdk.request('GET', '/v2/devices'), NinjaOneError);
  await started;
  await assert.rejects(sdk.request('POST', '/v2/contacts', { body: { email: 'test@example.com' } }), NinjaOneError);
  assert.equal(apiCalls, 2);
  await sdk.request('GET', '/v2/devices');
  assert.equal(tokens, 2);
  releaseLate();
  await slow;
  await sdk.request('GET', '/v2/devices');
  assert.equal(tokens, 2);
});

test('an explicitly undefined accessToken selects OAuth', async () => {
  let tokenCalls = 0;
  const sdk = new NinjaOneClient({
    baseUrl: 'https://app.ninjarmm.com', accessToken: undefined,
    oauth: { clientId: 'id', clientSecret: 'secret' },
    fetch: async request => {
      if (request.url.endsWith('/ws/oauth/token')) {
        tokenCalls++;
        return json({ access_token: 'test', token_type: 'Bearer', expires_in: 3600 });
      }
      assert.equal(request.headers.get('Authorization'), 'Bearer test');
      return json([]);
    },
  });
  assert.deepEqual(await sdk.request('GET', '/v2/devices'), []);
  assert.equal(tokenCalls, 1);
});

test('timer configuration rejects values that Node would overflow', () => {
  for (const key of ['timeoutMs', 'maxRetryDelayMs']) {
    for (const value of [2_147_483_648, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => client(fetch, { [key]: value }), new RegExp(key));
    }
    assert.doesNotThrow(() => client(fetch, { [key]: 2_147_483_647 }));
  }
});

test('safe reads retry rate limits and transient server errors', async () => {
  let calls = 0;
  const sdk = client(async () => {
    calls++;
    return calls < 3 ? json({}, calls === 1 ? 429 : 503, { 'Retry-After': '0' }) : json([{ id: 1 }]);
  });
  assert.deepEqual(await sdk.request('GET', '/v2/devices'), [{ id: 1 }]);
  assert.equal(calls, 3);
});

test('writes are never retried and errors retain status, body, and headers', async () => {
  let calls = 0;
  const sdk = client(async () => { calls++; return json({ message: 'limited' }, 429, { 'Retry-After': '5' }); });
  await assert.rejects(sdk.request('POST', '/v2/contacts', { body: {} }), error => {
    assert.ok(error instanceof NinjaOneError);
    assert.equal(error.status, 429);
    assert.deepEqual(error.body, { message: 'limited' });
    assert.equal(error.headers.get('Retry-After'), '5');
    assert.ok(!error.message.includes('test-token'));
    return true;
  });
  assert.equal(calls, 1);
});

test('retry limits and long Retry-After values stop without early retries', async () => {
  let calls = 0;
  const sdk = client(async () => { calls++; return json({}, 503, { 'Retry-After': '0' }); });
  await assert.rejects(sdk.request('GET', '/v2/devices'), NinjaOneError);
  assert.equal(calls, 3);
  calls = 0;
  const limited = client(async () => { calls++; return json({}, 429, { 'Retry-After': '600' }); });
  await assert.rejects(limited.request('GET', '/v2/devices'), NinjaOneError);
  assert.equal(calls, 1);
});

test('plain-text errors are preserved and unauthorized reads are not retried', async () => {
  let calls = 0;
  const sdk = client(async () => { calls++; return new Response('denied', { status: 401 }); });
  await assert.rejects(sdk.request('GET', '/v2/devices'), error => error.body === 'denied');
  assert.equal(calls, 1);
});

test('cancellation interrupts retry waits and token callbacks', async () => {
  const controller = new AbortController();
  const sdk = client(async () => {
    setTimeout(() => controller.abort(), 10);
    return json({}, 429, { 'Retry-After': '10' });
  });
  await assert.rejects(sdk.request('GET', '/v2/devices', { signal: controller.signal }), { name: 'AbortError' });
  const waiting = client(async () => json([]), { accessToken: () => new Promise(() => {}), timeoutMs: 10 });
  /* Keep the test process alive while the native timeout signal is pending. */
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(waiting.request('GET', '/v2/devices'), { name: 'TimeoutError' }); }
  finally { clearTimeout(keepAlive); }
});

test('invalid configuration, missing paths, and dot segments fail before sending', async () => {
  for (const baseUrl of ['https://example.com/v2', 'https://user:secret@example.com', 'ftp://example.com']) {
    assert.throws(() => client(fetch, { baseUrl }));
  }
  assert.throws(() => client(fetch, { maxRetries: -1 }));
  const sdk = client(async () => { assert.fail('Unexpected network request'); });
  await assert.rejects(sdk.request('GET', '/v2/contact/{id}'), /Missing path parameter/);
  await assert.rejects(sdk.request('GET', '/v2/contact/{id}', { path: { id: '..' } }), /dot segments/);
});

test('pagination supports explicit end markers and detects cursor loops', async () => {
  const collected = [];
  for await (const item of paginate(async cursor => cursor === undefined
    ? { items: [1, 2], nextCursor: 2 } : { items: [3] })) collected.push(item);
  assert.deepEqual(collected, [1, 2, 3]);
  await assert.rejects(async () => {
    for await (const item of paginate(async () => ({ items: [], nextCursor: 'same' }))) void item;
  }, /repeated cursor/);
  await assert.rejects(async () => {
    for await (const item of paginate(async () => ({ items: [], nextCursor: 1 }), { maxPages: 1 })) void item;
  }, /exceeded maxPages/);
});
