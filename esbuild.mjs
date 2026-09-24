// Bundles src → dist/extension.js (and, with --test, test → out/test).
import * as esbuild from 'esbuild';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');

if (args.has('--test')) {
  await esbuild.build({
    entryPoints: ['test/*.test.ts'],
    outdir: 'out/test',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: 'inline',
    logLevel: 'warning',
  });
} else {
  const options = {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    minify: production,
    sourcemap: !production,
    logLevel: 'info',
  };
  if (args.has('--watch')) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
}
