#!/usr/bin/env node
// Builds, checks and installs the extension into dist/chrome, the folder Chrome loads.
// The installed extension watches its own build.json and updates itself:
//   - side panel changes: the open panel refreshes in place
//   - background, content script or manifest changes: the extension reloads and keeps captured events
//
//   node scripts/deploy.mjs            deploy if the source changed since the last deploy
//   node scripts/deploy.mjs --force    deploy even if nothing changed
//   node scripts/deploy.mjs --watch    deploy now, then again on every source change
//   node scripts/deploy.mjs --quiet    print only errors (used by the Claude Code Stop hook)

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD = path.join(ROOT, '.output/chrome-mv3');
const LIVE = path.join(ROOT, 'dist/chrome');
const BUILD_INFO = 'build.json';
const SOURCES = ['entrypoints', 'lib', 'public', 'wxt.config.ts', 'tsconfig.json', 'package-lock.json'];

/** Files that only take effect after a full extension reload. Everything else belongs to the side panel. */
const isCore = (file) =>
  file === 'manifest.json' || file === 'background.js' || file.startsWith('content-scripts/') || file.startsWith('icon/');

const flags = new Set(process.argv.slice(2));
const quiet = flags.has('--quiet');
const log = (...args) => {
  if (!quiet) console.log(...args);
};

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.name === '.DS_Store') return [];
      return entry.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
    })
    .sort();
}

function hashFiles(base, files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file}\0`).update(fs.readFileSync(path.join(base, file))).update('\0');
  return hash.digest('hex').slice(0, 16);
}

function sourceHash() {
  const files = SOURCES.flatMap((source) => {
    const full = path.join(ROOT, source);
    const stat = fs.statSync(full, { throwIfNoEntry: false });
    if (!stat) return [];
    return stat.isDirectory() ? walk(full).map((f) => `${source}/${f}`) : [source];
  });
  return hashFiles(ROOT, files);
}

function readInstalled() {
  try {
    return JSON.parse(fs.readFileSync(path.join(LIVE, BUILD_INFO), 'utf8'));
  } catch {
    return null;
  }
}

function run(label, bin, args) {
  const started = Date.now();
  const result = spawnSync(path.join(ROOT, 'node_modules/.bin', bin), args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`.trim();
    console.error(`✗ ${label} failed:\n${output.split('\n').slice(-60).join('\n')}`);
    return false;
  }
  log(`  ✓ ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return true;
}

function removeEmptyDirs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    removeEmptyDirs(full);
    if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
  }
}

function printFirstInstall() {
  let copied = false;
  if (process.platform === 'darwin') copied = spawnSync('pbcopy', { input: LIVE }).status === 0;
  log(`
Installed to ${LIVE}

One-time setup in Chrome:
  1. Open chrome://extensions and turn on Developer mode (top right).
  2. Click "Load unpacked" and choose the folder above.${copied ? '\n     The path is on your clipboard: in the file dialog press Cmd+Shift+G and paste.' : ''}
  3. Pin Analytics Debugger from the puzzle-piece menu, then click its icon.

After that, every deploy installs itself.`);
}

function deploy({ force }) {
  const source = sourceHash();
  const installed = readInstalled();
  if (!force && installed?.source === source) {
    log('Analytics Debugger is up to date.');
    return true;
  }

  log('Deploying Analytics Debugger…');
  const checks = [
    ['typecheck', 'tsc', ['--noEmit', '--pretty', 'false']],
    ['unit tests', 'vitest', ['run']],
    ['build', 'wxt', ['build']],
  ];
  for (const [label, bin, args] of checks) {
    if (!run(label, bin, args)) {
      console.error('Not deployed. The installed extension is unchanged.');
      return false;
    }
  }

  const files = walk(BUILD);
  const core = hashFiles(BUILD, files.filter(isCore));
  const panel = hashFiles(BUILD, files.filter((f) => !isCore(f)));
  const firstInstall = !fs.existsSync(path.join(LIVE, 'manifest.json'));

  // Copy changed files, remove stale ones, then write build.json last so the running extension
  // reacts only once everything is in place.
  for (const file of files) {
    const from = path.join(BUILD, file);
    const to = path.join(LIVE, file);
    if (fs.existsSync(to) && fs.readFileSync(to).equals(fs.readFileSync(from))) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  const keep = new Set([...files, BUILD_INFO]);
  for (const file of walk(LIVE)) if (!keep.has(file)) fs.rmSync(path.join(LIVE, file));
  removeEmptyDirs(LIVE);
  fs.writeFileSync(path.join(LIVE, BUILD_INFO), `${JSON.stringify({ source, core, panel, builtAt: Date.now() }, null, 2)}\n`);

  if (firstInstall) printFirstInstall();
  else if (installed?.core !== core) log('Installed. The extension reloads itself in a moment and keeps captured events; reopen the side panel if it was open.');
  else if (installed?.panel !== panel) log('Installed. An open side panel refreshes itself.');
  else log('Installed. The built extension did not change.');
  return true;
}

if (flags.has('--watch')) {
  deploy({ force: flags.has('--force') });
  let timer;
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(() => deploy({ force: false }), 400);
  };
  for (const source of SOURCES) {
    const full = path.join(ROOT, source);
    if (fs.existsSync(full)) fs.watch(full, { recursive: true }, trigger);
  }
  log('Watching for changes. Press Ctrl+C to stop.');
} else {
  process.exit(deploy({ force: flags.has('--force') }) ? 0 : 1);
}
