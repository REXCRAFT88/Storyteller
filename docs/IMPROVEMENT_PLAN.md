# Storyteller — UI, Functionality & Feature Improvement Plan (for Opus 4.8)

*Written 2026-07-06, after the appendix/slider/compound-phrasing troubleshooting session. Companion to `FIX_PLAN.md` (bugs/tech-debt, mostly complete) — this plan is about making the app **better**, not just correct. Phases are ordered by value to a GM running a live session; each phase leaves the app shippable.*

## Progress (updated 2026-07-06)

**Settings reorganized into tabs** (Speech / Audio / Integrations / Advanced), per request. The Audio tab also hosts a Crossfade Transitions toggle + duration slider (UI in place; engine lands in Phase 2.1).

**Phase 1 complete** — all verified in headless Chromium, each its own commit:
- ✅ **1.1** Trigger history panel below the transcript: records what each phrase caused (matched pages + keyword + confidence, chapter/time transitions, appendix, stop phrases); click a matched page to play/stop it.
- ✅ **1.2** "Test a Phrase" matcher playground: runs the real pipeline in a `matchDryRun` mode (every side effect suppressed) to show what a typed phrase would trigger without playing anything.
- ✅ **1.3** Undo for page/chapter/collection/appendix/soundtrack deletes (8s snackbar + Ctrl+Z, depth 10); native `confirm()` dialogs removed. Also guarded a pre-existing `book.appendix.push` load crash.
- ✅ **1.4** Page hotkeys: bind a key in the Edit Page modal (persisted), press it anywhere outside inputs to play/stop; badge on the page item.
- ✅ **1.5** Duck-all button + Ctrl+D: drops all audio to 20% for table talk via a global `duckFactor`/`masterFrac()` without moving the master slider.

**Next: Phase 2 (audio polish).** Note the Fuse.js CDN dependency means page-keyword matching can't be exercised in the `file://` sandbox (only stop/time/chapter/appendix outcomes were testable there) — verify the playground's page matches in a served/online context, and prioritize Phase 4.1 (vendor CDNs) to unblock offline use + local testing.

## Ground rules for the executing agent

