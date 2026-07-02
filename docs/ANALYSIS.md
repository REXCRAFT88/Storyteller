# Storyteller — Deep Site Analysis

*Analysis date: 2026-07-02. Target: `index.html` (17,749 lines, 1.14 MB single-file app), plus repo assets.*

Method: full static analysis of the source (structure mapping, ID cross-referencing, function sizing) plus a live run of the page in headless Chromium with console/error capture, fake microphone, and UI probing. Note: the analysis sandbox's network policy blocked the CDN domains, which coincidentally provided a perfect test of the app's offline behavior.

---

## 1. What the app is

A voice-controlled soundboard for tabletop RPG narration. The GM speaks; the browser's Web Speech API transcribes; keyword matching (Fuse.js fuzzy search) triggers "pages" (sounds) organized into chapters, with sources from local audio files (Web Audio API), YouTube (IFrame API), Syrinscape, and Spotify-playlist import. Extra systems: appendix effects (volume ducking, contextual triggers), day/night sound variations, a node-graph "story plotter," soundtrack playlists, PiP status window, and a built-in guidebook.

### File layout

| Region | Lines | Content |
|---|---|---|
| `<head>` | 1–18 | 6 external CDN dependencies |
| `<style>` | 19–3,210 | ~3,200 lines of custom CSS (on top of Tailwind) |
| Body markup | 3,213–5,168 | Main UI + 39 modals |
| `<script>` | 5,169–17,547 | ~12,400 lines, 266 functions, almost all inside one `DOMContentLoaded` closure |
| Trailing markup | 17,548–17,748 | Soundtrack bar + soundtrack modals (markup *after* the script) |

External dependencies, all CDN, no local fallback: Tailwind **CDN runtime** (`cdn.tailwindcss.com`), Fuse.js (jsdelivr), Font Awesome 6.5.2 (cdnjs), Google Fonts, `syrinscape.com/integration.js` + `player.js`, YouTube IFrame API (injected at runtime).

---

## 2. What works

Verified in the live run and by code reading:

- **Boot and degradation.** The app initializes cleanly even with *every* CDN blocked: default book created, all 96 buttons and 39 modals present, listening toggle flips state ("Stopped." → "Listening..."), settings modal opens. Feature code consistently guards optional integrations (`typeof Fuse === 'function'`, `youtubeApiReady`, Syrinscape checks).
- **Speech pipeline design.** The recognition layer (lines 6003–6186) is well isolated: `recognition.onresult` splits interim/final transcripts, tracks consumed words per utterance, and funnels everything into a single seam — `checkForKeywords(text, book, isInterim, consumedWords)` (line 8378). This is genuinely good architecture for swapping recognition engines (see `VOSK_PLAN.md`).
- **Matching engine.** Keyword index rebuild (`updateFuseIndex`, line 8002) maps the user's accuracy threshold onto Fuse's threshold; ignored-words list; primary-key/context ("look-behind") logic; compound phrases ("X and Y"); stop phrases; day/night transition phrases.
- **Persistence model (metadata).** Autosave to localStorage (48 call sites) with a serializable book snapshot; full export/import of `.story` JSON; per-chapter export/import; sample book included in repo.
- **Sound lifecycle.** `activeSounds` registry with per-type teardown (Web Audio nodes, YT players, Syrinscape stop calls), gain nodes for per-sound + master volume, appendix volume modifiers, loop and duration handling per source type.
- **Spotify OAuth.** Correct PKCE flow (code verifier in localStorage, token refresh) rather than the deprecated implicit grant.
- **Pragmatic hacks that work.** Silent looping `data:` audio to keep the tab alive in background (line 16756); canvas-fed `<video>` PiP status window.

## 3. What is broken

Ordered by severity. Line numbers refer to `index.html`.

