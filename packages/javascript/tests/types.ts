import { NinjaOneClient, type ApiResponse } from '../src/index.js';

const client = new NinjaOneClient({ baseUrl: 'https://app.ninjarmm.com', accessToken: 'token' });
new NinjaOneClient({ baseUrl: 'https://app.ninjarmm.com', accessToken: undefined, oauth: { clientId: 'id', clientSecret: 'secret' } });
const devices: Promise<ApiResponse<'GET', '/v2/devices'>> = client.request('GET', '/v2/devices');
devices.then(items => { const id: number | undefined = items[0]?.id; void id; });
client.request('GET', '/v2/contact/{id}', { path: { id: 1 } });
client.request('POST', '/v2/contacts', { body: { email: 'test@example.com' } });
client.request('GET', '/v2/devices', { query: { after: 1, pageSize: 100 } });
const deleted: Promise<undefined> = client.request('DELETE', '/v2/contact/{id}', { path: { id: 1 } });
const raw: Promise<Response> = client.requestRaw('GET', '/v2/devices');
client.request('POST', '/v2/attachments/temp/upload', { body: new FormData() });
client.request('POST', '/v2/billing/invoices', { body: { agreementId: 1 } }).then(invoice => {
  const id: number | undefined = invoice?.id;
  void id;
  /* @ts-expect-error A 204 response has no invoice body. */
  invoice.id;
});
void deleted;
void raw;
/* @ts-expect-error A required request body must not be omitted. */
client.request('POST', '/v2/contacts');
/* @ts-expect-error Multipart operations require native FormData. */
client.request('POST', '/v2/attachments/temp/upload', { body: { files: [] } });
/* @ts-expect-error Unknown routes must not compile. */
client.request('GET', '/v2/missing');
/* @ts-expect-error Invalid methods must not compile. */
client.request('DELETE', '/v2/devices');
/* @ts-expect-error Required path parameters must be provided. */
client.request('GET', '/v2/contact/{id}');
/* @ts-expect-error Path parameter types come from the schema. */
client.request('GET', '/v2/contact/{id}', { path: { id: 'bad' } });
/* @ts-expect-error Query parameter types come from the schema. */
client.request('GET', '/v2/devices', { query: { pageSize: 'bad' } });
/* @ts-expect-error JSON payloads must match their schema. */
client.request('POST', '/v2/contacts', { body: { email: 123 } });
/* @ts-expect-error Select exactly one authentication mechanism. */
new NinjaOneClient({ baseUrl: 'https://app.ninjarmm.com', accessToken: 'token', oauth: { clientId: 'id', clientSecret: 'secret' } });
