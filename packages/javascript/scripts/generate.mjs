import { readFile, writeFile } from 'node:fs/promises';
import openapiTS, { astToString } from 'openapi-typescript';

const schema = JSON.parse(await readFile(new URL('../../../schemas/NinjaRMM-API-v2.json', import.meta.url), 'utf8'));
/* The upstream document uses default for many successful responses. Give
 * those operations a success alias so typed clients can infer their data. */
let count = 0;
for (const item of Object.values(schema.paths)) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
    const operation = item[method];
    if (!operation) continue;
    count++;
    const responses = operation.responses;
    if (responses?.default && !Object.keys(responses).some(key => /^2/.test(key))) {
      responses['200'] = structuredClone(responses.default);
    }
  }
}
const output = astToString(await openapiTS(schema));
await writeFile(new URL('../src/schema.d.ts', import.meta.url), '/* Generated declarations. Run npm run generate to update. */\n' + output);
console.log(`Generated types for ${count} operations across ${Object.keys(schema.paths).length} paths.`);