1. **One commit per numbered step.** Run `node --check js/app.js`, `node scripts/check-dom-ids.mjs`, and `node scripts/smoke-test.mjs` before every commit (Playwright JS package installs with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i --no-save playwright`; Chromium is at `/opt/pw-browsers/chromium` in the cloud sandbox).
2. **Preserve the `.story` data contract.** Additive schema changes only, defaults on load, update `docs/SCHEMA.md` and `saveToLocalStorage()`'s explicit field lists (a `timeOfDay` field was silently dropped there once already — grep for the variation-mapping block before adding any new persisted field).
3. **No frameworks.** Vanilla JS + the existing patterns. New UI must use `escapeHtml()` for user strings and the existing RPG theme classes (`btn-rpg`, `rpg-toggle-switch`, `modal`).
4. **Verify in the browser, not just by reading.** This codebase has decayed before precisely because edits weren't exercised. Drive every new UI path headlessly before committing (the smoke test file shows the harness pattern; `#loadFileInput` + `#confirmLoadButton` loads the sample book).
5. **The GM-at-the-table test.** Every change should be judged by: does this help someone narrating to five friends with one hand on their notes? Latency, glanceability, and recoverability beat configurability.

---

## Phase 1 — Session insight & recovery (highest GM pain)

The recurring user complaints ("fireplace triggered and I don't know why", "it heard *boat*", "sounds played in the wrong order") all reduce to one problem: **the app makes decisions the GM can't see or undo.** This phase makes the matcher observable and mistakes cheap.

**1.1 Transcript & trigger history panel.**
A collapsible panel (below `#transcriptDisplay`) listing the last ~50 utterances, newest first. Each row: timestamp, the transcript text, and *what it caused* — matched page(s) with the matched keywords, confidence, chapter transitions, appendix firings, stop phrases, or "no match". Data source: instrument the single seam `checkForKeywords()` (and the appendix/chapter/soundtrack trigger sites it calls) to push structured events into a ring buffer — the plumbing mirrors the existing `logBuffer`/`pushLogBuffer` pattern at the top of `app.js`, but structured (`{ts, text, results: [{type, pageId, keyword, confidence}]}`) rather than strings. Clicking a row's matched page plays/stops it (re-uses `playPageManually`). This is the single highest-value item in the plan: it turns every false trigger from a mystery into a diagnosis.

**1.2 Matcher playground ("Test a Phrase").**
A small modal (toolbar flask icon next to the Appendix button): a text input where the GM types a phrase and sees exactly what *would* happen — best match, all candidate pages with matched keywords + confidence scores, primary-key gate pass/fail per page, which appendix/chapter/stop/time-transition rules would fire — **without playing anything**. Implementation: add a `dryRun = false` parameter threaded through `checkForKeywords` → `findBestMatch` that collects the same structured events as 1.1 into a result object and suppresses all side effects (`playSound`, `executeAppendixEntry`, `setActiveChapter`, `toggleTimeOfDay`, cooldowns, word consumption). Keep the diff honest: side-effect suppression must be at the call sites inside `checkForKeywords`, not by stubbing globals. This lets users tune keywords/accuracy *while building the book* instead of discovering collisions mid-session.

**1.3 Undo for destructive actions.**
Deletes (page, chapter, collection, appendix entry, soundtrack, variation) currently use native `confirm()` and are irreversible. Replace with: perform the delete immediately, keep a deep-copied snapshot + restore function on a small undo stack (depth ~10), and show the existing toast (`showTemporaryMessage`) with an **Undo** action button for 8 s. `Ctrl+Z` pops the stack while it's non-empty. Remove the `confirm()` calls — undo makes them unnecessary and the native dialogs break the theme. Restore functions must reinsert at the original index and re-render (`renderPageList`, `renderChapterTabs`, `renderAppendixList`, etc.).

**1.4 Hotkey bindings (manual fallback for voice).**
Every soundboard has this; Storyteller doesn't. Add `page.hotkey` (string like `"1"`, `"F2"`, additive schema). Assignment UI: a "Hotkey" field in the Edit Page modal that captures the next keypress; show the binding as a small badge on the page item. Global `keydown` handler (respecting the existing guard that skips when typing in inputs/modals — see the `Ctrl+S` handler around line 10500) toggles play/stop for the bound page. Conflicts: last assignment wins, warn via toast. When speech mishears (the "boat" problem), the GM presses a key instead of repeating themselves at the table.

**1.5 Duck-all ("table talk" button).**
Next to Stop All: a hold-or-toggle button (and `Ctrl+D`) that smoothly ramps master gain to ~20% without stopping anything, and restores on release/second press. Implementation: a global `duckFactor` applied wherever `currentMasterVolume` feeds gain math (`adjustCurrentlyPlayingVolumes`, the master-slider input handler, YouTube `setVolume`, Syrinscape local volume) — do **not** move the master slider itself, so the user's setting survives. GMs constantly need to drop the ambience to answer a rules question; today their only options are Stop All (loses the mix) or dragging the slider twice.

## Phase 2 — Audio polish

**2.1 Crossfade engine.**
All transitions are hard cuts today (`page.fadeInOut` exists only for file sources, and `reEvaluateActiveSounds` stop/starts abruptly on chapter/time changes). Add a shared helper `fadeGain(gainNode, from, to, seconds)` (Web Audio `linearRampToValueAtTime`; for YouTube, a ~10 Hz `setVolume` interval; Syrinscape excluded) and use it in: (a) variation switches in `reEvaluateActiveSounds` — fade old out while new fades in; (b) chapter-change stops; (c) Stop All; (d) sequential/compound playback hand-offs. One book setting: crossfade duration 0–5 s (0 = current behavior, the default for backward compatibility). This is the single biggest *perceived-quality* upgrade available — it makes day/night and chapter shifts sound produced instead of clipped.

**2.2 Per-page quick volume.**
Changing one sound's volume mid-session requires opening the Edit Page modal. Add a compact volume slider that appears on the page item when the sound is playing (in the expanded row area next to the play button), writing to `page.volume` and calling `adjustCurrentlyPlayingVolumes([pageId])` live. Debounce `saveToLocalStorage` (~500 ms). Must respect the new `--range-fill` golden-fill pattern (delegated `input` listener already handles dynamically created sliders).

**2.3 Scenes (mix snapshots).**
New book array `scenes: [{id, name, hotkey?, voicePhrases?, entries: [{pageId, variationId?, volume}]}]`. "Save Scene" captures the currently-playing mix (from `activeSounds` + `volumeModifiers`); recalling a scene crossfades from the current mix to the saved one (stop non-members, start members at saved volumes — reuse 2.1). Recall via a scenes dropdown in the header, hotkey (1.4 infrastructure), or voice phrase (hook into `checkForKeywords` **before** page matching, like stop phrases). Chapters answer "where are we"; scenes answer "how does this moment sound" — GMs currently rebuild mixes by hand every time combat starts.

**2.4 Soundtrack fades.**
Fade-out on soundtrack stop/switch and a short crossfade between songs in a playlist (file-based songs have `stPlayerNode.gainNode` already; YouTube via the 2.1 interval helper). Removes the jarring hard cut when a playlist advances.

## Phase 3 — Book-building speed

**3.1 Bulk import: audio folder → pages.**
There is no way to create many pages at once; a 40-sound library means 40 trips through the Add Page modal. Add "Import Audio Files…" (header dropdown): multi-select via the existing hidden `directoryInput` pattern (or a new `<input type="file" multiple accept="audio/*">`), then a review table — one row per file: title (from filename, cleaned: strip extension/underscores/leading numbers), keywords (pre-filled from title words), target chapter, include-checkbox — then create all pages in one pass (reuse the Add Page creation path + IndexedDB `audioStore` hashing so files persist). This collapses hours of setup into minutes and is the feature most likely to convert a curious user into a real one.

**3.2 Page drag-and-drop.**
Reorder pages within a chapter and drag pages between chapter tabs / into collections. The appendix sequential list (search `selectedPagesList.addEventListener('dragstart'` in `app.js`) already implements the HTML5 DnD pattern to copy, including the `getDragAfterElement` helper. Persist order in `chapter.pageIds` / `collection.pageIds`. Grid view included.

**3.3 Command palette (`Ctrl+K`).**
A themed overlay with a fuzzy input (reuse the Fuse instance) across: pages (Enter = play/stop), chapters (Enter = switch), scenes (Enter = recall), and app actions (open settings/appendix/plotter, toggle day/night, toggle listening). Arrow keys + Enter, Escape closes. Fast keyboard-driven control for laptop GMs and a discoverability layer over the 39-modal UI.

**3.4 Modal stack manager (foundation, do before or with 3.3).**
Nested modals are managed by hand-tuned inline `zIndex` writes ('1005'/'1010'/'1015' scattered across appendix, manage-sources, and effect modals) — this exact pattern caused the manage-sources-on-top bug. Replace with a tiny helper: `openModal(el)` pushes onto a stack and assigns `1000 + 10*depth`; `closeModal(el)` pops and restores; Escape closes the top-of-stack only (integrate with the existing Escape handler). Mechanical refactor, ~15 call sites, kills a whole recurring bug class.

## Phase 4 — Platform, reach & comfort

**4.1 Vendor the CDNs + build-time Tailwind.** Still outstanding from `FIX_PLAN.md` Phase 2 (the `<head>` still loads `cdn.tailwindcss.com`, jsdelivr Fuse, cdnjs Font Awesome, Google Fonts). Do it as specified there (2.1–2.3); requires network access to fetch the assets once. Until this lands, the app is broken offline and flashes unstyled — it undermines every polish item above.

**4.2 PWA / offline shell.** `manifest.webmanifest` + a service worker precaching the shell (post-4.1 so the shell is self-contained). Installable app icon at the table; survives venue Wi-Fi. (`FIX_PLAN.md` 2.4.)

**4.3 Auto-backup & restore.** localStorage autosave is one corruption/quota event away from losing a book. Every 5 minutes (if dirty), write a compressed snapshot to a new IndexedDB store (keep last ~20, prune). Settings gains "Backups…": list with timestamps/sizes, one-click restore (current state is snapshotted first). The `audioStore` IndexedDB wrapper at the top of `app.js` is the pattern to copy.

**4.4 Responsive & touch pass.** `css/main.css` has exactly 2 media queries; on a tablet the three-column header collapses poorly and touch targets are ~24 px. Target: usable at 768–1024 px (stack header, enlarge play buttons to ≥40 px in grid view, make grid view the touch-default). Grid view is the natural "performance mode" — make it genuinely finger-friendly.

**4.5 Accessibility.** `aria-label` on all icon-only buttons (nearly every control is a bare Font Awesome glyph), focus trap + focus-restore in the modal manager (3.4 makes this one change instead of 39), `prefers-reduced-motion` disables torch sway/glow animations.

---

## Explicitly deferred (considered, rejected for now)

- **Framework migration / TypeScript** — forbidden by ground rules; the ES-module split (`FIX_PLAN.md` 3.1/3.2) is still the right next structural step and pairs with 4.1's build step.
- **Cloud sync / accounts** — hosting cost + auth complexity; `.story` files + 4.3 backups cover the need.
- **Usage analytics/stats** — low GM value relative to effort.
- **Mobile-phone layout** — tablet (4.4) is the realistic floor; a phone can't run a session UI this dense.

## Suggested execution order & effort

| Step | Effort | Risk | Value | Depends on |
|---|---|---|---|---|
| 1.1 History panel | M | Low | ★★★★★ | — |
| 1.2 Matcher playground | M | Medium (threading dryRun) | ★★★★★ | shares 1.1's event plumbing |
| 1.3 Undo | M | Low | ★★★★ | — |
| 1.4 Hotkeys | S | Low | ★★★★ | — |
| 1.5 Duck-all | S | Low | ★★★★ | — |
| 2.1 Crossfades | M | Medium (audio lifecycle) | ★★★★★ | — |
| 2.2 Quick volume | S | Low | ★★★ | — |
| 2.3 Scenes | M–L | Medium | ★★★★ | 2.1, 1.4 |
| 2.4 Soundtrack fades | S | Low | ★★★ | 2.1 |
| 3.1 Bulk import | M | Low | ★★★★★ | — |
| 3.2 Drag-and-drop | M | Medium | ★★★ | — |
| 3.3 Command palette | M | Low | ★★★ | 3.4 |
| 3.4 Modal manager | S | Low | ★★★ (bug-class kill) | — |
| 4.1 Vendor CDNs | M | Low | ★★★★★ | network access |
| 4.2 PWA | S | Low | ★★★ | 4.1 |
| 4.3 Auto-backup | S | Low | ★★★★ | — |
| 4.4 Responsive/touch | M | Low | ★★★ | 4.1 helps |
| 4.5 Accessibility | S | Low | ★★ | 3.4 |

**Recommended first session:** 1.1 → 1.2 → 1.5 → 1.4 (one coherent "session control & insight" release that directly answers the troubleshooting pain from July 2026). **Second:** 2.1 → 2.2 → 2.4. **Third:** 3.1 + 1.3. Then 3.4 → 3.3, then Phase 4 when network access allows 4.1.

## Verification additions (extend `docs/TESTING.md`)

1. Speak/type a phrase in the playground → results match what live speech does; nothing plays.
2. Trigger a sound by voice → history panel row shows transcript, page, keyword, confidence.
3. Delete a page → toast Undo restores it at the same position with sources intact (reload: still there).
4. Bind `F2` to a page → plays/stops from anywhere except while typing in an input.
5. Duck during playback → all source types drop smoothly, slider position unchanged, restore returns exact levels.
6. Chapter switch with crossfade 2 s → old ambience fades out as new fades in (file + YouTube).
7. Save a scene with 3 sounds, stop all, recall → same 3 sounds at saved volumes, crossfaded.
8. Bulk-import 10 files → 10 pages with cleaned titles play without relink after reload.
9. Kill localStorage mid-session → restore latest auto-backup, book intact.
10. `Ctrl+K` → type partial page name → Enter plays it; Escape closes only the palette.
