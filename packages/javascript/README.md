# ninjaone

Unofficial TypeScript client for the NinjaOne / NinjaRMM APIs.

It has no runtime dependencies. Requests, authentication, cancellation and
multipart uploads use `fetch`, `Request`, `FormData` and `AbortController`
directly.

Node.js 22 or later. The package is an ES module and ships its own type
declarations.

## Installation

```sh
npm install ninjaone
```

For local development, run `npm ci` and `npm run build` in this directory.

## Access token

```typescript
import { NinjaOneClient } from 'ninjaone';

const client = new NinjaOneClient({
  baseUrl: 'https://eu.ninjarmm.com',
  accessToken: process.env.NINJAONE_ACCESS_TOKEN!,
});

const devices = await client.request('GET', '/v2/devices', {
  query: { pageSize: 100 },
});

const device = await client.request('GET', '/v2/device/{id}', {
  path: { id: 123 },
});
```

`baseUrl` is the instance origin alone, without `/v2`, a query string or a
fragment. HTTPS is required except for `localhost`, `127.0.0.1` and `[::1]`,
which may use HTTP for local testing. `accessToken` may also be a sync or
async function, for tokens your application already manages.

## OAuth2 client credentials

```typescript
const client = new NinjaOneClient({
  baseUrl: 'https://eu.ninjarmm.com',
  oauth: {
    clientId: process.env.NINJAONE_CLIENT_ID!,
    clientSecret: process.env.NINJAONE_CLIENT_SECRET!,
    scopes: ['monitoring'],
  },
});
```

The client authenticates at `/ws/oauth/token` using `client_secret_basic`.
Each credential is form-encoded before the pair is Base64-encoded in the
`Authorization` header. Credentials are not sent in the request body.

Tokens are requested from `/ws/oauth/token` and cached until shortly before
`expires_in`. Concurrent calls share a single token request. A token response
without `expires_in` is not reused. The default scope is `monitoring`; ask for
more only when an operation needs them. Keep client secrets on the server. For
authorization-code flows, pass the resulting token through `accessToken`.

Token responses must be JSON objects with a non-empty `access_token` and a
`token_type` of `Bearer` (case-insensitive). If present, `expires_in` must be a
finite non-negative number whose expiry fits in a safe numeric timestamp;
`scope` must be a string. Invalid responses are rejected before any API call.

## Typed requests

`client.request(method, path, options)` resolves to the parsed response body.
Paths, methods, parameters and payloads come from the bundled specification,
which covers 315 operations on 254 paths.

```typescript
const contact = await client.request('POST', '/v2/contacts', {
  body: { email: 'person@example.com', firstName: 'Alex' },
});
```

- `path` fills route placeholders, `query` adds query parameters.
- A plain object body is sent as JSON. Multipart operations take `FormData` and
  the client leaves the boundary to `fetch`.
- `headers` takes a `HeadersInit`. The `Authorization` header is always set by
  the configured token provider.
- `signal` cancels the request, including any retry wait.
- JSON responses are parsed. Text responses resolve to a string, other content
  types to an `ArrayBuffer`, and 204, 205 and HEAD responses to `undefined`.
- `client.requestRaw(...)` takes the same arguments and returns the native
  `Response`, for headers, downloads and streaming. HTTP errors still throw.

Some responses are left undocumented upstream and their type is `unknown`.
Types describe the schema; they do not validate payloads at runtime. Where the
upstream document describes a success response only as `default`, the generator
adds a `200` alias for the generated types. The downloaded schema itself is not
modified.

## Errors, retries and timeouts

```typescript
import { NinjaOneError } from 'ninjaone';

try {
  await client.request('GET', '/v2/devices');
} catch (error) {
  if (error instanceof NinjaOneError) {
    console.error(error.status, error.body);
  } else {
    throw error;
  }
}
```

`NinjaOneError` carries `status`, `headers` and a parsed JSON or plain-text
`body`. Network failures, invalid JSON and cancellation keep their native
errors.

