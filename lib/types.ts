import type { VendorId } from './decoders/types';

interface BaseEvent {
  id: string;
  /** Epoch ms. Hits use the browser's request timestamp; page events use Date.now() in the page. */
  ts: number;
  pageId: string;
  frameId?: number;
  /** Order of arrival within the tab, assigned by the background. Decides which storage chunk holds the event. */
  seq?: number;
}

/** A network request that one of the decoders recognized. Decoding happens in the panel. */
export interface HitEvent extends BaseEvent {
  kind: 'hit';
  vendor: VendorId;
  requestId: string;
  url: string;
  method: string;
  body?: string;
  resourceType: string;
  status?: number;
  error?: string;
  redirectedFrom?: string;
  /** Seen only when the request finished, so the time is when it completed and a POST body is missing. */
  partial?: boolean;
}

/** Something pushed to a data layer or passed to a tag manager / SDK command. */
export interface DataLayerEvent extends BaseEvent {
  kind: 'datalayer';
  source: string;
  /** JSON text. Kept as a string because chrome.storage reorders object keys alphabetically. */
  payload: string;
  /** Picked up by polling rather than at push time, so the timestamp is approximate. */
  late?: boolean;
}

export interface InteractionEvent extends BaseEvent {
  kind: 'interaction';
  action: 'click' | 'submit';
  text: string;
  selector: string;
  tag: string;
  href?: string;
  dataAttrs?: Record<string, string>;
  /** Dispatched by a script (element.click()) rather than the user. */
  synthetic?: boolean;
}

/** Same-document navigation: history.pushState/replaceState or a hash change. */
export interface NavEvent extends BaseEvent {
  kind: 'nav';
  url: string;
  how: 'history' | 'hash';
}

/**
 * One step of an Adobe Tags rule, from the library's `_satellite._monitors` hooks. A run is reported
 * when it's triggered and again when it completes or stops; `run` ties the two together.
 */
export interface RuleEvent extends BaseEvent {
  kind: 'rule';
  phase: 'triggered' | 'completed' | 'condition-failed' | 'action-failed';
  run: number;
  ruleName: string;
  ruleId?: string;
  /** The condition or action that failed: its module path, e.g. `core/src/lib/conditions/path.js`. */
  component?: string;
  /** That component's settings, as compact JSON. */
  settings?: string;
  negate?: boolean;
}

export type EnvSource = 'adobe-tags' | 'gtm' | 'optimizely';

/** What's loaded on the page (Adobe Tags build, GTM containers, Optimizely experiments). Shown in the page header. */
export interface EnvEvent extends BaseEvent {
  kind: 'env';
  source: EnvSource;
  /** JSON text. */
  payload: string;
}

export type TimelineEvent = HitEvent | DataLayerEvent | InteractionEvent | NavEvent | RuleEvent | EnvEvent;

type FromPage<T> = Omit<T, 'id' | 'pageId' | 'frameId' | 'seq'>;

/** Events sent from the page's content scripts, before the background assigns ids and pages. */
export type PageEvent = FromPage<DataLayerEvent> | FromPage<InteractionEvent> | FromPage<RuleEvent> | FromPage<EnvEvent>;

export interface PageRecord {
  id: string;
  ts: number;
  url: string;
  documentId?: string;
  transition?: string;
  /** False when the page was created from a hit that arrived before its navigation commit event. */
  committed: boolean;
}

export interface TabTimeline {
  tabId: number;
  /** Incremented on every write so the panel can ignore stale reads. */
  rev: number;
  updated: number;
  pages: PageRecord[];
  /** Sorted by time. */
  events: TimelineEvent[];
  /** documentId -> pageId for the page record that document currently belongs to. */
  docToPage: Record<string, string>;
  /** The next event's `seq`. */
  nextSeq: number;
}

/**
 * How a timeline sits in chrome.storage.session: this record under `tab:<id>`, and the events in
 * chunks of CHUNK_SIZE by `seq` under `tab:<id>:<chunk>`, so a new event rewrites one small chunk
 * instead of the whole timeline.
 */
export interface StoredTimeline extends Omit<TabTimeline, 'events'> {
  /** The chunks that hold events. */
  chunks: number[];
}

export const tabKey = (tabId: number) => `tab:${tabId}`;
export const chunkKey = (tabId: number, chunk: number) => `tab:${tabId}:${chunk}`;

export const PAGE_EVENT_NAME = '__analytics_debugger_event__';

export type RuntimeMessage =
  | { type: 'adbg:page-event'; event: PageEvent }
  | { type: 'adbg:clear'; tabId: number }
  /** Panel -> background: a new build is on disk, check whether the extension needs to reload. */
  | { type: 'adbg:check-build' }
  /** Background -> relay: is a live relay running in this tab? */
  | { type: 'adbg:ping' };
