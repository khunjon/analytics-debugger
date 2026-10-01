#!/usr/bin/env node
// Renders the extension icons from SVG with Playwright's Chromium:
//   public/icon/<size>.png      release icon (dark, orange pulse)
//   scripts/dev-icon/<size>.png dev-build icon (inverted), applied by scripts/deploy.mjs to dist/chrome
//
//   node scripts/render-icons.mjs

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SIZES = [16, 32, 48, 128];

const icon = (background, stroke) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect x="4" y="4" width="120" height="120" rx="28" fill="${background}"/>
  <path d="M22 72 H44 L54 44 L68 92 L80 60 L88 72 H106" fill="none" stroke="${stroke}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const variants = [
  { dir: path.join(ROOT, 'public/icon'), svg: icon('#1d1d1b', '#ffa24d') },
  { dir: path.join(ROOT, 'scripts/dev-icon'), svg: icon('#ffa24d', '#1d1d1b') },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const { dir, svg } of variants) {
  fs.mkdirSync(dir, { recursive: true });
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
    await page.screenshot({ path: path.join(dir, `${size}.png`), omitBackground: true });
  }
  console.log(`Wrote ${path.relative(ROOT, dir)}/{${SIZES.join(',')}}.png`);
}
await browser.close();
