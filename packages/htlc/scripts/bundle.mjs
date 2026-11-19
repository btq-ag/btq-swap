// Bundle the CLI into one dependency-free ESM file users can run with `node btq-htlc.mjs`.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [join(root, 'src', 'cli.ts')],
  outfile: join(root, 'dist', 'btq-htlc.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  define: { 'process.env.BTQ_HTLC_BUNDLED': '"1"' },
  minify: false,
  legalComments: 'none',
});
console.log('bundled dist/btq-htlc.mjs');
