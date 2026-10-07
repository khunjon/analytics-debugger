# Analytics Debugger

Chrome MV3 extension (WXT + React + TypeScript). The README covers the architecture, the update flow, how to add a vendor, and the roadmap.

## Deploying

The user runs the extension from `dist/chrome`, loaded unpacked. A Stop hook (`.claude/settings.json` runs `scripts/claude-stop-hook.mjs`) deploys at the end of every turn: typecheck, unit tests, build, then copy into `dist/chrome` with `build.json` written last. The running extension picks it up by itself. If the hook reports a failure, fix it; the user's installed copy stays on the last good build until you do. Never edit `dist/` by hand.

- `npm run deploy` deploys now (no-op if the source is unchanged; `--force` to redo)
- `npm test`, `npm run typecheck`
- `npm run test:e2e` for anything touching capture, storage, the background worker, content scripts, or the update path. It also writes panel screenshots to `test-results/`; look at them after UI changes.

Deploy marks the installed copy as a dev build (named "Analytics Debugger Dev", icons from `scripts/dev-icon/`, plus `unlimitedStorage` for the live-update handoff) by rewriting its manifest; release builds are untouched. Deploy refuses a target folder that isn't empty and has no `build.json`, because it deletes every file there that isn't part of the build. Anything that changes the manifest could leave the user's extension disabled if Chrome rejects it, so try such changes first with `DEPLOY_DIR=<temp dir> node scripts/deploy.mjs --force` and load that folder in Playwright.

Changes to `background.js`, content scripts or the manifest reload the whole extension, which closes the user's side panel. Everything else is a panel-only update that refreshes in place, so prefer keeping logic in the panel. URL matching is in `lib/decoders/match.ts` for that reason: the background bundles only that file, not the decoders.

## Public repo

This is a public GitHub repo (khunjon/analytics-debugger, MIT). Never commit client data: when real hits become test fixtures, replace report suites, measurement IDs, datastream IDs, domains and visitor IDs with made-up values. Releases: bump `version` in `package.json` and push a matching `vX.Y.Z` tag; `.github/workflows/release.yml` publishes the zip.

## Gotchas

- `chrome.storage.session` sorts object keys alphabetically. Anything whose key order matters, like data layer payloads, is stored as a JSON string.
- A tab's timeline is stored as a record (`tab:<id>`) plus its events in chunks by arrival order (`tab:<id>:<chunk>`), so a write touches only what changed. In `background.ts`, a mutation must `touch()` every event it adds or changes, or the change is never written. The panel's rows are cached by event object, which stays the same while its chunk is unchanged; that's what keeps re-renders cheap.
- Adobe Tags calls `_satellite._monitors` without a try/catch, so the monitor in `lib/page-hooks.ts` must never throw.
- Session storage is wiped when the extension reloads. `reloadKeepingTimelines()` in `background.ts` hands the timelines over through `storage.local`; any new session-stored state that should survive an update needs the same treatment.
- Code in `lib/page-hooks.ts` runs inside client sites. It must never throw into the page or change behavior. Wrappers call straight through and never dispatch dynamically, because that causes recursion with GTM's own push wrapper.
- The service worker can stop at any time. `chrome.storage.session` is the source of truth, and the in-memory cache in `background.ts` is only an optimization.
- In Playwright, the service worker appears before its listeners are registered (the e2e helpers wait for `onBeforeRequest.hasListeners()`). Developer mode must also be on, or Chrome disables an unpacked extension that calls `chrome.runtime.reload()`; the helpers turn it on.
- Page events are untrusted: any page script can fire the event the relay forwards. The background rebuilds each one with `sanitizePageEvent()` in `lib/page-event.ts`, which keeps only the fields it lists, so a new field on a page event has to be added there too.
- Decoders are pure and run in the panel. Keep them free of extension APIs so the planned Playwright crawler can reuse them.
- `tsconfig` uses `noUncheckedIndexedAccess` (from WXT).
