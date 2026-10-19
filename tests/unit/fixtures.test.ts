import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The repo is public, and real hits make the best fixtures. This fails when something in tests/ looks
 * like a real client's report suite, measurement ID, container, org, datastream, domain or email, so a
 * fixture can't be committed (or deployed by the Stop hook) before it's sanitized.
 *
 * Made-up values follow a convention: report suites start with example, fixture or test; IDs contain
 * EXAMPLE, FIXTURE, TEST, ABC123 or XYZ789; domains are example.com (any TLD), x.com, *.test or local.
 */

const TESTS_DIR = join(import.meta.dirname, '..');
const SELF = relative(TESTS_DIR, import.meta.filename);

const MADE_UP_ID = /EXAMPLE|FIXTURE|TEST|ABC123|XYZ789/i;
const MADE_UP_RSID = /^(?:(?:example|fixture|test)\w*|rs|rsid)$/i;
const PLACEHOLDER_HOST = /(?:^|\.)(?:example\.[a-z.]+|x\.com|test|localhost)$|^127\.0\.0\.1$/;
/** Collection hosts shared by every customer. Hosts that carry a customer prefix (omtrdc.net) aren't here. */
const VENDOR_HOST =
  /(?:^|\.)(?:google-analytics\.com|googletagmanager\.com|doubleclick\.net|google\.com|facebook\.com|optimizely\.com|tiktok\.com|bing\.com|linkedin\.com|pinterest\.com|twitter\.com|t\.co|demdex\.net)$|^edge\.adobedc\.net$/;
/** example.sc.omtrdc.net, example.tt.omtrdc.net: the first label is the customer. */
const PREFIXED_VENDOR_HOST = /^([\w-]+)\.(?:[\w-]+\.)*(?:omtrdc\.net|2o7\.net)$/;

interface Finding {
  where: string;
  what: string;
}

const rules: { name: string; find: RegExp; ok: (match: RegExpExecArray) => boolean }[] = [
  {
    name: 'report suite',
    find: /\/b\/ss\/([^/?#"'`\s]+)/g,
    ok: (m) => m[1]!.split(',').every((rsid) => MADE_UP_RSID.test(rsid)),
  },
  { name: 'GA4 measurement ID', find: /\bG-[A-Z0-9]{4,}\b/g, ok: (m) => MADE_UP_ID.test(m[0]) },
  { name: 'GTM container', find: /\bGTM-[A-Z0-9]+\b/g, ok: (m) => MADE_UP_ID.test(m[0]) },
  { name: 'Adobe org ID', find: /\b[A-Z0-9]{16,}@AdobeOrg\b/gi, ok: (m) => MADE_UP_ID.test(m[0]) || /^(\w)\1+@/.test(m[0]) },
  {
    // Web SDK datastream IDs, Target and Optimizely UUIDs. Made-up ones start with one repeated character or 12345678.
    name: 'datastream or other UUID',
    find: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    ok: (m) => /^(?:([0-9a-f])\1{7}|12345678)-/i.test(m[0]),
  },
  {
    name: 'domain',
    find: /https?:\/\/([a-z0-9.-]+)/gi,
    ok: (m) => {
      const host = m[1]!.toLowerCase();
      if (PLACEHOLDER_HOST.test(host) || VENDOR_HOST.test(host)) return true;
      const prefixed = PREFIXED_VENDOR_HOST.exec(host);
      return Boolean(prefixed && MADE_UP_RSID.test(prefixed[1]!));
    },
  },
  {
    name: 'email address',
    find: /[a-z0-9._+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/gi,
    ok: (m) => PLACEHOLDER_HOST.test(m[1]!.toLowerCase()) || /\.(?:png|jpe?g|gif|svg|webp)$/i.test(m[1]!),
  },
];

function decoded(line: string): string {
  try {
    return decodeURIComponent(line);
  } catch {
    return line;
  }
}

function scan(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((raw, i) => {
    const seen = new Set<string>();
    for (const line of [raw, decoded(raw)]) {
      for (const rule of rules) {
        for (const m of line.matchAll(rule.find)) {
          const key = `${rule.name}|${m[0]}`;
          if (seen.has(key) || rule.ok(m as RegExpExecArray)) continue;
          seen.add(key);
          findings.push({ where: `tests/${file}:${i + 1}`, what: `${rule.name} ${m[0]}` });
        }
      }
    }
  });
  return findings;
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [relative(TESTS_DIR, path)];
  });
}

describe('test fixtures carry no client data', () => {
  it('uses only made-up IDs, domains and emails', () => {
    const findings = files(TESTS_DIR)
      .filter((f) => f !== SELF && /\.(?:ts|tsx|js|mjs|json|html|har|txt|csv)$/.test(f))
      .flatMap((f) => scan(readFileSync(join(TESTS_DIR, f), 'utf8'), f));
    expect(
      findings.map((f) => `${f.where}  ${f.what}`),
      'Replace these with made-up values (see the convention at the top of tests/unit/fixtures.test.ts)',
    ).toEqual([]);
  });

  it('catches real-looking values', () => {
    const planted = [
      'https://acme.sc.omtrdc.net/b/ss/acmeprod,acmeglobal/1/JS-2.27.0/s123',
      'tid=G-7XK3PQ2LMN&gtm=GTM-K9P2QRS',
      'ECID org 4F3B2A1C9D8E7F6A5B4C3D2E@AdobeOrg',
      'configId=9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
      'dl=https%3A%2F%2Fwww.acme-shoes.com%2Fcart',
      'ep.contact=jane.doe%40acme-shoes.com',
    ].join('\n');
    expect(scan(planted, 'planted').map((f) => f.what)).toEqual([
      'report suite /b/ss/acmeprod,acmeglobal',
      'domain https://acme.sc.omtrdc.net',
      'GA4 measurement ID G-7XK3PQ2LMN',
      'GTM container GTM-K9P2QRS',
      'Adobe org ID 4F3B2A1C9D8E7F6A5B4C3D2E@AdobeOrg',
      'datastream or other UUID 9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
      'domain https://www.acme-shoes.com',
      'email address jane.doe@acme-shoes.com',
    ]);
  });
});
