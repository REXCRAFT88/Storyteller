# 🔥 Storyteller

A **voice-controlled soundboard for tabletop RPGs**. Narrate your D&D session and
Storyteller listens for your keywords, automatically playing sound effects, music,
and ambience so you never have to fumble with your computer mid-scene.

Sounds can come from **local audio files**, **YouTube**, **Syrinscape**, and
**Spotify-playlist imports**, organized into chapters, pages, and collections —
with day/night variations, compound triggers, an appendix of contextual effects,
and a visual story-plotter.

> Originally built by a non-programmer with heavy AI assistance over a year of
> iteration (see `README.txt` for the author's note). This version has been
> hardened, cleaned up, and given an **offline speech engine** — see
> `docs/ANALYSIS.md`, `docs/FIX_PLAN.md`, and `docs/VOSK_PLAN.md`.

---

## Quick start

### Option A — just open it (browser speech, needs internet)

Download the repo and open **`index.html`** in **Google Chrome** or **Microsoft
Edge**. That's it. Voice control uses the browser's built-in speech recognition,
which works in Chrome/Edge and requires an internet connection.

### Option B — run it as a local site (recommended; enables offline speech)

The **offline (Vosk) speech engine** and some browser features need a real web
server — they don't work from a `file://` page. With [Node.js](https://nodejs.org)
installed:

```bash
npm run serve      # then open http://localhost:8000
```

(No dependencies required for `serve` — it's a tiny built-in static server. Set
`PORT=9000 npm run serve` to change the port.)

### Option C — publish it online (GitHub Pages)

This repo includes a Pages workflow (`.github/workflows/pages.yml`). To host your
own copy:

1. Push to your GitHub repo's `main` branch.
2. In **Settings → Pages → Source**, choose **GitHub Actions**.
3. The site deploys automatically to `https://<you>.github.io/<repo>/`.

Because Pages serves over HTTPS from a single origin, **all features work**,
including offline speech, microphone access, and installable PWA-style use.

---

## Voice control: choosing a speech engine

Open **Settings → Offline Speech (Vosk)** and pick an engine:

| Engine | Browsers | Internet | Notes |
|---|---|---|---|
| **Auto** (default) | all | uses browser when online, Vosk otherwise | recommended |
| **Browser** | Chrome, Edge | required (uses Google's servers) | zero setup, no model download |
| **Offline (Vosk)** | all incl. Firefox/Safari | none after model download | private, works offline |

### Setting up the offline (Vosk) engine

Offline recognition runs entirely on your device via
[vosk-browser](https://github.com/ccoreilly/vosk-browser) (bundled locally in
`vendor/vosk/`). It needs a one-time **model download** and the app must be
**served over http(s)** (Option B or C above — not `file://`).

1. Serve the app (Option B or C).
2. Go to **Settings → Offline Speech (Vosk)**.
3. Get a model — either:
   - Paste a model URL (e.g. from the [Vosk models page](https://alphacephei.com/vosk/models),
     such as `vosk-model-small-en-us-0.15`, ~40 MB) into **Model URL** and click
     **Download**, **or**
   - Download the model `.tar.gz`/`.zip` yourself and use **Choose model file…**
     to load it (fully offline install).
4. The model is cached in your browser (IndexedDB), so it's a one-time step.
5. Leave **Focused vocabulary** on — it constrains recognition to your book's
   trigger words, which is far more accurate than open dictation for this use.

> **Hosting a model on your own site:** put the `.tar.gz` next to `index.html`
> (e.g. `models/vosk-model-small-en-us-0.15.tar.gz`) and use that relative URL.
> Same-origin models avoid CORS issues.

---

## Using it

- Click the **microphone** button (or press **Spacebar**) to start/stop listening.
- Add **pages** (sounds) with trigger **keywords**; speak a keyword to play it.
- Group pages into **chapters** and **collections**; switch chapters by voice or click.
- Set **stop phrases**, **enter/exit phrases**, and **day/night transition phrases**
  in Settings.
- Full documentation is in the in-app **Guidebook** (book icon).

Your library is **autosaved** in the browser and can be **exported/imported** as a
`.story` file. Local audio files are cached in the browser so they keep working
after a reload — no need to re-select your folder each session.

## Browser support

| Feature | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| App, local audio, YouTube, Syrinscape | ✅ | ✅ | ✅ |
| Browser speech recognition | ✅ | ❌ | ❌ |
| Offline (Vosk) speech | ✅ | ✅ | ✅* |
| Spotify import | hosted only | hosted only | hosted only |

*Safari: served over https; test your model on it early.

## Privacy

- **Browser engine** streams microphone audio to the browser vendor's servers
  (Google, for Chrome) for transcription.
- **Offline (Vosk) engine** never sends audio anywhere — recognition is 100% local.
- Your book, YouTube API keys, and Spotify tokens live only in your browser's
  local storage. Imported `.story` content is HTML-escaped before display, so a
  shared book can't run scripts in your browser.

## Development

```bash
npm install          # dev tooling (eslint, prettier)
npm run serve        # run locally at http://localhost:8000
npm run check:ids    # verify every getElementById target exists (no deps)
npm run lint         # eslint
npm run test:smoke   # headless boot + speech restart-loop guard (needs playwright + chromium)
```

Structure: `index.html` (markup) · `css/main.css` · `js/app.js` · `vendor/vosk/`
(offline speech) · `docs/` (analysis, plans, schema, testing).

## Credits & license

- Storyteller: see `LICENSE`.
- Offline speech: [vosk-browser](https://github.com/ccoreilly/vosk-browser) and
  [Vosk](https://alphacephei.com/vosk/) — Apache-2.0.
- Fuzzy matching: Fuse.js. Icons: Font Awesome. Styling: Tailwind CSS.
