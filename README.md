# libninjaone

Unofficial client libraries for the NinjaOne / NinjaRMM APIs.

## Layout

- `schemas/` holds the official OpenAPI specification and its source metadata.
- `packages/javascript/` holds `ninjaone`, the TypeScript client. See its
  [README](packages/javascript/README.md).

Packages are grouped by language, written out in full. The npm and PyPI name is
`ninjaone`; only the JavaScript package exists so far.

## Development

From `packages/javascript/`:

```sh
npm ci
npm test
```

The client covers all 315 operations in the bundled schema and supports bearer
tokens, OAuth2 client credentials, retries on safe reads and explicit
pagination.

## API documentation

https://app.ninjarmm.com/apidocs/?links.active=core

## License

libninjaone is free software released under the MIT License.

Copyright (c) 2026 Pasquale 'sid' Fiorillo.

## Trademark notice

NinjaOne is a trademark of NinjaOne, LLC. This project is independent and is not affiliated with, sponsored by, or endorsed by NinjaOne.
