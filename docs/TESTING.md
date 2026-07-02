# Testing Storyteller

No framework was added (see `FIX_PLAN.md` rationale). Verification is a mix of a
fast automated smoke test and a manual checklist run after each change.

## Automated checks (run before every commit)

```bash
npm run check:ids   # no getElementById target points at a missing element (B4)
npm run lint        # ESLint no-undef etc. (needs `npm install` first)
npm run test:smoke  # headless boot + core UI + speech restart-loop guard (needs playwright)
```

`check:ids` has **zero dependencies** and always runs. `lint` and `test:smoke`
need `npm install`. The smoke test needs a Chromium binary; set `CHROMIUM_PATH`
if it isn't at `/opt/pw-browsers/chromium`.

## Manual smoke checklist

1. Fresh profile: app boots with no console errors; default book created.
2. Load sample book (`storyteller-sample-book.json`); pages render; search filters.
3. Add a page with a local audio file → it plays. Reload the tab → **still plays without re-picking the folder** (after IndexedDB persistence lands, B3).
4. Toggle listening with a working mic: speak a page keyword → its sound triggers; speak a stop phrase → all sounds stop.
5. Unplug the mic / deny permission → app shows a bounded, clear error and stops; **no infinite restart loop** (B1).
6. DevTools "Offline" mode → app still boots styled with working search (after CDN removal, B5); speech shows offline guidance.
7. YouTube search with an API key → results paginate, add a source, playback works, no `TypeError` in console (B4).
8. Create and edit a source variation end-to-end, including changing its source (B4).
9. Import a `.story` whose page title is `<img src=x onerror=alert(1)>` → renders as inert text, no alert (B6).
10. Export the book, wipe storage, re-import → identical behavior.
11. Copy the book to a bumped `schemaVersion` → it still loads via the migration path (B2).

## Notes

- Web Speech recognition (the online engine) only works in Chrome/Edge and needs
  internet. Firefox/Safari and offline testing depend on the Vosk engine
  (`VOSK_PLAN.md`).
- The smoke test intentionally runs with a fake (silent) microphone, which is
  why it doubles as the B1 restart-loop regression guard.
