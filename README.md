# Nebula DSP

**Professional open-source audio DSP with acoustic room correction and a true-peak lookahead brickwall limiter — runs on Linux (x86, ARM, Raspberry Pi)**

Nebula DSP turns any Linux device into a high-end digital signal processor comparable to commercial systems like Dirac Live or Trinnov — fully integrated, fully open source. It wraps Henrik Enquist's [CamillaDSP](https://github.com/HEnquist/camilladsp) engine with a modern React web GUI, an automated REW-style room measurement pipeline, USB-audio hot-swap, and a standalone Rust sidecar that fixes one of CamillaDSP's documented limitations: the upstream `Limiter` filter is a per-sample hard/soft clipper with no lookahead and no true-peak detection, so transients distort and inter-sample peaks clip at the DAC. Nebula ships a 400-LOC Rust binary that solves that, transparently, with ~3 ms of added latency.

---

## Installation

### Requirements
- Linux: Ubuntu 22.04+, Debian 12+, Arch Linux (others should also work — installer auto-detects the package manager)
- Architectures: x86_64, aarch64, armv7l, armv6l (Raspberry Pi 3 / 4 / 5)
- Audio: ALSA, PipeWire, or PulseAudio
- Python 3.10+
- A USB audio interface (or built-in audio)
- A measurement microphone (optional, for room correction)

The installer also pulls in (no manual setup needed):
- Rust toolchain via `rustup` (minimal profile, ~70 MB) — only used to build `nebula-limiter` once
- `libasound2-dev` + `pkg-config` for the Rust ALSA bindings
- The `snd-aloop` kernel module for the limiter loopback insertion point

### Quick Install

```bash
git clone https://github.com/AGRIT2025/Nebula-DSP.git
cd Nebula-DSP
sudo bash install.sh
```

The installer:
1. Detects your Linux distribution and architecture
2. Detects the installed audio backend (ALSA / PipeWire / PulseAudio)
3. Downloads the matching CamillaDSP engine binary from the upstream release
4. Detects any connected USB audio card and picks the best supported sample format (S32_LE / S24_3LE / S16_LE) by probing it with `arecord --dump-hw-params`
5. Generates an initial schema-compliant `/etc/nebula-dsp/camillagui.yml` and a stereo default config
6. Installs the Python backend in an isolated virtualenv, patches `main.py` to eager-connect to the engine on startup and to register the `/api/limiter/*` proxy
7. Installs the Rust toolchain (if missing), compiles `nebula-limiter` in release mode, installs the binary
8. Loads and persists `snd-aloop` so the limiter has a stable capture device
9. Creates and starts **3 systemd services** (engine, consolidated backend, lookahead limiter sidecar). Room Correction and USB hot-swap now live inside the same backend process as the GUI API — one Python event loop, one log stream
10. Copies the pre-built frontend bundle to the static path served at `/gui/`

### After Installation

Open your browser to:

```
http://localhost:5005/
```

You'll be redirected to `/gui/index.html`. The app uses `HashRouter`, so tab URLs look like `/gui/index.html#/limiter`, `/gui/index.html#/pipeline`, etc. — they're robust to page refresh because the path before the `#` is always served as a real file by aiohttp.

### Service Management

```bash
# Status (3 services total after consolidation)
systemctl status nebula-engine          # CamillaDSP audio engine
systemctl status nebula-backend         # aiohttp: GUI + API + Room Correction + USB watcher
systemctl status nebula-limiter         # Rust brickwall sidecar (optional)

# Live logs (everything Python-side is in one stream now)
journalctl -u nebula-engine -u nebula-backend -u nebula-limiter -f

# Restart everything
sudo systemctl restart nebula-engine nebula-backend nebula-limiter
```

### Building the Frontend (for developers)

```bash
cd frontend
npm install
npm run build       # output goes to frontend/dist/
```

The `frontend/dist/` bundle is committed to the repo so `install.sh` can ship a working GUI without Node on the target machine. Re-run `npm run build` whenever you change frontend sources and commit the result.

### Building the Limiter (for developers)

```bash
cd nebula-limiter
cargo build --release
cargo test --release    # six unit tests: brickwall, bypass, transient, true-peak, release, stereo
```

`Cargo.lock` is committed so clean clones produce a byte-identical binary.

### Directory Structure

