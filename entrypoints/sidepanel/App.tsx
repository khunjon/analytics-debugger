import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { analyze } from '@/lib/checks';
import { hostOf } from '@/lib/format';
import type { RuntimeMessage } from '@/lib/types';
import { buildGroups, CATEGORIES, filterGroups, HIDDEN_BY_DEFAULT, rowCategory, type Category } from '@/lib/view';
import { TimelineContext } from './context';
import { useLiveUpdates, useStableArray, useStableIssues, useTargetTab, useTimeline } from './hooks';
import { PageSection } from './PageSection';

const HIDDEN_KEY = 'adbg.hidden';
const QUERY_KEY = 'adbg.query';
/** Before the hidden list, the shown chips were saved, from this set. */
const LEGACY_FILTERS_KEY = 'adbg.filters';
const LEGACY_CATEGORIES: Category[] = ['adobe-analytics', 'adobe-websdk', 'ga4', 'datalayer', 'interaction', 'nav'];

/** Hidden categories are saved rather than shown ones, so categories added later start out visible. */
function loadHidden(): Set<Category> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (raw) return new Set(JSON.parse(raw) as Category[]);
    const legacy = localStorage.getItem(LEGACY_FILTERS_KEY);
    if (legacy) {
      const shown = new Set(JSON.parse(legacy) as Category[]);
      return new Set([...LEGACY_CATEGORIES.filter((c) => !shown.has(c)), ...HIDDEN_BY_DEFAULT]);
    }
  } catch {
    /* storage unavailable */
  }
  return new Set(HIDDEN_BY_DEFAULT);
}

function useToggleSet(initial: () => Set<string>) {
  const [set, setSet] = useState(initial);
  const toggle = useCallback((id: string) => {
    setSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  return [set, toggle, setSet] as const;
}

export function App() {
  const { tabId, tab, pinned } = useTargetTab();
  const timeline = useTimeline(tabId);
  const justUpdated = useLiveUpdates();
  const [hidden, setHidden] = useState(loadHidden);
  // Kept for the panel's lifetime, including in-place refreshes after an update.
  const [query, setQuery] = useState(() => {
    try {
      return sessionStorage.getItem(QUERY_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const updateQuery = (value: string) => {
    setQuery(value);
    try {
      sessionStorage.setItem(QUERY_KEY, value);
    } catch {
      /* storage unavailable */
    }
  };
  const [expanded, toggleExpanded, setExpanded] = useToggleSet(() => new Set());
  const [collapsed, togglePage] = useToggleSet(() => new Set());

  const groups = useMemo(() => (timeline ? buildGroups(timeline) : []), [timeline]);
  const byPage = useMemo(() => new Map(groups.map((g) => [g.page.id, g])), [groups]);
  const issues = useStableIssues(useMemo(() => analyze(groups), [groups]));
  const enabled = useMemo(() => new Set(CATEGORIES.map((c) => c.id).filter((id) => !hidden.has(id))), [hidden]);
  const { groups: visible, terms, watch } = useMemo(() => filterGroups(groups, enabled, query), [groups, enabled, query]);
  const watchTerms = useStableArray(terms.watch);
  const counts = useMemo(() => {
    const c = new Map<Category, number>();
    for (const g of groups) for (const r of g.rows) c.set(rowCategory(r), (c.get(rowCategory(r)) ?? 0) + 1);
    return c;
  }, [groups]);

  const toggleCategory = (id: Category) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };

  // Follow new events while scrolled to the bottom; stop following once the user scrolls up or opens a row.
  const listRef = useRef<HTMLElement>(null);
  const follow = useRef(true);
  const rowCount = visible.reduce((n, g) => n + g.rows.length, 0);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [rowCount, visible.length]);
  const onScroll = () => {
    const el = listRef.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const toggleRow = useCallback(
    (key: string) => {
      follow.current = false;
      toggleExpanded(key);
    },
    [toggleExpanded],
  );

  const clear = () => {
    if (tabId == null) return;
    const msg: RuntimeMessage = { type: 'adbg:clear', tabId };
    void browser.runtime.sendMessage(msg);
    setExpanded(new Set());
  };

  const popOut = () => {
    if (tabId == null) return;
    void browser.windows.create({
      url: `${browser.runtime.getURL('/sidepanel.html')}?tabId=${tabId}`,
      type: 'popup',
      width: 560,
      height: 900,
    });
  };

  // Chrome hides the URL of pages the extension can't access (chrome://, the Web Store), so a loaded
  // tab without one can't be inspected.
  const tabUrl = tab?.url || tab?.pendingUrl;
  const inspectable = !tab || (tabUrl != null && /^https?:/.test(tabUrl));
  const hasEvents = groups.some((g) => g.rows.length > 0);

  return (
    <TimelineContext.Provider value={groups}>
      <div className="app">
        <header className="toolbar">
          <div className="toolbar-row">
            <div className="tab-info" title={tab?.url}>
              <span className="tab-host">{hostOf(tab?.url) || 'No tab'}</span>
              {pinned && <span className="pill">pinned to tab</span>}
              {justUpdated && <span className="pill updated">updated</span>}
            </div>
            {!pinned && (
              <button type="button" className="tool" onClick={popOut} title="Open this tab's timeline in its own window">
                Pop out
              </button>
            )}
            <button type="button" className="tool" onClick={clear} title="Clear captured events for this tab">
              Clear
            </button>
          </div>
          <input
            className="search"
            type="search"
            aria-label="Search events or watch variables"
            placeholder="Search, or watch variables: eVar12, events, page_location"
            value={query}
            onChange={(e) => updateQuery(e.target.value)}
          />
          {terms.watch.length > 0 && (
            <div className="watch-hint">
              Watching{' '}
              {terms.watch.map((t) => (
                <code key={t}>{t}</code>
              ))}
              {terms.text.length > 0 && (
                <>
                  {' '}
                  · filtering{' '}
                  {terms.text.map((t) => (
                    <code key={t}>{t}</code>
                  ))}
                </>
              )}
              <span className="hint-note">Quote a term to search it as text.</span>
            </div>
          )}
          <div className="chips" role="group" aria-label="Show event types">
            {CATEGORIES.filter((c) => counts.get(c.id)).map((c) => (
              <button
                type="button"
                key={c.id}
                className={`chip cat-${c.id}`}
                aria-pressed={enabled.has(c.id)}
                onClick={() => toggleCategory(c.id)}
              >
                {c.label}
                <span className="count">{counts.get(c.id)}</span>
              </button>
            ))}
          </div>
        </header>

        <main className="list" ref={listRef} onScroll={onScroll}>
          {!inspectable ? (
            <div className="empty">Chrome doesn't let extensions inspect this page. Switch to a website tab.</div>
          ) : !hasEvents ? (
            <div className="empty">
              <p>Nothing captured on this tab yet.</p>
              <p>
                <strong>Reload the page</strong> to capture its page-load hits.
              </p>
            </div>
          ) : null}
          {inspectable &&
            visible.map((g, i) => (
              <PageSection
                key={g.page.id}
                group={g}
                full={byPage.get(g.page.id) ?? g}
                isLatest={i === visible.length - 1}
                collapsed={collapsed.has(g.page.id)}
                onTogglePage={togglePage}
                expanded={expanded}
                onToggleRow={toggleRow}
                watchTerms={watchTerms}
                watch={watch}
                issues={issues}
              />
            ))}
        </main>
      </div>
    </TimelineContext.Provider>
  );
}
