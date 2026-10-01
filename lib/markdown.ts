import { decoderFor, type DecodedEvent } from './decoders';
import type { HitEvent } from './types';
import { badgeFor, clockTime, dataLayerTitle, hitStatus, relativeTime, type PageGroup, type Row } from './view';

const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function decodedToMarkdown(d: DecodedEvent, hit: HitEvent, heading = '####'): string {
  const vendor = decoderFor(d.vendor).label;
  const lines = [`${heading} ${vendor}: ${d.eventName}${d.detail ? ` (${d.detail})` : ''}`, ''];
  const meta = [
    d.account && `${d.accountLabel ?? 'Account'}: \`${d.account}\``,
    clockTime(hit.ts),
    `status: ${hitStatus(hit).label}`,
  ].filter(Boolean);
  lines.push(meta.join(' · '), '');
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
      return dataLayerTitle(row.event);
    case 'interaction':
      return `"${row.event.text}" ${row.event.selector}`;
    case 'nav':
      return row.event.url;
  }
}

function rowDetail(row: Row): string {
  if (row.type === 'hit') return row.decoded.summary.join(' · ');
  if (row.type === 'interaction') return row.event.href ?? '';
  return '';
}

export function pageToMarkdown(group: PageGroup): string {
  const { page, rows } = group;
  const lines = [
    `### ${page.url || '(page loaded before capture started)'}`,
    '',
    `Loaded ${new Date(page.ts).toLocaleString()}`,
    '',
    '| Time | Source | Event | Details |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${relativeTime(r.ts, page.ts)} | ${badgeFor(r)} | ${cell(rowTitle(r))} | ${cell(rowDetail(r))} |`),
    '',
  ];
  const hits = rows.filter((r): r is Extract<Row, { type: 'hit' }> => r.type === 'hit');
  if (hits.length) {
    lines.push('#### Hit details', '');
    for (const h of hits) lines.push(decodedToMarkdown(h.decoded, h.event, '#####'));
  }
  return lines.join('\n');
}
