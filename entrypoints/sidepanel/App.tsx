import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import { readBuild, type BuildInfo } from '@/lib/live-update';
import { tabKey, type RuntimeMessage, type TabTimeline } from '@/lib/types';
import { buildGroups, CATEGORIES, filterGroups, rowCategory, type Category } from '@/lib/view';
import { PageSection } from './PageSection';

const FILTERS_KEY = 'adbg.filters';

function loadFilters(): Set<Category> {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (raw) return new Set(JSON.parse(raw) as Category[]);
  } catch {
    /* storage unavailable */
  }
  return new Set(CATEGORIES.map((c) => c.id));
}

/** The tab to show: `?tabId=` when popped out, otherwise whichever tab is active in this window. */
function useTargetTab() {
  const pinned = useMemo(() => {
    const v = new URLSearchParams(location.search).get('tabId');
    return v ? Number(v) : null;
  }, []);
  const [tabId, setTabId] = useState<number | null>(pinned);
  const [tab, setTab] = useState<Browser.tabs.Tab | null>(null);

  useEffect(() => {
    if (pinned != null) return;
    let windowId: number | undefined;
    const onActivated = (info: { tabId: number; windowId: number }) => {
      if (info.windowId === windowId) setTabId(info.tabId);
    };
    void browser.windows.getCurrent().then(async (w) => {
      windowId = w.id;
      const [active] = await browser.tabs.query({ active: true, windowId: w.id });
      if (active?.id != null) setTabId(active.id);
    });
    browser.tabs.onActivated.addListener(onActivated);
    return () => browser.tabs.onActivated.removeListener(onActivated);
  }, [pinned]);

  useEffect(() => {
    if (tabId == null) return;
    browser.tabs.get(tabId).then(setTab, () => setTab(null));
    const onUpdated = (id: number, _info: unknown, t: Browser.tabs.Tab) => {
      if (id === tabId) setTab(t);
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => browser.tabs.onUpdated.removeListener(onUpdated);
  }, [tabId]);

  return { tabId, tab, pinned: pinned != null };
}

function useTimeline(tabId: number | null): TabTimeline | null {
  const [timeline, setTimeline] = useState<TabTimeline | null>(null);
  useEffect(() => {
    setTimeline(null);
    if (tabId == null) return;
    const key = tabKey(tabId);
    let latestRev = -1;
    const accept = (t: TabTimeline | undefined) => {
      if (!t) {
        latestRev = -1;
        setTimeline(null);
      } else if (t.rev >= latestRev) {
        latestRev = t.rev;
        setTimeline(t);
      }
    };
    void browser.storage.session.get(key).then((r) => accept(r[key] as TabTimeline | undefined));
    const listener = (changes: Record<string, Browser.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[key]) accept(changes[key].newValue as TabTimeline | undefined);
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, [tabId]);
  return timeline;
}

const UPDATED_FLAG = 'adbg.updated';

/**
 * Refresh the panel in place when only panel code changed. When background or content scripts changed,
 * nudge the background, which reloads the whole extension (closing this panel) and keeps the timelines.
 * Returns true for a few seconds after an in-place refresh.
 */
function useLiveUpdates(): boolean {
  const [justUpdated, setJustUpdated] = useState(() => {
    try {
      const flagged = sessionStorage.getItem(UPDATED_FLAG) != null;
      sessionStorage.removeItem(UPDATED_FLAG);
      return flagged;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!justUpdated) return;
    const t = setTimeout(() => setJustUpdated(false), 4000);
    return () => clearTimeout(t);
  }, [justUpdated]);

  useEffect(() => {
    let loaded: BuildInfo | undefined;
    const check = async () => {
      const build = await readBuild();
      if (!build) return;
      if (!loaded) {
        loaded = build;
      } else if (build.core !== loaded.core) {
        const msg: RuntimeMessage = { type: 'adbg:check-build' };
        void browser.runtime.sendMessage(msg).catch(() => {});
      } else if (build.panel !== loaded.panel) {
        try {
          sessionStorage.setItem(UPDATED_FLAG, '1');
        } catch {
          /* storage unavailable */
        }
        location.reload();
      }
    };
    void check();
    const id = setInterval(check, 1000);
    return () => clearInterval(id);
  }, []);

  return justUpdated;
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function App() {
  const { tabId, tab, pinned } = useTargetTab();
  const timeline = useTimeline(tabId);
  const justUpdated = useLiveUpdates();
  const [filters, setFilters] = useState(loadFilters);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const groups = useMemo(() => (timeline ? buildGroups(timeline) : []), [timeline]);
  const visible = useMemo(() => filterGroups(groups, filters, query), [groups, filters, query]);
  const counts = useMemo(() => {
    const c = new Map<Category, number>();
    for (const g of groups) for (const r of g.rows) c.set(rowCategory(r), (c.get(rowCategory(r)) ?? 0) + 1);
    return c;
  }, [groups]);

  const toggleFilter = (id: Category) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(FILTERS_KEY, JSON.stringify([...next]));
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

  const toggleRow = useCallback((key: string) => {
    follow.current = false;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const togglePage = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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

  const inspectable = !tab?.url || /^https?:/.test(tab.url);
  const hasEvents = groups.some((g) => g.rows.length > 0);

  return (
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
          placeholder="Search events, variables, values…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="chips" role="group" aria-label="Show event types">
          {CATEGORIES.map((c) => (
            <button
              type="button"
              key={c.id}
              className={`chip cat-${c.id}`}
              aria-pressed={filters.has(c.id)}
              onClick={() => toggleFilter(c.id)}
            >
              {c.label}
              <span className="count">{counts.get(c.id) ?? 0}</span>
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
              <strong>Reload the page</strong> to capture its page-load hits. Clicks and data layer pushes are
              picked up on pages loaded after the extension was installed or updated.
            </p>
          </div>
        ) : null}
        {inspectable &&
          visible.map((g, i) => (
            <PageSection
              key={g.page.id}
              group={g}
              isLatest={i === visible.length - 1}
              collapsed={collapsed.has(g.page.id)}
              onTogglePage={togglePage}
              expanded={expanded}
              onToggleRow={toggleRow}
            />
          ))}
      </main>
    </div>
  );
}