### B1. Infinite speech-recognition restart loop (verified live)
`recognition.onerror` (line 6088) retries on `audio-capture` and `network` errors with a fixed 500 ms delay and **no retry limit or backoff**. In the live run with no working microphone, the app looped `start → error → restart` indefinitely, several times per second, forever. The same happens for any user whose mic is unavailable, and — because Chrome's Web Speech API requires Google's servers — for **any user who goes offline**: an app pitched as a local tool spins in an error loop without internet. There is also no user-visible indication after the first message; `status` continues to read "Listening...".

### B2. Silent data loss on every version upgrade
`LOCAL_STORAGE_KEY = 'storytellerBookData_v25.8'` (line 5173) embeds the release version and there is **no migration or fallback scan for older keys**. Every time the developer bumps the version, every user's autosaved book is orphaned. A user who didn't manually export loses their library.

### B3. Local audio never persists — manual relink every session
Audio files are decoded straight into in-memory `AudioBuffer`s (lines 7713, 12477); saves store only `needsFile: true`. Every page reload requires the user to re-pick their audio directory (`relinkFromDropdownButton` → `webkitdirectory` input, line 7443). IndexedDB is used **zero** times in the codebase. This is the single largest UX tax in the app and is fully solvable (store file blobs in IndexedDB, or persist `FileSystemHandle`s and re-request permission).

### B4. References to 24 non-existent DOM elements; some crash at runtime
Cross-referencing all 349 `getElementById` targets against markup found 24 that exist nowhere in the HTML (static or dynamically generated). Consequences:

- `youtubePaginationTop.classList.add('hidden')` at line 15636 — `youtubePaginationTop` is `null` (line 5585), so this **throws a TypeError** in the YouTube search render path when there are no results/single page.
- The "source variation" editor references removed inputs — `sourceVariationFile`, `sourceVariationYoutubeUrl`, `sourceVariationSyrinscapeElementId/Kind/Search/SelectedSound/PlayDuration` (lines 5432–5445 area, used at 7655–7662, 15275–15286, 16853) — the markup for these was deleted from `variationSettingsModal` but JS and CSS (lines 954–963) still target them. Editing a variation's *source* (changing its file/YouTube/Syrinscape binding) is dead; Syrinscape-search-for-variation writes into `null` elements.
- Dead weight: `exportChapterButton`, `importChapterInput`, `importCollectionsInput`, `settingKeepAlive`, `settingsEnableBackgroundKeepAlive`, `appendixTriggerTagSelect`, `plotThreadConditionSearchInput/List` — features whose UI was removed or renamed but whose wiring survives, some silently no-op thanks to `if (el)` guards, some not.

### B5. Total dependence on CDNs, including a dev-only tool in production
The **entire layout** is Tailwind utility classes compiled at runtime by `cdn.tailwindcss.com` — a tool Tailwind explicitly documents as not for production. No internet (or CDN outage, or an ad-blocker) means: unstyled page soup, no fuzzy matching (Fuse missing → `fuseInstance = null`; matching degrades), no icons (nearly every button label is a Font Awesome `<i>`), no YouTube, no Syrinscape. For a program whose premise includes offline/local use, everything above must be vendored locally.

### B6. XSS via book content
User- and import-controlled strings (page titles, entry names, soundtrack names, etc.) are interpolated **unescaped** into `innerHTML` in 39 template-literal render sites (e.g. lines 6691, 6706, 7014, 7092). A shared `.story` file with a title like `<img src=x onerror=...>` executes arbitrary script in the victim's browser — which also holds their **Spotify access/refresh tokens and YouTube API keys in localStorage** (lines 16179–16190). Books are explicitly meant to be shared, so this is a real vector, not just self-XSS.

### B7. Duplicate DOM IDs generated per soundtrack
The soundtrack list template emits `id="${st.id}"` twice per item (two elements sharing one ID), making `getElementById` on those ambiguous and invalidating the HTML.

### B8. Broken on `file://` in several ways
`SPOTIFY_REDIRECT_URI = window.location.origin + pathname` (line 5178) yields `"null/..."` on `file://` — Spotify auth cannot work when the app is opened as a local file (the primary distribution mode implied by the repo: an `.html` you double-click, plus a `.reg` file for icon association). YouTube IFrame embedding and some fetches are similarly origin-hostile on `file://`.

