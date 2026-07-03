// @ts-check
const esbuild = require('esbuild');
require('./scripts/generate-companion-plugin-source.js');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // vscode API is injected at runtime; ssh2 ships optional native bindings
  // that esbuild cannot bundle — load it from node_modules at runtime instead
  external: ['vscode', 'ssh2', 'ssh2-sftp-client', 'cpu-features', 'sshcrypto'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context({
      ...buildOptions,
      plugins: [
        {
          name: 'watch-logger',
          setup(build) {
            build.onEnd((result) => {
              if (result.errors.length > 0) {
                console.error('[esbuild] Build failed:', result.errors);
              } else {
                console.log('[esbuild] Build succeeded');
              }
            });
          },
        },
      ],
    });
    await ctx.watch();
    console.log('[esbuild] Watching for changes…');
  } else {
    await esbuild.build(buildOptions);
    console.log('[esbuild] Build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