```
Nebula-DSP/
├── install.sh                         # One-command installer (Linux only)
├── usb_watcher.py                     # USB hot-swap — exposes setup(app), runs as background task in backend
├── room_correction.py                 # Acoustic measurement engine (sweep + Wiener + IIR/FIR design)
├── room_correction_server.py          # Room correction routes — exposes setup(app) onto the backend
├── backend/
│   └── nebula_limiter_routes.py       # aiohttp proxy → nebula-limiter Unix socket
├── nebula-limiter/                    # Rust sidecar: lookahead brickwall limiter
│   ├── Cargo.toml
│   ├── Cargo.lock                     # pinned for reproducible builds
│   └── src/
│       ├── main.rs                    # CLI + ALSA capture/playback loop
│       ├── limiter.rs                 # Algorithm + 6 unit tests
│       └── control.rs                 # Unix socket JSON protocol
└── frontend/                          # React 19 + Vite 8 + Tailwind v4
    ├── src/
    │   ├── App.tsx                    # HashRouter + route table
    │   ├── components/
    │   │   ├── Dashboard/             # Real-time VU + status
    │   │   ├── Compressor/            # CamillaDSP Compressor processor editor
    │   │   ├── Limiter/               # nebula-limiter live params + stats
    │   │   ├── Filters/               # Parametric EQ editor (Biquad ×6 sub-types)
    │   │   ├── Pipeline/              # Live signal-chain visualization
    │   │   ├── Volume/                # Master + 4 aux faders
    │   │   ├── Devices/               # ALSA backend/device browser
    │   │   ├── RoomCorrection/        # Sweep, FFT, target curves, IIR + FIR
    │   │   └── ui/                    # Layout, Card, VuMeter, UsbDeviceStatus
    │   └── lib/
    │       ├── nebulaAPI.ts           # Typed HTTP client
    │       └── biquad.ts              # RBJ Audio EQ Cookbook math (matches engine)
    └── dist/                          # Pre-built bundle (committed, served by backend)
```

---

## Features

### Real-Time Dashboard
- Live VU meters for all capture and playback channels with RMS + peak hold
- CPU processing load, capture sample rate, buffer level
- Master volume display with mute status
- Round-trip latency meter with quality rating (Excellent / Good / Moderate / High)
- Automatic clipping detector with one-click volume reduction
- USB device status pill that detects card changes from the active ALSA device list

### Master Volume & Multi-Fader Mixer
- Vertical analog-style faders for Main + Aux 1–4
- Per-fader mute buttons
- Direct dB input field for precise control
- Volume range: -80 dB to +20 dB with 0.1 dB resolution

CamillaDSP's volume model has 5 independent fader buses (Main + Aux 1–4); they are NOT one fader per channel. The Main fader is multi-channel — it affects every channel of the audio path. Aux 1–4 only become useful when the pipeline contains `Volume` filters pointing at those indices; when none exist, only Main shows in the UI (auto-collapsed from `getlistparam/fadervolume`).

### Dynamic Compressor (writes the engine's Compressor processor)
- Threshold, ratio, attack, release, makeup gain controls — all written to the active YAML
- `Apply` validates the config via `/api/validateconfig` before calling `/api/setconfig`, so a bad value surfaces as an inline error instead of crashing the engine
- `Bypass` removes the processor entry and the corresponding pipeline step
- Transfer curve canvas with soft-knee visualization
- Gain reduction estimate (proxy: `max(playback_peak) − max(capture_peak) − makeup_gain`, smoothed) — upstream CamillaDSP does not expose per-channel GR from the Compressor processor, so the UI labels this as `(estimate)`

### Brickwall Limiter (lookahead, true-peak)

