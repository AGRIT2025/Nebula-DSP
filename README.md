# Nebula DSP

**Professional open-source audio DSP with acoustic room correction — runs on Linux (x86, ARM, Raspberry Pi)**

Nebula DSP transforms any Linux device into a high-end digital signal processor comparable to commercial systems like Dirac Live or Trinnov — fully integrated, fully open source.

---

## Installation

### Requirements
- Linux: Ubuntu 22.04+, Debian 12+, or Arch Linux
- Architectures: x86_64, aarch64, armv7l, armv6l (Raspberry Pi 3/4/5)
- Audio: ALSA, PipeWire, or PulseAudio
- Python 3.10+
- A USB audio interface (or built-in audio)
- A measurement microphone (for room correction)

### Quick Install

```bash
# Clone the repository
git clone https://github.com/AGRIT2025/Nebula-DSP.git
cd Nebula-DSP

# Run the installer as root
sudo bash install.sh
```

The installer automatically:
1. Detects your Linux distribution and architecture
2. Detects the installed audio backend (ALSA / PipeWire / PulseAudio)
3. Downloads and installs the correct CamillaDSP engine binary
4. Installs the Python backend and all dependencies in an isolated virtualenv
5. Detects any connected USB audio device and generates an initial configuration
6. Copies the compiled frontend to the web server
7. Creates and starts 4 systemd services

### After Installation

Open your browser and go to:
```
http://localhost:5005/gui
```

### Service Management

```bash
# Check status
systemctl status nebula-engine
systemctl status nebula-gui
systemctl status nebula-usb-watcher
systemctl status nebula-room-correction

# View live logs
journalctl -u nebula-engine -u nebula-gui -u nebula-room-correction -f

# Restart all services
sudo systemctl restart nebula-engine nebula-gui nebula-room-correction
```

### Building the Frontend (for developers)

```bash
cd frontend
npm install
npm run build       # Output goes to frontend/dist/
```

### Room Correction Dependencies

Room correction requires additional Python packages (installed automatically by `install.sh`):

```bash
pip install sounddevice scipy numpy pyyaml websockets
```

### Directory Structure

```
Nebula-DSP/
├── install.sh                    # One-command installer for Linux
├── usb_watcher.py                # USB audio hot-swap daemon
├── room_correction.py            # Acoustic measurement engine
├── room_correction_server.py     # Room correction HTTP API (port 5006)
└── frontend/                     # React web interface
    ├── src/
    │   ├── components/
    │   │   ├── Dashboard/        # Real-time monitoring
    │   │   ├── Compressor/       # Dynamics processing
    │   │   ├── Filters/          # Filter chain editor
    │   │   ├── Pipeline/         # Signal flow diagram
    │   │   ├── Volume/           # Multi-fader volume control
    │   │   ├── Devices/          # Audio device manager
    │   │   └── RoomCorrection/   # Acoustic measurement & correction
    │   └── lib/
    │       └── nebulaAPI.ts      # Typed API client
    └── dist/                     # Built frontend (served by backend)
```

---

## Features

### Real-Time Dashboard
- Live VU meters for all capture and playback channels with RMS + peak hold
- CPU processing load, capture sample rate, buffer level
- Master volume display with mute status
- Round-trip latency meter with quality rating (Excellent / Good / Moderate / High)
- Automatic clipping detector with one-click volume reduction

### Master Volume & Multi-Fader Mixer
- Vertical analog-style faders for Main + Aux 1–4
- Per-channel mute buttons with visual feedback
- Direct dB input field for precise control
- Volume range: -80 dB to +20 dB with 0.1 dB resolution

### Dynamic Compressor
- Threshold, ratio, attack, release, knee, and makeup gain controls
- Real-time transfer curve canvas with soft-knee visualization
- Gain reduction meter (horizontal bar with color coding)
- Estimated gain reduction display from live playback levels

### Filter Chain Editor
- Add, edit, and remove parametric filters
- Supports all CamillaDSP filter types: Biquad, FIR convolution, Loudness, etc.
- Expandable filter rows with per-parameter editing
- Color-coded filter type badges

### Signal Pipeline Viewer
- Visual horizontal flow diagram of the complete signal chain
- Shows capture → processing stages → playback in order
- Horizontally scrollable on mobile

### Audio Device Manager
- Lists all available audio backends (ALSA, PipeWire, WASAPI, CoreAudio, etc.)
- Browse capture and playback devices per backend
- Select and apply devices with a single click
- Refresh button for hot-plug detection

### USB Audio Hot-Swap (embedded, no udev rules)
The USB watcher is a clean Python service with four components:

- **AlsaScanner** — scans `aplay -l` output and verifies devices via `/proc/asound` and `/sys/class/sound`
- **ConfigManager** — atomically updates the CamillaDSP YAML config using temp-file-then-rename
- **CamillaDSPClient** — reloads the engine config via WebSocket without restarting the process
- **UsbAudioWatcher** — monitors kernel udev events on the `sound` subsystem, with 2.5 s settle delay to handle rapid plug/unplug events

When you plug in or unplug a USB audio interface, the service detects it within 3 seconds, updates the config, and reloads the engine — no audio interruption, no shell scripts, no udev rules.

