# Storyteller — Offline Speech-to-Text with Vosk (Implementation Plan)

*Goal: stop depending on the browser's built-in Web Speech API (Chrome-only, cloud-backed, fails offline) by adding an in-browser, fully offline recognition engine based on Vosk — while keeping the existing engine as an option.*

## 1. Why, and why Vosk

Today's recognition (`index.html` lines 6003–6186) uses `webkitSpeechRecognition`, which in Chrome streams audio to Google servers. Consequences: no offline use (currently an infinite error loop — `ANALYSIS.md` B1), Chrome/Edge only (no Firefox), privacy exposure (a full D&D session's narration goes to Google), and rate/availability limits outside the app's control.

**Vosk** (Kaldi-based, Apache-2.0) has an official WebAssembly port, **`vosk-browser`** (npm package, Apache-2.0), that runs entirely client-side in a Web Worker:

- **Streaming** partial + final results — same interaction model the app already uses.
- **Small English model** (`vosk-model-small-en-us-0.15`) is ~40 MB and runs in real time on ordinary desktops; larger models (~128 MB `lgraph`) available for accuracy; 20+ languages.
- **Grammar biasing**: a recognizer can be constrained to a phrase list. Storyteller's vocabulary *is* a known keyword list — this typically gives far better trigger accuracy than open-vocabulary cloud STT.
- Runs in Firefox/Safari, closing the app's biggest browser gap.

Alternatives considered and rejected for this use case: Whisper-in-browser (transformers.js / whisper.cpp WASM) — chunk-based, high latency and CPU, not built for continuous streaming keyword spotting; Coqui/DeepSpeech — unmaintained/heavier. Vosk is the fit.

**Hard constraint:** WASM + workers do not run from `file://`. The Vosk engine requires the app to be served over `http(s)` (localhost is fine) — this plan therefore depends on `FIX_PLAN.md` Phase 2.4/4.1 (Vite build, service worker, hosted or one-command-local serving).

## 2. Architecture: a pluggable `SpeechEngine`

The codebase already has a perfect seam: everything funnels into `checkForKeywords(text, book, isInterim, consumedWords)` (line 8378), and the recognizer object is only touched in one region. Formalize that seam:

```js
// speech/engine.js
class SpeechEngine extends EventTarget {
  // events: 'partial' {text}, 'final' {text}, 'statechange' {state}, 'error' {code, message, fatal}
  async init() {}
  async start() {}
  async stop() {}      // graceful
  abort() {}           // immediate (PTT release)
  get ready() {}
}
```

- **`WebSpeechEngine`** — wraps the existing `SpeechRecognition` setup, including the bounded-restart logic from `FIX_PLAN.md` 1.1. `onresult` interim → `partial`, final → `final`.
- **`VoskEngine`** — new, below.