A separate Rust binary running as `nebula-limiter.service` — solves the well-documented gap in CamillaDSP's `Limiter` filter, which is a per-sample hard / soft clip with no lookahead and no oversampling, where:
- Hard clip causes audible aliasing on transients
- Soft clip introduces "some harmonic distortion to the signal" (HEnquist's own docs)
- Inter-sample peaks pass through and clip at the DAC

**Algorithm (Signalsmith Audio canonical lookahead limiter):**
1. For each input sample compute `target = ceiling / max(|sample|, ceiling)` — guaranteed ≤ 1
2. Push targets into a ring of size **L+1** (L = lookahead in samples)
3. The applied gain is the sliding minimum over that ring — the lowest target across the next L samples, so a peak L samples ahead pulls the gain down ahead of time
4. Output = `delayed_input × gain`. By construction `|output| ≤ ceiling` — it's a mathematical brickwall, not a clip
5. One-pole release smoother on the recovery side only (attack is instant because lookahead already covers it)
6. Optional 2× true-peak detection: side-chain is upsampled by a 31-tap halfband FIR so inter-sample peaks are caught. Only the side-chain is oversampled; the audio path stays at native rate (no extra delay, no aliasing)

**Six unit tests** verify brickwall holds under: 0 dBFS sine + 1.5× over-amplitude sine, quiet-signal unity-gain bypass, single-sample transients, Nyquist-rate true-peak content, release ramp smoothness, and stereo 0 dBFS with true-peak on.

**Performance** on Intel Core i5 / ALC3204 at 48 kHz × 2 ch:
- Default lookahead: **3 ms** (144 samples) — imperceptible
- ALSA period 256 × 4 periods = ~21 ms buffer
- ~3 % of one CPU core under sustained processing
- `samples_clipped` counter stays at **0** (any non-zero would indicate an algorithm bug)

**Live tab in the GUI:**
- GR bar (0 to -24 dB, color-graded)
- Counters: ISPs caught · samples clipped (should always be 0) · samples processed · algo latency
- Sliders for ceiling (-6 to 0 dBFS), lookahead (1 / 3 / 5 ms), release, 2× true-peak toggle
- All sliders write to `/api/limiter/params` → the sidecar applies them at the next audio block boundary, without restarting

**Topology:**

```
upstream source → CamillaDSP engine → snd-aloop (hw:Loopback,0,0)
                                    ↓
                                    hw:Loopback,1,0 → nebula-limiter → DAC
```

The default systemd unit ships `--playback null` so the sidecar runs at boot without grabbing the physical DAC (avoiding contention with `nebula-engine`). Re-point `--playback` to your DAC from the unit file (or via a future GUI control) once your audio path is set up.

### Filter Chain Editor (parametric EQ)

Full editor for the six common Biquad sub-types — Peaking, Highshelf, Lowshelf, Highpass, Lowpass, Notch:

- Add filter dropdown: pick sub-type → click `+ Add filter` → new band with sensible defaults for that sub-type
- Per-row controls: type select · log-scale freq slider (20 Hz – 20 kHz) · Q slider (0.1 – 30) · gain slider (auto-disabled for HP / LP / Notch which don't use gain) · bypass toggle · delete
- **Frequency Response canvas** with log-frequency axis 20 Hz – 20 kHz and ±24 dB grid:
  - Translucent per-filter curves (color-coded by sub-type)
  - Solid white "combined" curve showing the sum of all enabled bands in dB
- **Interactive graph:**
  - Drag a point horizontally → moves the band's `freq`
  - Drag vertically → adjusts `gain` (for bands that use it)
  - Mouse wheel over a point → adjusts `Q` multiplicatively (×1.1 per notch), clamped 0.1 – 30
  - Hover shows a tooltip with `subtype · freq · Q · gain`
- `Apply` runs `validateConfig` then `setConfig` so malformed bands surface as inline errors
- `Reload` re-reads the active YAML (useful after Room Correction injected its own filters, or you hand-edited)

**Naming convention**: bands owned by this tab are prefixed `eq_` (e.g. `eq_1`, `eq_2`). Filters with any other name (Conv kernels from Room Correction, hand-edited `rc_fir_*`, etc.) are preserved untouched across saves — the tab only touches `eq_*` entries and the corresponding `Filter` pipeline step.

The math (`src/lib/biquad.ts`) uses the RBJ Audio EQ Cookbook formulas — the same math CamillaDSP uses internally — so the on-screen graph and the engine's actual filter response are bit-identical.

### Signal Pipeline Viewer
- Live horizontal flow diagram of the complete signal chain
- Reads `pipeline` from the active YAML every 3 s and renders one node per step:
  - **Capture** (always — leftmost, with device + channel count)
  - **Mixer**, **Filter (single)**, **Filter chain**, **Compressor / Limiter (Filter chain w/ dynamics)**, **Processor**
  - **Limiter** (the Nebula sidecar) — inserted automatically when `nebula-limiter` is online, just before Playback
  - **Playback** (always — rightmost)
- Horizontally scrollable on small viewports

### Audio Device Manager
- Lists all available audio backends (ALSA, PipeWire, WASAPI, CoreAudio, etc.) reported by `/api/backends`
- Browse capture and playback devices per backend via `/api/capturedevices/<backend>` and `/api/playbackdevices/<backend>`
- Refresh button for hot-plug detection

### USB Audio Hot-Swap (embedded, no udev rules)

The USB watcher is a Python service with four components:

- **AlsaScanner** — scans `aplay -l` output and verifies devices via `/proc/asound` and `/sys/class/sound`
- **ConfigManager** — atomically updates the CamillaDSP YAML config using temp-file-then-rename
- **CamillaDSPClient** — reloads the engine config via WebSocket without restarting the process
- **UsbAudioWatcher** — monitors kernel udev events on the `sound` subsystem, with a 2.5 s settle delay to handle rapid plug/unplug events

When you plug in or unplug a USB audio interface, the service detects it within 3 seconds, updates the config, and reloads the engine — no audio interruption, no shell scripts, no udev rules.

### Room Correction (Acoustic Measurement)

Fully integrated REW-style measurement and filter generation, automated from the web interface.

**Measurement pipeline:**
1. Generate a logarithmic swept sine (20 Hz → 20 kHz, 3 seconds)
2. Play it through the speakers while recording the room response through the microphone simultaneously
3. Deconvolve using Wiener deconvolution to extract the room impulse response
4. Apply a Hann window to isolate the direct sound from early reflections
5. Compute the FFT with 1/6-octave smoothing
6. Display the frequency response curve (20 Hz – 20 kHz, normalized to 1 kHz)

**Filter generation — IIR mode (low latency):**
- Compares the measured response against the selected target curve
- Generates parametric biquad filters (Peaking type) at 10 ISO bands: 31, 63, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz
- Max correction: ±12 dB per band; min threshold 0.5 dB
- Q factor: 1.41 (one-octave bandwidth)

**Filter generation — FIR mode (maximum quality):**
- Minimum-phase FIR inverse filter in the frequency domain
- Cepstrum-based minimum-phase conversion for linear phase correction without pre-ringing
- 8192 taps default, Hann-windowed, normalized to prevent clipping
- Outputs a raw float32 file ready for CamillaDSP `Conv`

**Target curves:**

| Curve | Description |
|---|---|
| Flat | 0 dB reference — corrects to ruler-flat response |
| Harman 2018 | +4 dB bass shelf below 200 Hz, -3 dB/oct treble above 2 kHz |
| Bass Boost | Gaussian +4 dB peak centered at 80 Hz |
| Hi-Fi | Gentle -2 dB/decade high-frequency roll-off |

**Apply / Remove:**
- Injects the generated filters directly into the running CamillaDSP config via WebSocket — no audio interruption
- One-click removal of all correction filters
- Export the corrected configuration as a downloadable YAML

### Comparison with Commercial Systems

| Feature | Dirac Live | REW + CamillaDSP | **Nebula DSP** |
|---|---|---|---|
| Automatic measurement | ✅ | Manual | ✅ Automatic |
| Automatic filter generation | ✅ | Manual export | ✅ Automatic |
| Direct engine injection | ✅ | ❌ Manual import | ✅ Direct via WebSocket |
| Integrated web interface | ✅ | ❌ Separate apps | ✅ Single UI |
| Lookahead brickwall limiter w/ true-peak | ✅ | ❌ (CamillaDSP `Limiter` has none) | ✅ 3 ms LA + 2× ISP detector |
| Open source | ❌ | Partial | ✅ 100% |
| Custom target curves | Limited | ✅ | ✅ |
| Cost | $199–$799 | Free (manual) | **Free** |

### Modern Web Interface
- Dark minimalist design optimized for studio + broadcast environments
- Fully responsive: desktop, tablet, mobile
- Live engine status pill (pulsing dot) in the sidebar
- USB device status badge that infers presence from the real ALSA device list, not from the saved YAML (so it reflects what's *actually* connected, not what was last configured)

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Browser → React (Vite + Tailwind + lucide)      │
│   HashRouter · http://host:5005/                 │
└──────────────────────┬───────────────────────────┘
                       │ HTTP REST + WS (port 5005)
┌──────────────────────▼───────────────────────────┐
│  nebula-backend.service (UNA aiohttp Application) │
│  • static: sirve frontend/dist/ en /gui/          │
│  • /api/*        — engine control (camillagui)    │
│  • /api/rc/*     — Room Correction (consolidado)  │
│  • /api/limiter/* — proxy al sidecar Rust         │
│  • background task: UsbAudioWatcher (asyncio)     │
│  • on_startup: eager-connect al engine            │
└──┬───────────────────────────────────────┬───────┘
   │ WebSocket port 1234                   │ Unix socket
┌──▼────────────────────┐         ┌────────▼──────────────────────┐
│  CamillaDSP engine    │         │  nebula-limiter (opcional)     │
│  Rust, upstream       │         │  Rust sidecar — Brickwall +    │
│  nebula-engine.service│         │  2× true-peak detection        │
│                       │         │  nebula-limiter.service        │
└───────────────────────┘         └────────────┬───────────────────┘
            │                                  ▲
            ▼                                  │
       ALSA playback → hw:Loopback,0,0 ─── hw:Loopback,1,0 ──→ DAC
                                       (snd-aloop kernel module)
```

**Consolidación clave**: antes de v1.1, Room Correction y el USB watcher
corrían como dos services Python adicionales (`nebula-room-correction` en
el puerto 5006, `nebula-usb-watcher` como daemon). Ahora ambos viven
dentro del mismo proceso aiohttp del backend — mismo event loop, mismo
log, un único endpoint HTTP (5005) para todo.

**Engine launch flags** (`/etc/systemd/system/nebula-engine.service`):

```
camilladsp -p 1234 \
           -s /etc/nebula-dsp/statefile.yml \
           -o /var/log/nebula-dsp-engine.log \
           /etc/nebula-dsp/configs/default.yml
```

- `-p` WebSocket port for control · `-s` statefile (persists active config + gains across reboots) · `-o` log file (kept separate from the statefile — early versions had them collide) · positional configfile = boot config (no `-w` because we want the engine to load it on start, not wait)

**Services running after install (3 total):**

| Service | Description | Port |
|---|---|---|
| `nebula-engine` | CamillaDSP audio engine | 1234 (WS) |
| `nebula-backend` | aiohttp HTTP/API + frontend host + Room Correction (`/api/rc/*`) + USB hot-swap watcher (asyncio background task) | 5005 |
| `nebula-limiter` | Rust lookahead brickwall sidecar (optional) | Unix socket `/run/nebula-limiter/control.sock` |

---

## Configuration

The CamillaDSP config is at:

```
/etc/nebula-dsp/configs/default.yml
```

`install.sh` generates an initial config matched to the detected hardware. Example for a USB audio interface that supports S16_LE (typical consumer USB headset / interface; the installer auto-detects S32_LE / S24_3LE / S16_LE based on what the card actually accepts):

```yaml
devices:
  samplerate: 48000
  chunksize: 4096
  queuelimit: 4
  enable_rate_adjust: false
  capture:
    type: Alsa
    channels: 2
    device: "hw:1,0"
    format: S16_LE
  playback:
    type: Alsa
    channels: 2
    device: "hw:1,0"
    format: S16_LE

mixers: {}
filters: {}
processors: {}
pipeline: []
```

Statefile (auto-managed by the engine via `-s`):

```
/etc/nebula-dsp/statefile.yml
```

GUI backend config:

```
/etc/nebula-dsp/camillagui.yml
```

Limiter sidecar defaults (overridable in `/etc/systemd/system/nebula-limiter.service`): ceiling -1 dBFS, lookahead 3 ms, release 50 ms, 2× true-peak detection enabled.

---

## API Surface (selected)

The GUI talks to the backend over plain HTTP REST. Most of these are inherited from the upstream `camillagui-backend`; the `/api/limiter/*` ones are added by `backend/nebula_limiter_routes.py`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/status` | Engine state, processing load, signal levels, device lists |
| GET | `/api/getconfig` | Active YAML as JSON |
| POST | `/api/setconfig` | Body `{"config": <yaml>}` → replace active config |
| POST | `/api/validateconfig` | Body `<yaml>` → validate without applying |
| GET | `/api/getparam/volume` · `/api/getmute` | Master fader state |
| GET | `/api/getlistparam/fadervolume` · `/.../fadermute` | All 5 faders |
| GET | `/api/limiter/status` | Sidecar telemetry (GR, ISP hits, ceiling, latency) |
| POST | `/api/limiter/params` | Body `{ceiling_db?, lookahead_ms?, true_peak?, release_ms?}` |
| POST | `/api/limiter/reset` | Zero the sidecar counters |
| GET | `/api/rc/targets` · `/api/rc/devices` · `/api/rc/result` | Room Correction (port 5006, proxied) |
| POST | `/api/rc/measure` · `/api/rc/design` · `/api/rc/apply` · `/api/rc/remove` | Room Correction control |

---

## License

Nebula DSP frontend, Python modules, and the `nebula-limiter` Rust crate are released under the MIT License.
The CamillaDSP engine is developed by Henrik Enquist and licensed under the GNU GPL v3.

---

## Acknowledgements

- [CamillaDSP](https://github.com/HEnquist/camilladsp) by Henrik Enquist — the audio engine
- [Signalsmith Audio's lookahead-limiter writeup](https://signalsmith-audio.co.uk/writing/2022/limiter/) and [Daniel Rudrich's SimpleCompressor docs](https://github.com/DanielRudrich/SimpleCompressor/blob/master/docs/lookAheadLimiter.md) — algorithm reference for `nebula-limiter`
- [RBJ Audio EQ Cookbook](https://www.musicdsp.org/en/latest/Filters/197-rbj-audio-eq-cookbook.html) — biquad coefficient formulas used by both the engine and the GUI's response graph