### Room Correction (Acoustic Measurement)

Nebula DSP includes a fully integrated acoustic measurement and filter generation system — equivalent to the workflow of REW (Room EQ Wizard) but completely automated from the web interface.

**Measurement Pipeline:**
1. Generates a logarithmic swept sine (20 Hz → 20 kHz, 3 seconds)
2. Plays it through the speakers while recording through the microphone input simultaneously
3. Deconvolves the recording using Wiener deconvolution to extract the room impulse response
4. Applies a Hann window to isolate the direct sound from early reflections
5. Computes the FFT with 1/6-octave smoothing
6. Displays the frequency response curve (20 Hz – 20 kHz, normalized to 1 kHz)

**Filter Generation — IIR Mode (low latency):**
- Compares the measured response against the selected target curve
- Generates parametric EQ biquad filters (Peaking type) at 10 ISO bands: 31, 63, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz
- Maximum correction: ±12 dB per band, minimum threshold: 0.5 dB (skips negligible corrections)
- Q factor: 1.41 (one-octave bandwidth)

**Filter Generation — FIR Mode (maximum quality):**
- Computes a minimum-phase FIR inverse filter in the frequency domain
- Cepstrum-based minimum phase conversion for linear phase correction without pre-ringing
- 8192 taps default (configurable), Hann-windowed, normalized to prevent clipping
- Outputs a raw float32 file ready for CamillaDSP `fftconv` convolution

**Target Curves:**
| Curve | Description |
|---|---|
| Flat | 0 dB reference — corrects to ruler-flat response |
| Harman 2018 | +4 dB bass shelf below 200 Hz, -3 dB/oct treble above 2 kHz |
| Bass Boost | Gaussian +4 dB peak centered at 80 Hz |
| Hi-Fi | Gentle -2 dB/decade high-frequency roll-off |

**Visualization:**
- Canvas FFT graph with logarithmic frequency axis (20 Hz – 20 kHz)
- Three overlaid curves: measured (cyan), corrected (indigo), target (green dashed)
- Real-time measurement progress bar
- Biquad filter table with frequency, gain, and Q values

**Apply / Remove:**
- Injects the generated filters directly into the running CamillaDSP config via WebSocket
- Engine reloads in real-time with no audio interruption
- One-click removal of all correction filters
- Export the corrected configuration as a downloadable YAML file

### Comparison with Commercial Systems

| Feature | Dirac Live | REW + CamillaDSP | **Nebula DSP** |
|---|---|---|---|
| Automatic measurement | ✅ | Manual | ✅ Automatic |
| Automatic filter generation | ✅ | Manual export | ✅ Automatic |
| Direct engine injection | ✅ | ❌ Manual import | ✅ Direct via WebSocket |
| Integrated web interface | ✅ | ❌ Separate apps | ✅ Single UI |
| Open source | ❌ | Partial | ✅ 100% |
| Custom target curves | Limited | ✅ | ✅ |
| Cost | $199–$799 | Free (manual) | **Free** |

### Modern Web Interface
- Dark minimal design optimized for studio and broadcast environments
- Fully responsive: desktop, tablet, and mobile
- Animated VU meters with peak hold, clip indicators, and color gradients
- Live engine status indicator (pulsing dot) in the sidebar
- USB device status badge with change detection

---

## Architecture

```
┌─────────────────────────────────────┐
│        Nebula DSP Web Interface     │
│     (React + Vite, port 5005/gui)   │
└────────────────┬────────────────────┘
                 │ HTTP REST API
        ┌────────┴──────────┐
        │                   │
┌───────▼──────┐   ┌────────▼────────────┐
│  CamillaGUI  │   │ Room Correction API │
│   Backend    │   │ (aiohttp, port 5006)│
│  (port 5005) │   └────────┬────────────┘
└───────┬──────┘            │
        │                   │
        └────────┬──────────┘
                 │ WebSocket (port 1234)
        ┌────────▼────────────┐
        │   CamillaDSP Engine │
        │      (Rust)         │
        └─────────────────────┘
```

**Services running after install:**
| Service | Description | Port |
|---|---|---|
| `nebula-engine` | CamillaDSP audio engine | 1234 (WS) |
| `nebula-gui` | Python HTTP/API backend | 5005 |
| `nebula-usb-watcher` | USB device hot-swap daemon | — |
| `nebula-room-correction` | Acoustic measurement API | 5006 |

---

## Configuration

The main config file is located at:
```
/etc/nebula-dsp/configs/default.yml
```

Example configuration for a USB audio interface:
```yaml
devices:
  samplerate: 48000
  chunksize: 4096
  queuelimit: 4
  capture:
    type: Alsa
    channels: 2
    device: "hw:1,0"
    format: S32_LE
  playback:
    type: Alsa
    channels: 2
    device: "hw:1,0"
    format: S32_LE

filters: {}
pipeline: []
```

---

## License

Nebula DSP frontend and Python modules are released under the MIT License.
The CamillaDSP engine is developed by Henrik Enquist and licensed under the GNU GPL v3.

---

## Acknowledgements

Built on top of [CamillaDSP](https://github.com/HEnquist/camilladsp) by Henrik Enquist — an exceptional open-source audio processing engine.
