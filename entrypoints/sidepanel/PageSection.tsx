import type { Issue } from '@/lib/checks';
import { displayUrl, shortDate } from '@/lib/format';
import { pageToMarkdown, pageToWatchMarkdown } from '@/lib/markdown';
import { clockTime, type PageEnv, type PageGroup } from '@/lib/view';
import type { WatchCell } from '@/lib/watch';
import { EventRow } from './EventRow';
import { useCopy } from './hooks';

/** Rows this soon after a click (and before the next one) are drawn as its effects. */
const CAUSE_WINDOW_MS = 2000;

/** One line per library: Adobe Tags build and environment, GTM containers, active Optimizely experiments. */
function EnvLines({ env }: { env: PageEnv }) {
  const tags = env['adobe-tags'];
  const gtm = env.gtm;
  const optimizely = env.optimizely;
  if (!tags && !gtm && !optimizely?.active.length) return null;
  return (
    <div className="page-env">
      {tags && (
        <div title={`Turbine ${tags.turbineVersion ?? 'unknown'}${tags.propertyId ? ` · ${tags.propertyId}` : ''}`}>
          <span className="env-label">Adobe Tags</span> {tags.property ?? '(unnamed property)'}
          {tags.environment && (
            <span className={`tag ${tags.environment === 'production' ? '' : 'nonprod'}`}>{tags.environment}</span>
          )}
          {tags.buildDate && <span className="env-note"> built {shortDate(tags.buildDate)}</span>}
        </div>
      )}
      {gtm && (
        <div>
          <span className="env-label">Google</span>{' '}
          {gtm.containers.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ', '}
              {c.id}
              {c.environment && <span className="tag nonprod">{c.environment}</span>}
              {c.preview && <span className="tag nonprod">preview</span>}
            </span>
          ))}
        </div>
      )}
      {optimizely?.active.length ? (
        <div>
          <span className="env-label">Optimizely</span>{' '}
          {optimizely.active
            .map((a) => `${a.experiment ?? a.experimentId} → ${a.variation ?? a.variationId ?? '?'}${a.holdback ? ' (holdback)' : ''}`)
            .join(', ')}
        </div>
      ) : null}
    </div>
  );
}

interface PageSectionProps {
  group: PageGroup;
  /** The page's events before filtering, for the header's counts. */
  full: PageGroup;
  isLatest: boolean;
  collapsed: boolean;
  onTogglePage: (id: string) => void;
  expanded: Set<string>;
  onToggleRow: (key: string) => void;
  watchTerms: string[];
  watch: Map<string, WatchCell[]>;
  issues: Map<string, Issue[]>;
}

export function PageSection({
  group,
  full,
  isLatest,
  collapsed,
  onTogglePage,
  expanded,
  onToggleRow,
  watchTerms,
  watch,
  issues,
}: PageSectionProps) {
  const { page, rows } = group;
  const { copied, copy } = useCopy();
  // Analytics events (hits); data layer pushes, clicks, rules and navigation aren't counted.
  const events = full.rows.filter((r) => r.type === 'hit').length;
  const flagged = full.rows.filter((r) => issues.get(r.key)?.some((i) => i.level !== 'info')).length;
  let cause: number | undefined;
  return (
    <section className={`page${isLatest ? ' latest' : ''}`}>
      <div className="page-header">
        <div className="page-header-row">
          <button
            type="button"
            className="page-toggle"
            onClick={() => onTogglePage(page.id)}
            aria-expanded={!collapsed}
            title={page.url}
          >
            <span className="caret" aria-hidden>
              {collapsed ? '▸' : '▾'}
            </span>
            <span className="page-url">{displayUrl(page.url)}</span>
          </button>
          <span className="page-meta" title={new Date(page.ts).toLocaleString()}>
            {clockTime(page.ts).slice(0, 8)} · {events} event{events === 1 ? '' : 's'}
            {flagged > 0 && (
              <span className="page-issues" title="Rows with warnings or errors on this page">
                {' '}
                · ▲ {flagged}
              </span>
            )}
          </span>
          <button
            type="button"
            className="link"
            title={watchTerms.length ? 'Copy the watched values as a Markdown table' : 'Copy this page as Markdown'}
            onClick={() =>
              copy(watchTerms.length ? pageToWatchMarkdown(group, watchTerms, watch) : pageToMarkdown(group, issues), page.id)
            }
          >
            {copied === page.id ? 'Copied' : 'Copy'}
          </button>
        </div>
        {!collapsed && <EnvLines env={full.env} />}
      </div>
      {!collapsed &&
        (rows.length ? (
          rows.map((row) => {
            const nested = row.type !== 'interaction' && cause !== undefined && row.ts - cause <= CAUSE_WINDOW_MS;
            if (row.type === 'interaction') cause = row.ts;
            return (
              <EventRow
                key={row.key}
                row={row}
                pageTs={page.ts}
                expanded={expanded.has(row.key)}
                onToggle={onToggleRow}
                cells={watch.get(row.key)}
                watchTerms={watchTerms}
                issues={issues.get(row.key)}
                nested={nested}
              />
            );
          })
        ) : (
          <div className="no-rows">No matching events on this page.</div>
        ))}
    </section>
  );
}
