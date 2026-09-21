# Building Ghost for macOS

Ghost is fully macOS-compatible (content protection = `NSWindowSharingNone`, panel window, Keychain key storage, local Parakeet/NeMo STT with the darwin native module, tray, global hotkeys with ⌘). The one thing that **must happen on a Mac** is the final build — Apple's native modules, code-signing and notarization can't be produced from Windows.

## On a Mac (Apple Silicon or Intel)

```bash
# 1. Clone/copy this folder to the Mac, then:
npm install            # pulls the macOS Electron + sherpa-onnx-darwin-* native module
npm run dist:mac       # builds dist/Ghost-arm64.dmg and dist/Ghost-x64.dmg
```

That's it — double-click the `.dmg`, drag Ghost to Applications, launch.

- **Unsigned build (free):** the first launch is blocked by Gatekeeper. Right-click the app → **Open** → **Open**, once. Or `xattr -dr com.apple.quarantine /Applications/Ghost.app`.
- **Signed + notarized (needs a $99/yr Apple Developer account):** set these env vars before `npm run dist:mac` and electron-builder signs + notarizes automatically:
  ```bash
  export CSC_LINK=/path/to/DeveloperIDApplication.p12
  export CSC_KEY_PASSWORD=…
  export APPLE_ID=you@example.com
  export APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop   # appleid.apple.com → App-Specific Passwords
  export APPLE_TEAM_ID=XXXXXXXXXX
  ```

## macOS permissions (granted on first use)
- **Microphone** — for transcribing your voice. Prompt appears on first Listen.
- **Screen Recording** — for the Ask screenshot **and** for hiding Ghost from screen shares. Grant it in System Settings → Privacy & Security → Screen Recording, then relaunch Ghost.

## System audio ("them" side of a call) on macOS
macOS has no built-in loopback, so the other people's audio needs a virtual audio device:
1. Install **BlackHole 2ch** (free): `brew install blackhole-2ch`.
2. In **Audio MIDI Setup**, create a **Multi-Output Device** = your speakers/headphones **+** BlackHole (so you still hear the call while it's also sent to BlackHole). Set it as the system output.
3. In Ghost ⚙ → **Call audio capture device** → pick **BlackHole 2ch** (or use 🔎 Find the device with audio).

Your mic works with no setup. Everything else — Parakeet accuracy pass, Haiku cleanup, all providers, context, invisibility — is identical to Windows.

## Notes
- Build a **universal** app instead of two per-arch dmgs by changing `target` arch to `["universal"]` in `package.json` → `build.mac`.
- `LSUIElement` is set so Ghost has no Dock icon (it lives in the menu-bar tray), matching the Windows "hidden from taskbar" behaviour.
