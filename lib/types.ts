import type { VendorId } from './decoders/types';

interface BaseEvent {
  id: string;
  /** Epoch ms. Hits use the browser's request timestamp; page events use Date.now() in the page. */
  ts: number;
  pageId: string;
  frameId?: number;
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

export type TimelineEvent = HitEvent | DataLayerEvent | InteractionEvent | NavEvent;

/** Events sent from the page's content scripts, before the background assigns ids and pages. */
export type PageEvent =
  | Omit<DataLayerEvent, 'id' | 'pageId' | 'frameId'>
  | Omit<InteractionEvent, 'id' | 'pageId' | 'frameId'>;

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
  events: TimelineEvent[];
  /** documentId -> pageId for the page record that document currently belongs to. */
  docToPage: Record<string, string>;
}

export const tabKey = (tabId: number) => `tab:${tabId}`;

export const PAGE_EVENT_NAME = '__analytics_debugger_event__';

export type RuntimeMessage =
  | { type: 'adbg:page-event'; event: PageEvent }
  | { type: 'adbg:clear'; tabId: number }
  /** Panel -> background: a new build is on disk, check whether the extension needs to reload. */
  | { type: 'adbg:check-build' }
  /** Background -> relay: is a live relay running in this tab? */
  | { type: 'adbg:ping' };
