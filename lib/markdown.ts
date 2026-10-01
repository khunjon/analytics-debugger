import type { Issue } from './checks';
import { decoderFor, type DecodedEvent } from './decoders';
import type { HitEvent } from './types';
import { badgeFor, clockTime, dataLayerTitle, hitStatus, relativeTime, ruleOutcome, type PageGroup, type Row } from './view';
import type { WatchCell } from './watch';

const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const issueLines = (issues: Issue[] | undefined) => (issues?.length ? [...issues.map((i) => `- **${i.level}:** ${i.message}`), ''] : []);

export function decodedToMarkdown(d: DecodedEvent, hit: HitEvent, heading = '####', issues?: Issue[]): string {
  const vendor = decoderFor(d.vendor).label;
  const lines = [`${heading} ${vendor}: ${d.eventName}${d.detail ? ` (${d.detail})` : ''}`, ''];
  const meta = [
    d.account && `${d.accountLabel ?? 'Account'}: \`${d.account}\``,
    clockTime(hit.ts),
    `status: ${hitStatus(hit).label}`,
  ].filter(Boolean);
  lines.push(meta.join(' · '), '', ...issueLines(issues));
  for (const g of d.groups) {
    lines.push(`**${g.title}**`, '', '| Name | Key | Value |', '|---|---|---|');
    for (const r of g.rows) {
      const value = r.note ? `${r.value} (${r.note})` : r.value;
      lines.push(`| ${cell(r.label ?? r.key)} | \`${cell(r.key)}\` | ${cell(value)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function rowTitle(row: Row): string {
  switch (row.type) {
    case 'hit':
      return `${row.decoded.eventName}${row.decoded.detail ? ` (${row.decoded.detail})` : ''}`;
    case 'datalayer':
      return dataLayerTitle(row.event, row.changed);
    case 'interaction':
      return `"${row.event.text}" ${row.event.selector}`;
    case 'nav':
      return row.event.url;
    case 'rule':
      return `${row.event.ruleName}: ${ruleOutcome(row).label}`;
  }
}

function rowDetail(row: Row): string {
  if (row.type === 'hit') return row.decoded.summary.join(' · ');
  if (row.type === 'interaction') return row.event.href ?? '';
  return '';
}

/** While watching variables: one row per event, one column per watched variable. */
export function pageToWatchMarkdown(group: PageGroup, terms: string[], watch: Map<string, WatchCell[]>): string {
  const { page, rows } = group;
  const valueOf = (row: Row, term: string) => {
    const matches = watch.get(row.key)?.find((c) => c.term === term)?.matches ?? [];
    return matches.map((m) => m.value).join(' | ');
  };
  return [
    `### ${page.url || '(page loaded before capture started)'}`,
    '',
    `| Time | Source | Event | ${terms.map(cell).join(' | ')} |`,
    `|---|---|---|${terms.map(() => '---').join('|')}|`,
    ...rows.map(
      (r) =>
        `| ${relativeTime(r.ts, page.ts)} | ${badgeFor(r)} | ${cell(rowTitle(r))} | ${terms.map((t) => cell(valueOf(r, t))).join(' | ')} |`,
    ),
    '',
  ].join('\n');
}

export function pageToMarkdown(group: PageGroup, issues?: Map<string, Issue[]>): string {
  const { page, rows } = group;
  const lines = [
    `### ${page.url || '(page loaded before capture started)'}`,
    '',
    `Loaded ${new Date(page.ts).toLocaleString()}`,
    '',
    '| Time | Source | Event | Details |',
    '|---|---|---|---|',
    ...rows.map((r) => {
      const flagged = issues?.get(r.key)?.length ? ' ⚠' : '';
      return `| ${relativeTime(r.ts, page.ts)} | ${badgeFor(r)} | ${cell(rowTitle(r))}${flagged} | ${cell(rowDetail(r))} |`;
    }),
    '',
  ];
  const hits = rows.filter((r): r is Extract<Row, { type: 'hit' }> => r.type === 'hit');
  if (hits.length) {
    lines.push('#### Hit details', '');
    for (const h of hits) lines.push(decodedToMarkdown(h.decoded, h.event, '#####', issues?.get(h.key)));
  }
  return lines.join('\n');
}
