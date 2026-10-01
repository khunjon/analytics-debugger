import { browser } from 'wxt/browser';

/**
 * Written by scripts/deploy.mjs into the installed copy (dist/chrome), after every other file.
 * `core` hashes the files that need a full extension reload (manifest, background, content scripts);
 * `panel` hashes the side panel. Absent from zips built for sharing, which turns live updates off.
 */
export interface BuildInfo {
  source: string;
  core: string;
  panel: string;
  builtAt: number;
}

/** Timelines saved by an instance about to reload itself, restored by the next one. */
export const HANDOFF_KEY = 'adbg:handoff';
/** The `core` hash this extension instance was loaded with. Session storage is cleared on reload. */
export const LOADED_CORE_KEY = 'adbg:loadedCore';

const buildUrl = (browser.runtime.getURL as (path: string) => string)('/build.json');

/** Unpacked extensions read their files from disk on every request, so this sees new deploys. */
export async function readBuild(): Promise<BuildInfo | null> {
  try {
    const res = await fetch(buildUrl, { cache: 'no-store' });
    return res.ok ? ((await res.json()) as BuildInfo) : null;
  } catch {
    return null;
  }
}
