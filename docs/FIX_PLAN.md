# Storyteller — Fix, Cleanup & Restructure Plan (for Opus)

*Companion to `ANALYSIS.md` (issue IDs B1–B8, S1–S8 refer to it). Written to be executed phase-by-phase; each phase leaves the app shippable.*

## Progress (updated 2026-07-02)

**Phase 0 and all of Phase 1 are complete** and on branch `claude/website-analysis-vosk-plan-l5gxkh`, each verified in headless Chromium:

- ✅ **0.2** Monolith split into `index.html` + `css/main.css` + `js/app.js` (behavior-identical).
- ✅ **0.3/0.4** Toolchain added: `package.json`, ESLint (`no-undef` gate), Prettier, `scripts/check-dom-ids.mjs` (zero-dep guard, now green), `scripts/smoke-test.mjs`, `docs/TESTING.md`.
- ✅ **1.1 (B1)** Speech-recognition restart loop bounded (exponential backoff, cap 8, persistent banner).
- ✅ **1.2 (B2)** Version-key data loss fixed (fixed key + in-JSON `schemaVersion` + legacy-key migration).
- ✅ **1.3 (B3)** Local audio persisted in IndexedDB; auto-rehydrates on load, no per-session relink.
- ✅ **1.4 (B4)** Null-element crashes and 24 dead references fixed (incl. YouTube pagination TypeError, undefined `masterGainNode`, and the `playSound`-out-of-scope queue-drain bug).
- ✅ **1.5 (B6)** XSS closed: `escapeHtml()` applied at all book-string `innerHTML` sinks; verified with payloads in every field.
- ✅ **1.7 (B8)** `file://` Spotify redirect handled gracefully. **B7** was already fixed in current code (soundtrack list uses `data-id`).

**Remaining (not yet done): Phase 2 (vendor CDNs / offline shell), Phase 3 (modularize `app.js`, render hot-path, dead-code sweep), Phase 4 (distribution).** Note Phase 2 vendoring needs network access to the CDNs to fetch the libraries, which was blocked in the analysis/execution sandbox. The ~15 remaining ESLint `no-undef` findings (implicit globals, `typeof`-guarded optional functions) are catalogued for the Phase 3 cleanup.

## Ground rules for the executing agent

1. **Never do a big-bang rewrite.** The app has no tests; every phase must end with the manual smoke checklist (§Verification) passing.
2. **One commit per numbered step**, descriptive message, so regressions can be bisected — replacing the current "Add files via upload" history (S7).
3. **Preserve the save-file format.** `.story` JSON files and the in-localStorage book shape are the user's data contract. Additive changes only, with defaults on load.
4. **Keep it dependency-light.** This is a hobbyist-distributed app; no framework migration (no React/Vue). Vanilla JS + a build step is the right size.

---

## Phase 0 — Safety net (do first, ~1 session)

**0.1 Snapshot & branch.** Tag current `main` as `v25.8-legacy`. All work on feature branches.

**0.2 Extract the monolith into files *without changing behavior*.** Split `index.html` into:

```
/index.html          (markup only, ~2k lines incl. modals)
/css/main.css        (the 3.2k-line <style> block)
/js/app.js           (the <script> block, verbatim)
/assets/…            (brick_wall, torch, icons)
```

This is a mechanical cut-paste (script stays one file for now) but instantly makes diffs reviewable and editing cheap. Verify byte-identical behavior.

**0.3 Add a minimal toolchain.** `package.json` with: `vite` (dev server + production build), `eslint` (no-undef alone would have caught every B4 bug), `prettier`. Add `npm run dev`, `npm run build`, `npm run lint`. Vite also solves `file://` distribution: ship a `dist/` the user can serve with one command, and later a PWA (Phase 4).

**0.4 Smoke-test checklist** written into `docs/TESTING.md` (see §Verification) — run it now to baseline.

## Phase 1 — Critical bug fixes (highest user pain first)

**1.1 (B1) Bound the speech-recognition restart loop.**
In `recognition.onerror`/`onend` (lines ~6088–6180):
- Add exponential backoff (500 ms → 1 s → 2 s → … cap 30 s) and a max of ~8 consecutive failed restarts, after which stop, set `recognitionStarted = false`, and show a persistent (non-toast) error banner with the actual cause ("Microphone unavailable" / "Speech service unreachable — Chrome's speech recognition requires internet; see offline mode").
- Reset the failure counter on any successful `onresult`.
- Treat `network` errors specially: after 2 failures, suggest the Vosk offline engine (see `VOSK_PLAN.md`).