## 4. Structural & efficiency problems

- **S1. Monolith.** One 17.7k-line file; a 12.4k-line script in a single closure. The 20 largest functions range from 147 to 461 lines (`getDefaultBook` 461, `updateActiveSoundsUINative` 390, `renderAppendixEffectControls` 362, `checkForKeywords` 359, `loadBookFromFile` 325, `playSound` 323…). Any AI or human editing this file must reload the whole context; the risk of regressions on each edit is high (and B4 shows that decay has already happened).
- **S2. Full-list re-render.** `renderPageList()` (line 9439) wipes `pageListUl.innerHTML` and rebuilds every page item (each ~216 lines of template via `createPageListItem`), and is called on essentially every state change — including sound start/stop callbacks (e.g. lines 8939, 9000, 9007), i.e. potentially several times per second while sounds play. All listeners are re-attached each time. With a large book this is real jank.
- **S3. Duplicated logic.** Repeated regex-escape-then-test blocks in `checkForKeywords` (the "1. Stop Phrases Check" comment even appears twice, lines 8381/8400); repeated "find page by reverse-scanning activeSounds keys" inside a loop (lines 7516–7532, O(n²)); parallel implementations of preview players for Add-Page vs Edit-Page modals.
- **S4. Debug artifacts.** 310 `console.log` calls in production; AI-conversation residue comments ("This is correct", "This line is correct" — lines 5264, 5777, 16853); versioned changelog comments in constants.
- **S5. Dead CSS.** ~3,200-line stylesheet on top of Tailwind, including rules for removed elements (lines 954–963 target labels of B4's missing inputs); duplicated modal z-index fixes.
- **S6. Asset bloat.** `brick_wall.png` is 666 KB (a repeating background texture — should be ≤100 KB WebP); `index.html` itself is 1.1 MB uncompressed and unminified.
- **S7. No engineering hygiene.** Git history is exclusively "Add files via upload" (GitHub web UI); no build step, no lint, no tests, no way to review a diff of what each AI edit changed. This is *the* root cause of B4/S3/S5 style decay.
- **S8. localStorage as the only autosave.** Quota (~5 MB) can be hit by big books + cached YouTube search pages (line 15524); failures only log to console + toast. IndexedDB removes both the quota problem and B3.

## 5. Security summary

| Issue | Severity | Where |
|---|---|---|
| XSS from shared `.story` books (B6) | High | 39 innerHTML sites |
| OAuth tokens + API keys readable by any XSS (localStorage) | High (amplifier) | 16179–16190 |
| Hardcoded default Spotify client ID | Low (public by design in PKCE, but rate-limit/abuse risk) | 5177 |
| User-supplied YouTube API keys stored in book file — exported with `.story` shares? | Medium — verify `settings.youtubeApiKeys` is stripped on export; it currently is saved in book settings | 6464, save path |

## 6. Verified-working vs broken quick reference

| Subsystem | Status |
|---|---|
| Boot, UI shell, modals, settings | ✅ works (verified headless) |
| Speech → keyword → sound pipeline | ✅ works (Chrome, online, mic OK) — ❌ error loop otherwise (B1) |
| Local file sounds | ⚠️ works per-session; no persistence (B3) |
| YouTube search/playback | ⚠️ works with user API key; pagination render path has null-ref crash (B4) |
| Source variations | ⚠️ partially dead UI (B4) |
| Syrinscape | ✅ code paths guarded; needs their CDN scripts + auth token |
| Spotify import | ⚠️ works only on hosted origin, not `file://` (B8) |
| Offline use | ❌ layout, icons, search, speech all fail (B5, B1) |
| Upgrade path | ❌ data loss on version bump (B2) |

The remediation plan is in `FIX_PLAN.md`; the offline speech plan is in `VOSK_PLAN.md`.
