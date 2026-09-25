# Ghost

A screen-share-invisible AI overlay. Bring your own **Claude** or **Gemini** API key — no accounts, no subscription, no server in the middle. Your keys are stored encrypted in the OS keychain and requests go straight to Anthropic / Google.

```
npm install
npm start
```

Then press **⚙**, paste a key, hit **Test** (makes one tiny real request and shows the model + latency), then **Save**. That's it.

## What it does

| | |
|---|---|
| **Invisible to screen share** | Zoom, Meet, Teams, Discord, OBS, Loom, Windows Game Bar, macOS screen recording — the window is excluded from every OS capture path. You see it; nobody else does. Also hidden from the taskbar and Alt+Tab. |
| **One button: Ask** | `Ctrl+Enter` (or the Ask button) grabs your screen (the overlay itself is excluded from the capture too) **and** the live transcript, and streams back the most useful answer — the question someone just asked you, the problem on screen, or whatever you typed. Markdown with copyable code blocks. |
| **Live listening** | `Ctrl+Shift+L` captures **both sides of the call** — system audio (what the others say) **and** your mic — and streams it to the **Gemini Live API** over a WebSocket. Lines appear within about a second of each phrase, labelled You/Them. Then just hit **Ask**. Level meters show whether each side is being heard. |
| **Chat** | Type follow-ups in the box. Conversation memory, attach a screenshot to any message with the 📷 toggle. |
| **Profiles** | General / Technical interview / Meeting / Sales / Study, plus free-text custom instructions. |
| **Stays out of the way** | Always on top, movable & resizable, opacity control, click-through mode (mouse passes through the overlay to whatever's beneath). |

## Hotkeys (global — work while any app is focused)

| Action | Windows / Linux | macOS |
|---|---|---|
| Show / hide overlay | `Ctrl+\` | `Cmd+\` |
| Screenshot + ask | `Ctrl+Enter` | `Cmd+Enter` |
| Ask (alias) | `Ctrl+Shift+Enter` | `Cmd+Shift+Enter` |
| Start / stop listening | `Ctrl+Shift+L` | `Cmd+Shift+L` |
| Toggle click-through | `Ctrl+Shift+M` | `Cmd+Shift+M` |
| New conversation | `Ctrl+Shift+R` | `Cmd+Shift+R` |
| Stop generating | `Ctrl+Shift+X` | `Cmd+Shift+X` |
| Move window | `Ctrl+Alt+Arrows` | `Cmd+Alt+Arrows` |
| Opacity − / + | `Ctrl+Alt+[` / `]` | `Cmd+Alt+[` / `]` |
| Quit | `Ctrl+Shift+Q` | `Cmd+Shift+Q` |

All of them are editable in settings (Electron accelerator syntax). If a shortcut is already taken by another app you'll get a toast at startup.

**Hide vs Quit.** ✕ in the header only *hides* the overlay (Ghost keeps running; `Ctrl+\` or the tray icon brings it back). The red **Quit** button in the header, `Ctrl+Shift+Q`, or the **tray icon → Quit Ghost** exits completely — after flushing the session to disk. The tray icon (bottom-right of the taskbar) also offers Show/Hide and Pause/Resume, so a hidden Ghost is always one click away.

## Providers

| | Chat + vision | Live audio transcription | Free tier |
|---|---|---|---|
| **Gemini** (`gemini-2.5-flash` default, flash-lite, 2.5 Pro, Gemma 3) | ✅ | ✅ (Live API) | yes — per-model daily caps |
| **NavyAI / Groq / Cerebras / OpenRouter / Ollama** (any OpenAI-compatible endpoint; presets in ⚙) | ✅ (if the model has vision — NavyAI's Gemini/DeepSeek/Mistral models do) | — | NavyAI: 100+ free models behind one `sk-navy-…` key (`https://api.navy/v1`); Groq & Cerebras: free and the **fastest answers available** (first word ~0.3 s); Ollama: local, unlimited |
| **Claude** (`claude-haiku-4-5` default — fastest/cheapest; Sonnet 5 and Opus 5 selectable) | ✅ | — | no (needs credit) |

**Running out of quota is handled at two levels.** Within Gemini, a daily-dead model falls back to a sibling (flash-lite → flash → Gemma 3 27B/12B — Gemma shares the key but has its **own** daily quota); the chain is filtered against Google's live model list so retired names are skipped. Across providers, when the main provider is dead on every model, the same request goes to any other configured provider (⚙ → *When the main provider's daily quota is used up* → auto), and the answer starts with a note like `[Gemini: daily quota used up → answered by OpenAI-compatible]`. Practical setup for unlimited free answers: Gemini key + a free Groq key.

