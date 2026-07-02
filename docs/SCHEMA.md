# Storyteller book (`.story`) schema

The book is a single JSON object, persisted to `localStorage` under
`storytellerBookData` and exported/imported as a `.story` file. `validateBook()`
in `js/app.js` enforces the structural rules below on import; `loadFromLocalStorage`
additionally fills defaults and migrates older shapes. Changes must stay
backward compatible (additive fields with defaults on load).

## Top level

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | number | Written on save (currently 26). Absent in pre-B2 files. |
| `pages` | array | The sounds. See below. |
| `chapters` | array | At least the `index` chapter. |
| `collections` | array | Groupings of pages. |
| `soundtracks` | array | Background playlists. |
| `appendix` | array | Contextual effects/triggers. |
| `settings` | object | App/book settings. |
| `storyPlot` | object | Plotter graph: `nodes`, `threads`, `viewTransform`. |
| `activeChapterId`, `currentTimeOfDay`, `next*Id` | scalars | View + id counters. |

## Page

```jsonc
{
  "id": 0,                      // required, unique
  "title": "Arrow Woosh",       // string
  "primaryKey": "arrow, bow",   // optional comma-separated trigger keys
  "keywords": ["woosh"],        // trigger keywords
  "phrases": [],                // multi-word trigger phrases
  "volume": 80, "loop": false, "loopCount": 0, "fadeInOut": false,
  "timeOfDaySetting": "always", // always | day | night
  "sources": [ /* variation containers */ ]
}
```

### Source variation container → sub-sources

Each entry in `page.sources` is a *variation container* (`{ id, name, isDefault,
conditions, variationKeywords, sources: [...] }`); each entry in its nested
`sources` is an actual sound:

```jsonc
{
  "type": "file" | "youtube" | "syrinscape",
  "fileName": "arrow.wav",
  "source": "<youtube id, or null for file/syrinscape>",
  "audioHash": "sha256-…",      // key to file bytes cached in IndexedDB (B3)
  "needsFile": false,           // true only for file sources with no cached bytes
  "startTime": 0, "endTime": null,
  "syrinscapeElementId": null, "syrinscapeKind": null, "syrinscapePlayDuration": null,
  "videoTitle": null
}
```

## Validation rules (enforced on import)

- The book is a non-array object.
- `pages`, `chapters`, `collections`, `soundtracks`, `appendix` — if present, must be arrays.
- `settings` — if present, must be a non-array object.
- Every page is an object with a non-null `id`; `title` (if present) is a string;
  `sources` (if present) is an array.

Invalid files are rejected on import with a message instead of partially loading.
All book-derived strings are HTML-escaped at render time (B6), so hostile titles
cannot execute script even if a file passes structural validation.