| Option | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | `30000` | Deadline for one call, including token, retries and body read |
| `maxRetries` | `2` | Extra attempts for GET/HEAD on 429, 502, 503 and 504 |
| `maxRetryDelayMs` | `30000` | Longest wait allowed between attempts |
| `fetch` | native `fetch` | Alternative transport, useful in tests |
| `maxResponseBytes` | `10485760` (10 MiB) | Body limit for `request()` and successful OAuth responses |
| `maxErrorResponseBytes` | `65536` (64 KiB) | Body limit for API and OAuth errors, including `requestRaw()` |

Both byte limits are configurable positive safe integers. For example:

```typescript
const client = new NinjaOneClient({
  baseUrl: 'https://eu.ninjarmm.com',
  accessToken: process.env.NINJAONE_ACCESS_TOKEN!,
  maxResponseBytes: 50 * 1024 * 1024,
  maxErrorResponseBytes: 256 * 1024,
});
```

The client checks `Content-Length` when present and counts bytes as it reads
the body, including bytes decompressed by `fetch`. Exceeding a limit cancels
the stream and throws `ResponseTooLargeError`, with `limit` and `status`
properties. An oversized error body raises this error instead of
`NinjaOneError`. Limits apply to body bytes, not total process memory: buffering
and JSON parsing need additional memory.

Successful `requestRaw()` responses are not buffered or size-limited by the
client. Read their streams directly for large downloads. OAuth token acquisition
and HTTP error responses still use the limits above.

`timeoutMs` and `maxRetryDelayMs` cannot exceed 2,147,483,647 ms, the maximum
supported by Node timers. Larger values are rejected during construction.

`Retry-After` is honored in seconds or as an HTTP date; without it the delay
starts at 500 ms and doubles. If the server asks for a longer wait than
`maxRetryDelayMs`, the error is raised rather than retried early. Writes,
token requests, network failures and 401 responses are never retried
automatically, and redirects are rejected. A shared OAuth request has its own
timeout, so canceling one caller does not cancel it for the others.

A 401 invalidates the cached OAuth token used for that request. The next call
acquires a new token; the failed call is not replayed. A delayed 401 does not
discard a newer token. Tokens supplied through `accessToken` remain managed by
the application.

## Pagination

Pagination differs between NinjaOne endpoints, so `paginate` asks for a
callback that returns the page items and the next cursor in whatever form the
endpoint documents. Omitting `nextCursor` ends the loop.

Device lists continue from the last device ID:

```typescript
import { paginate } from 'ninjaone';

for await (const device of paginate(async (after: number | undefined) => {
  const items = await client.request('GET', '/v2/devices', {
    query: { after, pageSize: 100 },
  });
  return {
    items,
    nextCursor: items.length ? items.at(-1)?.id : undefined,
  };
})) {
  console.log(device.id, device.systemName);
}
```

A repeated cursor throws instead of looping forever. The default limit is
10,000 pages. `initialCursor`, `maxPages` and `signal` are optional; pass the
same signal to the requests inside the callback to stop the network work too.

## Development

```sh
npm ci
npm run generate
npm test
npm pack --dry-run
```

`typescript` and `openapi-typescript` are the only direct development
dependencies. Generated types are committed as `src/schema.d.ts`, so a normal
build does not fetch or regenerate the schema. Tests run on Node's test runner
against local HTTP servers and mocked `fetch`; they need no NinjaOne
credentials.

The build clears `dist/` before compilation and copies the generated
declarations into the package. The schema has no emitted JavaScript or source
map.

To update API coverage, replace `../../schemas/NinjaRMM-API-v2.json` and its
source metadata, run `npm run generate`, then review the diff and run the
tests.

## Layout

- `src/` holds the client, auth, errors, response limits, pagination and
  generated schema types.
- `tests/` holds the tests and the type-level checks.
- `scripts/` holds the build and schema generator.
- `../../schemas/` holds the shared OpenAPI specification.

## License

libninjaone is free software released under the MIT License.

Copyright (c) 2026 Pasquale 'sid' Fiorillo.

## Trademark notice

NinjaOne is a trademark of NinjaOne, LLC. This project is independent and is not affiliated with, sponsored by, or endorsed by NinjaOne.
