// Production bundle: workspace packages (@tw/*) and the generated Prisma client are
// compiled in; npm dependencies stay external and are installed in the runtime image.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@tw/'));

await build({
  // Named entries keep every output at dist/<name>.js (src/ and prisma/ have no common root).
  entryPoints: {
    main: 'src/main.ts',
    worker: 'src/worker.ts',
    'verify-restore': 'src/verify-restore.ts',
    seed: 'prisma/seed.ts', // first admin on a fresh environment: node dist/seed.js
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external,
  logLevel: 'info',
  banner: {
    // Allow bundled CommonJS code to use require() inside the ESM output.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
