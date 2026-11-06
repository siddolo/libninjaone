import { rm, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const require = createRequire(import.meta.url);

/* Remove stale output before compilation; declarations have no runtime map. */
await rm(new URL('dist/', root), { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], {
  cwd: fileURLToPath(root), stdio: 'inherit',
});
await copyFile(new URL('src/schema.d.ts', root), new URL('dist/schema.d.ts', root));
