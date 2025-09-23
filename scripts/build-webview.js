#!/usr/bin/env node
const esbuild = require('esbuild');
const path = require('path');

(async () => {
  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, '../webview-src/index.ts')],
      bundle: true,
      outfile: path.join(__dirname, '../media/main.js'),
      platform: 'browser',
      target: 'es2020',
      sourcemap: true,
      minify: true,
      logLevel: 'info'
    });
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
