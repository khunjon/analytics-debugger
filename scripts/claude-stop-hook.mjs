#!/usr/bin/env node
// Claude Code Stop hook (registered in .claude/settings.json). After each Claude turn, deploys the
// extension so the installed copy always matches the code. Deploying is a no-op when nothing changed.
// If a check fails, exit code 2 sends Claude back to fix it, once per turn (stop_hook_active guards
// against a loop); the second failure is reported to the user instead.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  /* no or invalid stdin */
}

const root = path.resolve(import.meta.dirname, '..');
const result = spawnSync(process.execPath, [path.join(root, 'scripts/deploy.mjs'), '--quiet'], {
  cwd: root,
  encoding: 'utf8',
});
if (result.status === 0) process.exit(0);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
if (input.stop_hook_active) {
  process.stderr.write(`Analytics Debugger was not deployed because a check still fails:\n${output}\n`);
  process.exit(1);
}
process.stderr.write(
  `The extension was not deployed because a check failed. Fix it so the installed extension updates:\n${output}\n`,
);
process.exit(2);
