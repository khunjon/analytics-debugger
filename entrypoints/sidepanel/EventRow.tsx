import { memo } from 'react';
import { worstLevel, type Issue } from '@/lib/checks';
import { consentSignal } from '@/lib/consent';
import { compactJson, pathOf } from '@/lib/format';
import { badgeFor, clockTime, dataLayerTitle, hitStatus, parsePayload, relativeTime, rowCategory, ruleOutcome, type Row } from '@/lib/view';
import type { WatchCell } from '@/lib/watch';
import { DataLayerDetail, HitDetail, InteractionDetail, IssueList, RuleDetail } from './details';

function rowText(row: Row): { title: string; detail?: string; summary?: string } {
  switch (row.type) {
    case 'hit': {
      const batch = row.of > 1 ? `${row.index + 1} of ${row.of} in request` : '';
      return {
        title: row.decoded.eventName,
        detail: row.decoded.detail,
        summary: [...row.decoded.summary, batch].filter(Boolean).join(' · '),
      };
    }
    case 'datalayer': {
      const p = parsePayload(row.event);
      return {
        title: dataLayerTitle(row.event, row.changed),
        summary: p && typeof p === 'object' ? compactJson(p) : undefined,
      };
    }
    case 'interaction':
      return {
        title: row.event.text ? `"${row.event.text}"` : `<${row.event.tag}>`,
        summary: `${row.event.selector}${row.event.href ? ` → ${row.event.href}` : ''}`,
      };
    case 'nav':
      return { title: pathOf(row.event.url), detail: row.event.how === 'hash' ? 'hash change' : 'history change' };
    case 'rule': {
      const outcome = ruleOutcome(row);
      const end = row.outcome ?? row.event;
      return { title: row.event.ruleName, detail: outcome.label, summary: outcome.tone === 'ok' ? undefined : end.settings };
    }
  }
}

function WatchValues({ cells }: { cells: WatchCell[] }) {
  return (
    <span className="watch">
      {cells.flatMap((c) => {
        const cls = `watch-item${c.changed ? ' changed' : ''}${c.matches.length ? '' : ' missing'}`;
        // A dotted term can match several nested keys; label each by its own key then.
        const items =
          c.matches.length > 1 ? c.matches.map((m) => ({ label: m.key, value: m.value })) : [{ label: c.term, value: c.matches[0]?.value }];
        return items.map((item, i) => (
          <span key={`${c.term}:${i}`} className={cls}>
            <span className="watch-key">{item.label}</span>
            <span className="watch-value" title={c.changed ? 'Changed since the previous hit of this type' : undefined}>
              {item.value === undefined ? '—' : item.value === '' ? '(empty)' : item.value}
            </span>
          </span>
        ));
      })}
    </span>
  );
}

const ISSUE_ICONS: Record<Issue['level'], string> = { error: '●', warn: '▲', info: 'ⓘ' };

function IssueLine({ issues }: { issues: Issue[] }) {
  const level = worstLevel(issues);
  const first = issues.find((i) => i.level === level)!;
  return (
    <span className={`issue-line ${level}`} title={issues.map((i) => i.message).join('\n')}>
      {ISSUE_ICONS[level]} {first.message}
      {issues.length > 1 && <span className="more"> +{issues.length - 1} more</span>}
    </span>
  );
}

export interface EventRowProps {
  row: Row;
  pageTs: number;
  expanded: boolean;
  onToggle: (key: string) => void;
  /** Watched values for this row; replaces the summary line when present. */
  cells?: WatchCell[];
  watchTerms: string[];
  issues?: Issue[];
  /** Follows a click closely enough to be one of its effects. */
  nested: boolean;
}

export const EventRow = memo(function EventRow({ row, pageTs, expanded, onToggle, cells, watchTerms, issues, nested }: EventRowProps) {
  const { title, detail, summary } = rowText(row);
  const status = row.type === 'hit' ? hitStatus(row.event) : undefined;
  const late = row.type === 'datalayer' && row.event.late;
  const consent = consentSignal(row);
  const ruleTone = row.type === 'rule' ? ruleOutcome(row).tone : undefined;
  const classes = [
    'row',
    `cat-${rowCategory(row)}`,
    expanded && 'open',
    nested && 'nested',
    row.type === 'interaction' && 'cause',
    ruleTone && `rule-${ruleTone}`,
  ].filter(Boolean);
  return (
    <div className={classes.join(' ')}>
      <button type="button" className="row-head" onClick={() => onToggle(row.key)} aria-expanded={expanded}>
        <span className="time" title={`${clockTime(row.ts)}${late ? ' (approximate: picked up by polling)' : ''}`}>
          {late ? '≈' : ''}
          {relativeTime(row.ts, pageTs)}
        </span>
        <span className="badge">{badgeFor(row)}</span>
        <span className="main">
          <span className="title">
            {title}
            {detail && <span className="detail"> {detail}</span>}
            {consent && <span className="tag consent">consent {consent.phase}</span>}
          </span>
          {consent && <span className="summary">{consent.by}: {consent.summary}</span>}
          {cells ? <WatchValues cells={cells} /> : !consent && summary && <span className="summary">{summary}</span>}
          {status?.tone === 'error' && <span className="status-error">{status.label}</span>}
          {issues?.length ? <IssueLine issues={issues} /> : null}
        </span>
      </button>
      {expanded && (
        <div className="row-body">
          {issues?.length ? <IssueList issues={issues} /> : null}
          {row.type === 'hit' && <HitDetail row={row} watchTerms={watchTerms} issues={issues} />}
          {row.type === 'datalayer' && <DataLayerDetail row={row} />}
          {row.type === 'interaction' && <InteractionDetail event={row.event} />}
          {row.type === 'nav' && <div className="mono wrap">{row.event.url}</div>}
          {row.type === 'rule' && <RuleDetail row={row} />}
        </div>
      )}
    </div>
  );
});
