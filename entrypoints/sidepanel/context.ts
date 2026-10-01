import { createContext } from 'react';
import type { PageGroup } from '@/lib/view';

/**
 * The whole timeline, unfiltered, for expanded rows that look at other events (the previous hit, the
 * data layer before a hit). Only expanded details read it, so collapsed rows don't re-render on updates.
 */
export const TimelineContext = createContext<PageGroup[]>([]);