So: for *listening* you need a Gemini key (it's used only for speech-to-text). You can still have Claude answer — set provider to Claude and just add a Gemini key alongside it. Model names are free-text dropdowns, so new models work without a code change.

**Claude multi-workspace keys** (personal keys not bound to one workspace) are rejected by Anthropic with *"This API key is not scoped to a workspace"* unless the request carries an `anthropic-workspace-id` header. Ghost tries to detect the workspace itself (workspace-agnostic call → response header, then the Admin *List Workspaces* endpoint, which accepts such keys) and saves it; if that fails, the easiest fix is Console → API keys → **Create Key** and pick a workspace in the dialog (no header needed), or paste the `wrkspc_…` ID into ⚙ → Claude → *Workspace ID*.

Claude requests use adaptive thinking with a configurable **effort** level (default `medium` — a good speed/quality balance for a live overlay; drop to `low` for fastest replies). The *server-side refusal fallback* option lets the API transparently re-run on a fallback model if the primary declines a request; turn it off if your account doesn't have the beta.

## How the invisibility works (and what it doesn't cover)

The whole trick is one OS flag, set through Electron's `win.setContentProtection(true)`:

* **Windows** → `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` (Windows 10 2004+). The compositor drops the window from every capture API — DXGI Desktop Duplication, Windows.Graphics.Capture, GDI `BitBlt`, PrintWindow. That's what every screen-share and recorder uses.
* **macOS** → `NSWindow.sharingType = .none`. Same effect via ScreenCaptureKit / CGWindowList.
* **Linux** → not supported by any compositor; the window *will* be visible in shares.

Two Windows gotchas we hit and handle (verified with `test/exp-probe.ps1`, Electron 33):
1. `setContentProtection(true)` called **before the window is first shown is silently ignored**.
2. **Every `hide()` → `show()` cycle resets the flag** — i.e. pressing the toggle hotkey once would make a naive implementation visible to the share. Ghost re-applies the flag on every `show`/`focus`/`restore` and on a 2 s watchdog.

You can verify on your own machine at any time:

```powershell
.\test\affinity-probe.ps1          # launch, read affinity from outside the process, quit
.\test\affinity-probe.ps1 -Toggle  # same, after a hide/show cycle
```
`affinity: 0x11  excludedFromCapture=True` is what you want.

What it does **not** hide from:
* A phone camera pointed at your monitor, or an HDMI capture card.
* Remote-desktop protocols that stream the GPU framebuffer (some VDI setups).
* Anyone looking at your screen in person.
* Proctoring software that inspects the process list (the process is called `electron` / `Ghost` — it's not hidden and doesn't try to be).

## Live listening details

**Transcription is independent of who answers.** A Claude-only or NavyAI-only setup (no Gemini key) still transcribes: Ghost simply uses the local engine. Claude has no audio input, so it never transcribes itself — it just receives the transcript like any other provider.

**Capture quality.** Audio is captured at the device's **native rate** (usually 48 kHz) and downsampled to 16 kHz with a 2-pole anti-aliasing low-pass and phase-carried decimation — verified transparent (a clip round-tripped through it transcribes verbatim). Forcing a 16 kHz capture context, which the old build did, made some drivers and Windows loopback hand back mangled or near-silent audio.

**Two-pass local accuracy (default on).** The streaming model gives instant words; the moment a sentence finishes, its audio is re-transcribed by **NVIDIA Parakeet TDT 0.6B** (top of the open ASR leaderboard, with punctuation and casing) in a second worker thread, and the transcript line is replaced in place (~1 s per sentence on CPU, +670 MB one-time download). Provisional words show greyed until the accurate version lands; **Ask** waits up to ~2 s for the correction so answers use the accurate text. Toggle in ⚙ → *Accuracy pass*. This makes local transcription near-Gemini quality — but the input audio still has to be clean: on a real call the "them" side is the pristine digital call stream via loopback and your mic is you speaking directly, both ideal. If accuracy is poor, watch the two level meters while people talk — if a bar barely moves, that side is being captured from the wrong device (common with Voicemeeter installed); pick the right **call audio capture device** in ⚙ or set your real speakers/headphones as the Windows default output.

**Local engine models** (⚙ → *Local engine model*): the default is **NVIDIA FastConformer** (streaming transducer via sherpa-onnx, ~480 MB, ~35 % of a core per stream) — trained on thousands of hours of varied real speech, so it holds up on laptop mics and accents (18/18 words on the reference clip). The **Zipformer int8** option is light (72 MB, ~10 % of a core) but trained on audiobooks only and noticeably worse on real-world audio. Models download once into `%APPDATA%\ghost\models\`.

**Two speech-to-text engines, accuracy first, never silent.** The default is the **Gemini Live API** (best accuracy, multilingual, uses your Live-API quota). Behind it sits a **local offline engine** — a streaming Zipformer ASR (sherpa-onnx, int8, English) that runs on your CPU at ~10 % of one core with sub-second partials (~72 MB model, downloaded once into `%APPDATA%\ghost\models\`). Each source (you / them) falls back to the local engine *on its own* the moment Gemini Live can't connect, is rejected, or runs out of quota — mid-call too — and the status line says so; listening never just stops. Pick *Local only* in ⚙ to keep every request for answers. Verified: local engine 17/18 words on the reference clip, real-time factor 0.11; the quota-death fallback is covered by the in-app smoke test.


* **Both** (default) = the call (system loopback) **and** your microphone, each on its own Gemini Live session, so transcript lines come back labelled **THEM** / **YOU** and the model knows who asked what. Two level meters in the transcript panel show live input — if a bar doesn't move while someone talks, that side isn't being captured.
* **Streaming mode (default)** — audio is captured at 16 kHz mono, auto-gained (loopback captures *after* your volume slider), and sent as raw PCM frames every ~256 ms over a WebSocket (`BidiGenerateContent`, model `gemini-3.8-live`, with a fallback list). The server commits `inputTranscription` at each pause — typically well under a second after the phrase. Verified against the real API: every current Live model is AUDIO-output-only and transcription needs the server's VAD on, so sessions run with `responseModalities: ["AUDIO"]` plus a "stay silent" instruction (the model answers with a near-empty "." — negligible cost). Auto-reconnects with session resumption on `goAway` / drops.
* **Echo ducking** — with speakers (not headphones) your mic hears the other people too. While the call source is active (and for 700 ms after), mic frames are sent as silence so they're never transcribed as YOU. Verified on the real API: level-ratio ducking failed (loopback is ~2 % post-volume vs an auto-gained mic); time-based ducking works.
* **Muted speakers = silence.** Windows loopback is captured after the mute/volume stage. If you mute your speakers, Ghost hears nothing from the call and says so in the status line after ~6 s. Use headphones at normal volume, or pick a recording endpoint as the **call audio capture device** in ⚙ (Stereo Mix, a Voicemeeter "Out B" bus, BlackHole on macOS) — those aren't affected by mute. `test/audio-volume.ps1` and `test/default-audio-device.ps1` show what Windows currently has as default / muted.
* **Windows**: loopback is Electron's WASAPI loopback (`audio: 'loopback'` in `setDisplayMediaRequestHandler`); nothing to install. **macOS**: no loopback in Electron — install [BlackHole](https://github.com/ExistentialAudio/BlackHole), route call audio through it, and pick it as the call audio capture device.
* **Chunked mode (fallback)** — if the socket can't be established, the app says why in the status line and switches to uploading 5-second WAV chunks (mixed sources) to `generateContent` (`gemini-2.5-flash-lite`, thinking disabled, silence-gated). Free-tier rate limit is ~10–15 req/min; on a 429 it backs off 20 s.

## Speed (why Cluely feels instant, and what Ghost does)

Two buttons: **Answer** (transcript only — the fast path) and **Ask + 📷** (transcript + a screenshot). Two modes, toggled with **⚡ / 🧠** in the header:

| | ⚡ Instant (default) | 🧠 Think |
|---|---|---|
| Model | `gemini-2.5-flash-lite` / `claude-haiku-4-5` (configurable) | your main model |
| Thinking | off (`thinkingBudget: 0`, Claude `effort: low`) | on (balanced or thorough, ⚙) |
| Length | hard cap ~80 words / 350 tokens: a 2–3 sentence "say this" + ≤ 2 bullets, no code unless asked | full answer, code, edge cases |
| Typical | first word < 1 s, done in 2–3 s | first word 2–5 s, done when it's done |

Under each reply a line shows *first word · total · words · model*, and `ghost.log` records the same per request, so "it took 13 s" is diagnosable: long answers are a length problem (use Instant), slow first words are a thinking/model problem (check the mode), slow with a screenshot is vision (use Answer).

* **No "thinking" (biggest lever).** Gemini 2.5 Flash thinks before every reply by default — 1–4 s of silence before the first word. Instant mode turns it off entirely; Think mode's level is set in ⚙. For conversational answers Instant is nearly indistinguishable in quality.
* **Answer without a screenshot.** Capture + upload + vision processing adds 1–2 s. Use **Answer** when the question was spoken; **Ask + 📷** when the screen matters. Screenshots are capped at 1280 px (configurable) and captured concurrently with the transcript catch-up.
* **Auto-answer (opt-in, off by default).** When the other side's line looks like a question ("what/how/why…", "can you walk me through…", ends with "?"), Ghost starts the transcript-only answer immediately — no click — so it's on screen before you'd have pressed anything. Toggle in ⚙; replies are marked *auto-answered*. It never fires on your own lines, never overlaps a running reply, and rate-limits itself to one every 6 s.
* **Streaming everywhere.** Words are rendered as they arrive; transcription is streamed (Live API); the system prompt is cached on Claude (`cache_control`) so its tokens aren't re-processed each turn.
* Fastest models: `gemini-2.5-flash-lite` / `claude-haiku-4-5` if you want to trade a little quality for speed — pick them in ⚙.

## Where requests go (and how to stop them)

Ghost only spends API requests in five places, and all of them go through one **request governor** (`src/governor.js`):

| Kind | When | Throttled? |
|---|---|---|
| answer | you press Answer / Ask / Enter (or auto-answer, if you opted in) | never — but counted |
| live | one Live-API session per audio source while listening (a WebSocket, not per-request) | refused only when paused |
| transcribe | chunked fallback only (off by default) | yes |
| memory | rolling summary, at most every 5 min while listening and only once ≥1.5 k chars have aged out | yes |
| digest | once per document you add | yes |

**Model names are resolved against your key's live list.** Google retires models and new keys/projects only see current ones (a fresh `AQ.` key may have Gemini 3.x only). Before every request Ghost checks the configured Gemini model against `GET /models` for that key; if it isn't there, it picks the best available by preference (3.1 Flash-Lite → 3.1 Flash → 2.5 Flash-Lite → 2.5 Flash → Gemma 3…), tells you in the reply, and saves the choice. Same for the transcription/summary model.

**Overloaded models don't stall you.** A Gemini model that returns 503 *"high demand"* — or doesn't answer within 15 s — is skipped for the next available model immediately (the reply says which), instead of hanging for a minute and failing.

**Quota errors are specific and self-healing.** A Gemini 429 is decoded into *which* limit tripped — requests-per-minute, tokens-per-minute, or the **per-model daily free-tier cap** — with the retry time. Every Gemini model has its own daily cap, so when one is used up (typically `flash-lite` after a heavy day), the request is automatically re-sent on a sibling model (`flash`, then `2.0-flash`) and the answer starts with a one-line note saying so. Per-minute limits are not retried automatically (they clear in seconds; the message tells you how many).

Throttled kinds share a budget (default 10/min, ⚙) and **stop entirely** for 90 s after any rate-limit error and for 30 min after a quota-exhausted error — so a bad minute can't snowball into a burned day. The header shows **`N req`** for the session (hover for the breakdown, incl. what was blocked), and **⏸ Pause AI** stops listening, cancels any reply and refuses every call until you press ▶. When streaming transcription dies from quota, Ghost now *stops* and says so instead of reconnecting or silently switching to chunked uploads (that switch is opt-in in ⚙ and was the cause of the "rate limited — backing off" loop).

## Context ("hella context")

* Every ask carries, labelled: **CONVERSATION MEMORY** (see below) → **LIVE TRANSCRIPT** (last 15 min / 12 k chars verbatim, each line with its age, `YOU`/`THEM`, and `NEW` since your last answer, plus whatever is being said right now) → **SCREENSHOT** → **USER NOTE**. The system prompt tells the model how to prioritise them and to answer verbal questions with a "say this" block first.
* **Rolling memory** — transcript older than the live window (or overflowing it) is folded into a running summary (setting, facts, questions asked & how they were answered, open threads) by the cheap model, every minute in the background. A 2-hour call keeps its whole context at a few hundred tokens. Click the 🧠 line under the transcript to read it; toggle in ⚙.
* **Persistent sessions** — transcript, memory and chat auto-save to `session.json` and are restored on restart (within 6 h). ↺ starts a new chat but keeps transcript + memory; "clear" in the transcript panel drops those too.
* **Background notes** — paste your résumé, the job description, an agenda, product notes into ⚙ → *Background notes*; sent with every request.
* **📚 Context tab** (the book icon in the header, or drop a file anywhere on the window) — paste a whole paper, LaTeX source, a spec, notes, hit **Save to context**, and it's remembered forever and included in every answer. For anything long: a 25-page paper, a spec, a textbook chapter. Accepts `.tex .pdf .docx .md .txt` (also `.json .csv .html .bib`). LaTeX is cleaned (preamble, comments, figure/table boilerplate, `\cite`/`\ref` noise) with sections turned into headings and **maths kept**; PDFs and Word files are text-extracted. Each doc is stored under `%APPDATA%/ghost/docs/`, shows its token count, and can be toggled on/off. **🧠 Think mode gets the full text** of every enabled doc (capped at ~300 k chars total); **⚡ Instant mode gets an auto-generated digest** (~600 words: claims, method, results, definitions, glossary — made once by the cheap model, ↻ to regenerate) so the first word stays fast; docs under ~6 k chars are always sent in full, and you can force full text in Instant too. On Claude the system prompt (including documents) is cached, so a big paper costs its tokens once per session rather than per question.
* **Videos & audio as context** — drop an `.mp4` (or `.mkv .webm .mov .mp3 .m4a .wav …`) on the window, or pick it with *Add files…*. The bundled ffmpeg pulls the audio, it's cut at natural pauses, and the offline Parakeet recogniser (the same accuracy model used for live listening) transcribes it **on your computer, for free — nothing is uploaded**. You get a timestamped transcript (`[12:34] …`) that Ghost then knows forever; a 1-hour lecture takes a few minutes and the Context tab shows progress. Tick *Videos: also describe what's on screen* to additionally have the answering AI describe one key frame per minute (slides, code, whiteboards — duplicate frames are skipped); that costs roughly one request per minute of video, so it's off by default. First video use downloads the speech model once (~670 MB) if live listening hasn't already.
* **Links as context** — paste any public URL into *Add from a link* (or into the big paste box, or drop a link from your browser). A web page is fetched and stripped to readable text (headings, lists and tables kept; menus, scripts and footers dropped); PDFs at URLs are extracted. With *fetch the whole site* ticked (default) Ghost follows same-site links breadth-first up to 40 pages / 400 k chars, respecting `robots.txt` for the pages it follows. JavaScript-only sites are rendered in a hidden browser window and read from the DOM. A YouTube link uses the video's caption track (free, exact); if there are none and you have a Gemini key, Gemini watches the video directly.
* Chat history is compacted as it ages (old transcript blocks dropped, only the 2 latest screenshots kept) so context stays lean.

## Screenshots

`desktopCapturer` grabs the display under the mouse cursor at native resolution, downsizes to ≤1568 px on the long edge (configurable: `screenshotMaxEdge` in config), JPEG-encodes at q82, and attaches it to the message. Only the two most recent screenshots are kept in the model context; older ones are replaced with `[earlier screenshot omitted]` to keep token usage bounded.

## Config & privacy

* Config lives at `%APPDATA%/ghost/config.json` (Windows), `~/Library/Application Support/ghost/config.json` (macOS), `~/.config/ghost/config.json` (Linux).
* API keys are encrypted with `safeStorage` (DPAPI / Keychain / libsecret) before being written. The renderer process never sees the raw key — only a masked `sk-ant…abcd` preview.
* Renderer CSP is `connect-src 'none'`: the UI can't make network requests at all. All API calls happen in the main process.
* There is no telemetry, no update check, no third-party endpoint.

## Project layout

```
main.js                 Electron main: window, content protection, hotkeys, screenshot, IPC
preload.js              contextBridge API exposed to the UI as window.ghost
src/store.js            JSON config + safeStorage-encrypted keys
src/docs.js             document library (extract, clean LaTeX, store, digest)
src/web.js              URL → text: HTML stripping, whole-site crawl, robots.txt, JS-app render fallback
src/media.js            video/audio → transcript: bundled ffmpeg + pause segmenter + offline Parakeet; key frames; YouTube captions
src/providers/
  index.js              provider switch + system prompt assembly
  claude.js             @anthropic-ai/sdk streaming (adaptive thinking, effort, refusal fallback)
  gemini.js             REST streaming + chunked audio transcription (fallback)
  gemini-live.js        streaming speech-to-text over the Live API WebSocket
  prompts.js            core prompt + profiles
src/renderer/
  index.html / styles.css
  app.js                chat state, streaming render, listening, settings
  audio.js              getDisplayMedia/getUserMedia → 16 kHz WAV chunks with silence gate
  markdown.js           tiny dependency-free markdown renderer
test/
  affinity-probe.ps1    verifies WDA_EXCLUDEFROMCAPTURE from outside the process
  exp-main.js / exp-probe.ps1   the experiment that found the two Electron gotchas
  smoke-*.js            snippets run by `npm run smoke`
```

`npm test` runs three offline suites: the Gemini REST provider against a mock of Google's SSE wire format (caught a CRLF bug), the Live transcriber against a mock of the Live WebSocket protocol (model fallback, delta/cumulative transcripts, goAway reconnect, nudge, bad key), and the "friend asks a question, click Ask" scenario end to end. `npm run smoke` boots the real app, takes a screenshot through the real capture path, exercises the chat error path, markdown, settings UI, a settings round-trip (key must be encrypted on disk, masked value must never clobber the real key), real-network reachability of both API endpoints, and both audio sources; it uses an isolated `userData` so it never touches your real config, writes PNGs to `%TEMP%`, and exits.

## Building an installer

**macOS:** see [BUILD-MAC.md](BUILD-MAC.md) — the code is fully Mac-compatible; run `npm run dist:mac` on a Mac to produce `Ghost-arm64.dmg` / `Ghost-x64.dmg`. Content protection, local transcription, tray, and ⌘ hotkeys all work; system-audio capture uses BlackHole (documented there).


```
npm run dist
```
produces `dist/Ghost.exe` — a single **portable** executable (no install; double-click it from anywhere). It shares the same config, context documents and session (`%APPDATA%\ghost`) as `npm start`, so you can switch between the two freely. First launch takes a few seconds longer while it unpacks itself. `signAndEditExecutable` is off so the build needs no admin rights (it just means the file keeps the default Electron icon). For an NSIS installer instead: `npx electron-builder --win nsis`.

## Notes

* macOS will prompt for **Screen Recording** (for screenshots) and **Microphone** permissions the first time; grant them in System Settings → Privacy & Security if the prompt was dismissed.
* If the overlay is invisible to *you* after a display change, press the toggle hotkey twice — it re-centers on the display under the cursor.
* This is a personal tool. Whether it's appropriate to use in a given interview, exam or meeting is up to you and the rules you've agreed to.
