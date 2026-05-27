#!/usr/bin/env node
/**
 * Renderer build step.
 *
 *   src/*.jsx  →  out/*.js                  (esbuild, classic JSX transform)
 *   src/*.js   →  out/*.js                  (copy through, no transform)
 *   node_modules/react{,-dom}/umd/*.production.min.js  →  vendor/*.js
 *
 * The renderer loads React + ReactDOM as globals (UMD) and our compiled
 * files use the classic JSX transform (`React.createElement` /
 * `React.Fragment`), so esbuild does not need to bundle anything — each
 * source file ships as its own script tag in HTML, preserving the load
 * order from "CloudPG Console.html".
 *
 * Output goes to `out/` and `vendor/` (both gitignored). The Electron
 * main process loads `CloudPG Console.html` which references these.
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root      = path.join(__dirname, '..');
const srcDir    = path.join(root, 'src');
const outDir    = path.join(root, 'out');
const vendorDir = path.join(root, 'vendor');

fs.mkdirSync(outDir,    { recursive: true });
fs.mkdirSync(vendorDir, { recursive: true });

// ── Vendor React + ReactDOM from node_modules ───────────────────────────────
const reactSrc    = path.join(root, 'node_modules', 'react',     'umd', 'react.production.min.js');
const reactDomSrc = path.join(root, 'node_modules', 'react-dom', 'umd', 'react-dom.production.min.js');
for (const src of [reactSrc, reactDomSrc]) {
  if (!fs.existsSync(src)) {
    console.error(`missing: ${src}\nRun \`npm install\` first.`);
    process.exit(1);
  }
}
fs.copyFileSync(reactSrc,    path.join(vendorDir, 'react.production.min.js'));
fs.copyFileSync(reactDomSrc, path.join(vendorDir, 'react-dom.production.min.js'));

// ── Compile JSX → JS ────────────────────────────────────────────────────────
const jsxFiles = fs.readdirSync(srcDir)
  .filter(f => f.endsWith('.jsx'))
  .map(f => path.join(srcDir, f));

esbuild.buildSync({
  entryPoints: jsxFiles,
  outdir: outDir,
  loader: { '.jsx': 'jsx' },
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  bundle: false,
  // Electron 32 ships Chromium 128 — feel free to use modern JS.
  target: 'chrome128',
  minify: true,
  sourcemap: 'inline',
  logLevel: 'info',
});

// ── Copy plain .js source through (just backend.js today) ──────────────────
for (const f of fs.readdirSync(srcDir).filter(f => f.endsWith('.js'))) {
  fs.copyFileSync(path.join(srcDir, f), path.join(outDir, f));
}

const totalBytes = fs.readdirSync(outDir)
  .map(f => fs.statSync(path.join(outDir, f)).size)
  .reduce((a, b) => a + b, 0);
console.log(`built ${jsxFiles.length} jsx + ${fs.readdirSync(srcDir).filter(f => f.endsWith('.js')).length} js → ${outDir} (${(totalBytes/1024).toFixed(1)} KB)`);