The existing `onresult` body (interim word-block counting, consumed-word tracking, transcript display) moves unchanged into a single subscriber of these events; `startListening`/`stopListening`/PTT call the engine interface. This refactor alone is ~a day and is worth doing even before Vosk ships (it isolates B1's fix too).

### VoskEngine internals

```
getUserMedia({audio: {channelCount:1, echoCancellation:true, noiseSuppression:true}})
  → AudioContext (16 kHz if the browser honors it; otherwise resample in worklet)
  → AudioWorkletNode (128-sample frames → batches of ~1024 Float32)
  → postMessage(transferable) → vosk-browser Worker
  → KaldiRecognizer.acceptWaveform(...)
  → 'partialresult' events → engine 'partial'
  → 'result' events (on endpoint/silence) → engine 'final'
```

Implementation notes:

1. **Library**: `vosk-browser` ships its own worker + WASM; instantiate with `createModel(modelUrl)`. Bundle the package's assets locally via Vite (`/vendor/vosk/`) — no CDN (consistent with `FIX_PLAN.md` Phase 2).
2. **Recognizer**: `new model.KaldiRecognizer(sampleRate)` for open dictation, or `new model.KaldiRecognizer(sampleRate, JSON.stringify([...phrases, "[unk]"]))` for grammar mode (see §4).
3. **Audio capture**: use an `AudioWorklet` (not the deprecated `ScriptProcessorNode` some vosk-browser examples use). Downmix to mono, resample to 16 kHz (linear interpolation is adequate) if `AudioContext({sampleRate:16000})` isn't honored (Safari).
4. **Endpointing**: Vosk emits `result` after trailing silence (~0.5–1 s default). Map directly to the app's "final transcript" path; the existing `INTERIM_WORD_BLOCK_SIZE` batching logic works as-is on Vosk partials (they update every ~100–300 ms; may want to lower the block size from 6 to 4 for Vosk since its partials are steadier — make it per-engine config).
5. **Casing**: Vosk output is already lowercase, matching the pipeline (which lowercases everything anyway). No punctuation — irrelevant for keyword spotting.
6. **Lifecycle**: keep model loaded across start/stop (loading is the expensive part); free the recognizer on engine teardown; suspend the AudioContext when not listening (battery).
7. **No restart loop by construction**: the mic stream either exists or errors once, locally — surface `error {fatal:true}` and stop. Vosk never has "network" errors.

## 3. Model management

Models are the big design problem (40 MB+ downloads). Plan:

1. **Download on demand, cache forever.** Settings UI: engine picker + model picker ("English — small, 40 MB (recommended)"; later: other languages / larger models). Download from the app's own origin (`/models/vosk-model-small-en-us-0.15.tar.gz`, committed to the Pages deployment or a GitHub Release asset) with a progress bar (`fetch` + ReadableStream, content-length).
2. **Storage**: persist the model archive in **Cache Storage** (via the Phase-2 service worker) or IndexedDB as a Blob; on engine init, serve it to `createModel` via `URL.createObjectURL(blob)`. Call `navigator.storage.persist()`; show usage via `navigator.storage.estimate()` next to the audio-file cache UI (`FIX_PLAN.md` 1.3) with a delete button.
3. **Fully-offline sideload**: a "load model from file" picker (user downloads the `.tar.gz` from alphacephei.com on any machine) → stored the same way. This keeps the offline bundle small while allowing zero-network installs.
4. **Versioning**: store `{modelName, version}` alongside the blob; invalidate on app-driven upgrades only (never silently re-download).

## 4. Accuracy: grammar mode (the big win)

Storyteller doesn't need open dictation — it needs to spot a few hundred known phrases. Vosk grammar mode constrains decoding to a supplied vocabulary and dramatically improves precision/latency for exactly this case.

- Build the grammar from the same source as `updateFuseIndex()` (line 8002): all page keywords + primary keys + stop phrases + enter/exit phrases + day/night transition phrases + chapter keywords + appendix trigger phrases, plus `"[unk]"` so unknown speech maps to `[unk]` instead of force-matching a keyword.
- Rebuild the recognizer whenever the keyword set changes (cheap; model stays loaded) — hook the same code path that currently calls `updateFuseIndex()`.
- **Setting**: "Recognition vocabulary: Focused (recommended) / Full dictation" — full dictation remains useful because the transcript display doubles as session captioning, and compound/contextual phrases include free text. Default Focused.
- Keep Fuse matching downstream unchanged in both modes (grammar output still goes through `checkForKeywords`); with Focused mode, expect near-exact matches, so the confidence threshold UI keeps working with the same semantics.

## 5. Engine selection & fallback UX

- Settings → Speech Recognition: **Auto (recommended) / Browser (online) / Vosk (offline)**.
  - *Auto*: use Browser engine when `SpeechRecognition` exists and `navigator.onLine`; switch to Vosk (if a model is cached) on `network`-class SR errors or `offline` events; toast on switch.
  - Firefox/Safari (no `SpeechRecognition`): Auto = Vosk; replace the current "not supported, try Chrome" dead-end (line 6006) with a "download offline model" call-to-action.
- Status bar shows the active engine (e.g. "Listening… (offline)").
- PTT and toggle modes work identically for both engines (engine interface hides the difference: Web Speech restarts sessions; Vosk just gates the audio feed — mute the worklet rather than tearing down the recognizer, which also makes PTT more responsive than today).

## 6. Work plan

| Step | Deliverable | Depends on | Size |
|---|---|---|---|
| V1 | `SpeechEngine` interface; wrap existing code as `WebSpeechEngine`; move `onresult` body to engine-agnostic subscriber | FIX_PLAN 1.1 (bounded restarts) | S |
| V2 | Serve app over http(s) with Vite + service worker | FIX_PLAN Phase 2 | (already planned) |
| V3 | `VoskEngine`: worker, worklet capture, resampler, partial/final mapping; hardcoded dev model URL | V1, V2 | M |
| V4 | Model manager: download w/ progress, Cache Storage persistence, sideload picker, storage UI | V3 | M |
| V5 | Grammar mode + rebuild-on-keyword-change + vocabulary setting | V3 | S–M |
| V6 | Auto engine selection, offline fallback, status UI, Firefox path | V4 | S |
| V7 | Tuning: per-engine interim block size, endpoint silence, threshold defaults; test matrix | V5, V6 | S |

**Test matrix (V7):** Chrome/Edge/Firefox desktop × {online, offline} × {toggle, PTT} × {Focused, Full} vocabulary; sample-book keyword spotting accuracy A/B (Browser vs Vosk-full vs Vosk-focused) using a recorded narration WAV played through a virtual mic (the Playwright harness from the analysis + `--use-file-for-fake-audio-capture` makes this automatable in CI).

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| 40 MB model download deters users | On-demand, once, with progress + persistence; sideload option; app works without it (Browser engine unchanged) |
| CPU load while many sounds play | Small model is light (~real-time on one core, in a worker); expose "pause recognition while music plays" toggle if reports surface |
| Safari quirks (AudioContext sample rate, worker memory) | Resample in worklet; test V3 on Safari early; Safari users still have sideload + smaller grammar mode |
| Accuracy below cloud STT in Full-dictation mode | Grammar/Focused mode is the default and beats cloud for trigger words; keep Browser engine one click away |
| `file://` users can't use Vosk | Distribution moves to hosted PWA + one-command local server (FIX_PLAN Phase 4); document clearly |
| vosk-browser maintenance risk | Pin version, vendor locally; the WASM artifact is self-contained; fallback engine always present |

## 8. Out of scope (explicitly)

- Speaker diarization, punctuation, dictation-quality transcripts.
- Mobile-optimized recognition (works, but tuning deferred).
- Non-English models at launch (architecture supports them; add after V6).