**1.2 (B2) Stop losing user books on upgrade.**
- Change to a fixed key `storytellerBookData` plus a `schemaVersion` field *inside* the JSON.
- On boot, if the fixed key is empty, scan `localStorage` for any key matching `/^storytellerBookData_v/`, load the newest, migrate, write to the fixed key, and keep the old key as backup.
- Add a `migrations` map keyed by `schemaVersion` for future shape changes.

**1.3 (B3) Persist local audio in IndexedDB.**
- On file selection/relink, store the raw file bytes (`Blob`) in an IndexedDB object store keyed by a content hash (dedup) with `{name, size, lastModified}`.
- Book sources store the hash; on load, hydrate `AudioBuffer`s lazily from IndexedDB (decode on first play to keep boot fast).
- Keep the relink flow as fallback for missing hashes. Show storage usage (`navigator.storage.estimate()`) in settings, plus a "clear audio cache" button and `navigator.storage.persist()` request.
- This also retires the localStorage-quota concern for audio (S8).

**1.4 (B4) Fix null-element crashes and the variations editor.**
- Fix the guaranteed crash: `youtubePaginationTop` usage at line 15636 (either restore the top-pagination markup or delete the four dead references and consts at 5585/5598/5599).
- Restore the variation source editor: re-add the `sourceVariationFile` / `sourceVariationYoutubeUrl` / `sourceVariationSyrinscape*` inputs to `variationSettingsModal` (markup exists for the analogous Add-Page fields to copy from), or explicitly remove source-editing from variations and delete the orphan JS (7655–7662, 15275–15286, 16853) and CSS (954–963). Decide by checking the guidebook text for what the feature promises. **Recommended: restore the inputs** — the data model supports per-variation sources and users' saved books rely on it.
- Delete the remaining dead references (`exportChapterButton`*, `importChapterInput`, `importCollectionsInput`, `settingKeepAlive`, `settingsEnableBackgroundKeepAlive`, `appendixTriggerTagSelect`, `plotThreadConditionSearchInput/List`) or reconnect them if the corresponding buttons should exist. *Note line 7441 claims the export listener is set in `initializeApp` — verify before deleting.
- Add `eslint` + a tiny CI script that regenerates the ID cross-reference check (a 20-line Node script: parse `getElementById('…')` calls, fail if the ID isn't in the markup or created via template) so this class of bug can't return.

**1.5 (B6) Escape all user data at render time.**
- Add `escapeHtml()` and apply it at every one of the 39 `innerHTML = \`…\`` sites for any interpolated user string (page titles, keywords, chapter/collection/soundtrack/appendix names, YouTube titles, file names).
- Prefer converting hot templates to `createElement` + `textContent` during Phase 3's render refactor; escaping is the stopgap.
- On `.story` import, additionally sanitize string fields (strip `<`/`>` or validate against a schema — see 3.4).

**1.6 (B7) De-duplicate generated IDs** in the soundtrack list template (switch to `data-st-id` attributes + delegated listeners).

**1.7 (B8) Fix `file://` Spotify redirect.** Detect `location.protocol === 'file:'` and disable the Spotify connect button with an explanatory tooltip ("requires the hosted version"), instead of producing a broken `null/` redirect URI.

## Phase 2 — Kill the CDN single point of failure (B5)

**2.1 Vendor all runtime dependencies locally** under `/vendor/`: Fuse.js (pin a version), Font Awesome subset (or replace with inline SVG sprite of the ~40 icons actually used — grep `fa-` classes), Cinzel/Inter WOFF2 files.

**2.2 Replace the Tailwind CDN runtime with a build-time Tailwind pass** (Vite plugin). Content-scan the markup/JS, emit a static `tailwind.css`. This removes a ~300 KB runtime script, the flash-of-unstyled-content, and the dev-only-tool-in-prod problem in one step.

**2.3 Lazy-load integration scripts.** Syrinscape `integration.js`/`player.js` and the YouTube IFrame API should load on demand: Syrinscape only when a token is configured or a Syrinscape source exists; YouTube on first YouTube source/search. Guard with timeouts and surface load failures in the UI instead of silently breaking.

**2.4 Offline-first shell.** Add a service worker precaching the app shell (HTML/CSS/JS/fonts/icons/textures). After this step the app fully boots, styled, with search, with zero network — only YouTube/Syrinscape/Spotify/browser-STT features degrade (each with a visible "requires internet" state). This is also the foundation Vosk needs.

## Phase 3 — Structure & efficiency (S1–S5, S8)

**3.1 Split `app.js` into ES modules** (Vite makes this free). Proposed decomposition, following the seams that already exist:

```
js/
  main.js            bootstrap, DOMContentLoaded, initializeApp
  state/book.js      getDefaultBook, load/save/migrate, import/export
  state/store.js     tiny pub/sub: mutate book → emit events → views re-render
  speech/engine.js   SpeechEngine interface + WebSpeechEngine (see VOSK_PLAN.md)
  speech/matcher.js  updateFuseIndex, findBestMatch, checkForKeywords
  audio/player.js    playSound, activeSounds registry, stopAllSounds, gain graph
  audio/files.js     IndexedDB blob store, decode cache, relink
  integrations/youtube.js / syrinscape.js / spotify.js
  ui/pageList.js     renderPageList/createPageListItem
  ui/modals.js       generic modal open/close, per-modal controllers
  ui/plotter.js      story plotter canvas
  ui/soundtrack.js   soundtrack bar + playlists
  util/dom.js        $, escapeHtml, delegation helpers
  util/log.js        leveled logger (silences the 310 console.logs in prod)
```

Move incrementally: one module per commit, `main.js` keeps re-exporting so untouched code still finds its globals; finish by deleting the compatibility shims.

**3.2 Break up the giant functions** while moving them (each move is the natural moment): `checkForKeywords` (359 lines) → `checkStopPhrases` / `checkTimeTransitions` / `checkChapterTransitions` / `matchPages` / `handleCompound`; `playSound` (323) → per-source-type `playFileSource` / `playYouTubeSource` / `playSyrinscapeSource` + shared lifecycle; `loadBookFromFile`/`loadFromLocalStorage` share one `hydrateBook(json)`.

**3.3 Fix the render hot path (S2).**
- Introduce dirty-flagging: sound start/stop should update only the affected page item (`updatePageItemPlayingState(pageId)`), not rebuild the whole list. `renderPageList` full rebuild only on structural changes (add/remove/reorder/chapter switch).
- Use one delegated click/input listener on `pageListUl` instead of per-item listeners.
- Deduplicate the O(n²) reverse-lookup loops at 7516–7532 (iterate `Object.entries(activeSounds)`).

**3.4 Define the book schema** (`docs/SCHEMA.md` + a `validateBook()` used on every import) — this documents the data contract, powers safe migrations (1.2), and doubles as the sanitizer (1.5).

**3.5 Cleanup pass.** Remove AI-residue comments, changelog comments, duplicated blocks (double "Stop Phrases Check"), dead CSS (verify with a coverage pass), commented-out code. Convert remaining `console.log`s to the leveled logger. Compress `brick_wall.png` → WebP (~666 KB → <100 KB) and serve `torch.apng` appropriately (S6).

## Phase 4 — Distribution & polish

- **4.1 GitHub Pages deploy** of `dist/` (answers B8: real origin for Spotify, PWA installable, service worker offline). Keep a "download offline bundle" zip with a one-line static server script for users who want fully local.
- **4.2 Rewrite `README.txt` → `README.md`**: what it is, hosted link, offline install, browser support matrix (Web Speech = Chrome/Edge; Vosk = all), contribution notes.
- **4.3 Accessibility pass**: buttons currently rely on Font Awesome glyphs — add `aria-label`s; modal focus traps; `prefers-reduced-motion` for the torch animation.
- **4.4 Optional:** basic Playwright smoke test in CI running the §Verification checklist headlessly (the analysis already produced a working harness for this — fake mic, console-error capture).

## Verification checklist (run after every phase)

1. Fresh profile: app boots with zero console errors; default book created.
2. Load sample book (`storyteller-sample-book.json`); pages render; search filters.
3. Add page with local audio file → plays; reload → **still plays without relink** (post-1.3).
4. Toggle listening with mic: speak a keyword → sound triggers; speak stop phrase → stops.
5. Unplug mic / block permission → app shows a bounded, clear error; **no restart loop** (post-1.1).
6. DevTools offline mode: app boots styled, search works (post-2.4); speech shows guidance.
7. YouTube search with API key: results, pagination, add source, playback, no TypeErrors (post-1.4).
8. Create/edit a source variation end-to-end (post-1.4).
9. Import a `.story` containing `<img src=x onerror=alert(1)>` in a page title → renders inert text (post-1.5).
10. Export book, wipe storage, re-import → identical behavior.
11. Bump `schemaVersion` in a copy → migration path loads it (post-1.2).

## Suggested execution order & effort

| Phase | Effort | Risk | Value |
|---|---|---|---|
| 0 | S | Low | Unblocks everything |
| 1.1–1.2 | S | Low | Stops active harm |
| 1.3 | M | Medium | Biggest UX win in the plan |
| 1.4–1.7 | M | Low | Kills crashes + XSS |
| 2 | M | Low | True offline, faster load |
| 3 | L | Medium | Maintainability; do incrementally |
| 4 | S–M | Low | Distribution & reach |

Vosk offline speech (see `VOSK_PLAN.md`) slots in after Phase 2 (needs the service worker / hosting story) and benefits from Phase 3.1's `speech/engine.js` seam — but its adapter can be built any time after 1.1.
