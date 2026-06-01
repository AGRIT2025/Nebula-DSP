#!/usr/bin/env python3
"""
Nebula DSP — Room Correction Engine
Acoustic measurement and automatic FIR/IIR filter generation.

Usage:
  python room_correction.py --test-sweep          # write sweep WAV and exit
  python room_correction.py --measure             # full measurement → JSON
  python room_correction.py --design measurement.json --mode iir
"""

import asyncio
import json
import logging
import math
import os
import struct
import uuid
import wave
from dataclasses import dataclass, field
from typing import Callable, Coroutine, List, Optional, Literal

logger = logging.getLogger("nebula.rc")
# Use the same logger that room_correction_server configured with a
# StreamHandler — that way the RC INFO messages reach journald even
# when the module is imported BEFORE the server's handler setup runs
# (logging.getLogger returns the same logger instance by name, so any
# handlers attached later still apply).

# ─── Data structures ────────────────────────────────────────────────────────────

@dataclass
class MeasurementResult:
    frequencies:       List[float]
    magnitude_db:      List[float]
    impulse_response:  List[float]
    sample_rate:       int
    measurement_id:    str = field(default_factory=lambda: uuid.uuid4().hex[:8])


@dataclass
class BiquadFilter:
    filter_type: str    # "Peaking" | "Highshelf" | "Lowshelf"
    freq:        float
    gain:        float
    q:           float


@dataclass
class DesignResult:
    mode:          Literal["iir", "fir"]
    biquads:       List[BiquadFilter]
    fir_path:      Optional[str]
    target_label:  str
    correction_db: List[float]


ProgressCallback = Callable[[int, str], Coroutine]


# ─── Target Curves ──────────────────────────────────────────────────────────────

class TargetCurveManager:
    """Defines reference target frequency responses for room correction."""

    CURVES = {
        "flat":       "Flat (0 dB)",
        "harman2018": "Harman 2018",
        "bass_boost": "Bass Boost (+4 dB @ 80 Hz)",
        "hi_fi":      "Hi-Fi Gentle Roll-off",
    }

    @staticmethod
    def get(name: str, frequencies) -> "np.ndarray":
        import numpy as np
        freqs = np.asarray(frequencies, dtype=float)

        if name == "flat":
            return np.zeros(len(freqs))

        elif name == "harman2018":
            # Simplified Harman 2018: bass shelf +4 dB below 200 Hz,
            # gentle treble tilt -3 dB/octave above 2 kHz
            target = np.zeros(len(freqs))
            for i, f in enumerate(freqs):
                if f > 0 and f < 200:
                    target[i] = 4.0 * (1.0 - f / 200.0)
                elif f >= 2000:
                    target[i] = -3.0 * math.log2(f / 2000.0)
            return target

        elif name == "bass_boost":
            target = np.zeros(len(freqs))
            for i, f in enumerate(freqs):
                if f > 0:
                    target[i] = 4.0 * math.exp(-((math.log(max(f, 1) / 80.0)) ** 2) / 0.8)
            return target

        elif name == "hi_fi":
            target = np.zeros(len(freqs))
            for i, f in enumerate(freqs):
                if f > 1000:
                    target[i] = -2.0 * math.log10(f / 1000.0)
            return target

        return np.zeros(len(freqs))

    @classmethod
    def list_curves(cls) -> List[dict]:
        return [{"id": k, "label": v} for k, v in cls.CURVES.items()]


# ─── Measurement Engine ─────────────────────────────────────────────────────────

class MeasurementEngine:
    """
    Measures room impulse response using a logarithmic swept sine.
    Plays through the DAC output and records from the ADC input simultaneously.
    """

    def __init__(
        self,
        sample_rate:     int            = 48000,
        sweep_duration:  float          = 3.0,
        silence_pre:     float          = 0.5,
        silence_post:    float          = 1.0,
        output_device:   Optional[int]  = None,
        input_device:    Optional[int]  = None,
        alsa_device:     Optional[str]  = None,   # e.g. "hw:1,0" — bypasses sounddevice/JACK
        alsa_format:     Optional[str]  = None,   # e.g. "S32_LE"
    ):
        self.sample_rate    = sample_rate
        self.sweep_duration = sweep_duration
        self.silence_pre    = silence_pre
        self.silence_post   = silence_post
        self.output_device  = output_device
        self.input_device   = input_device
        self.alsa_device    = alsa_device
        self.alsa_format    = alsa_format or "S32_LE"

    def _generate_sweep(self):
        """Return (full_signal, raw_sweep, k_factor) as float32 + scalar.

        Generates a logarithmic sine sweep from 20 Hz → 20 kHz over
        `sweep_duration` seconds, **without** a Hanning window: the
        Farina-style inverse-sweep deconvolution we use later expects
        the raw sweep with controlled amplitude (constant) so the
        inverse-sweep envelope can compensate the pink spectrum
        analytically.  Soft fades (10 ms) at both ends prevent the
        click-on-start without throwing away low-frequency energy.

        `k_factor = log(f1/f0) / T` is needed to build the inverse
        sweep with proper amplitude envelope.
        """
        import numpy as np

        f0, f1 = 20.0, 20000.0
        T = self.sweep_duration
        n_sweep = int(T * self.sample_rate)
        n_pre   = int(self.silence_pre  * self.sample_rate)
        n_post  = int(self.silence_post * self.sample_rate)

        # Logarithmic sweep — Farina formulation.
        # phase(t) = 2π f0 T / log(f1/f0) · (exp(t/T·log(f1/f0)) - 1)
        t = np.linspace(0, T, n_sweep, endpoint=False)
        L = T / np.log(f1 / f0)
        phase = 2 * np.pi * f0 * L * (np.exp(t / L) - 1.0)
        # Amplitude 0.85 (-1.4 dBFS) — louder than the previous -6 dBFS
        # default to improve SNR at the mic input. Still leaves ~1.4 dB
        # of digital headroom; the speaker analog chain will determine
        # the real acoustic SPL.
        sweep = 0.85 * np.sin(phase)

        # 10 ms cosine fade in/out (prevents click without losing LF content)
        fade_n = int(0.010 * self.sample_rate)
        if fade_n > 0 and 2 * fade_n < n_sweep:
            fade = 0.5 * (1 - np.cos(np.pi * np.arange(fade_n) / fade_n))
            sweep[:fade_n]      *= fade
            sweep[-fade_n:]     *= fade[::-1]

        signal = np.concatenate([np.zeros(n_pre), sweep, np.zeros(n_post)])
        k_factor = np.log(f1 / f0) / T
        return signal.astype(np.float32), sweep.astype(np.float32), float(k_factor)

    async def measure(self, progress_cb: Optional[ProgressCallback] = None) -> MeasurementResult:
        """Play sweep, record simultaneously, deconvolve → IR → FFT.

        Algorithm (Farina 2000 + cross-correlation alignment):
          1. Generate logarithmic sweep s(t).
          2. Play s(t) on the DAC, record y(t) on the mic.
          3. Cross-correlate y(t) against s(t) to find the actual
             time offset (compensates ALSA buffer + acoustic latency
             which is otherwise unknown).
          4. Extract the aligned recording window.
          5. Build inverse sweep i(t) = s(T-t) · exp(t · k) — its
             convolution with the system's response gives the IR
             directly, well-conditioned, with linear distortion
             products separated from the linear IR.
          6. IR = (y * i) — pick the linear lobe near the end.
          7. Window IR to first 50 ms (direct sound + early reflections).
          8. FFT → frequency response.
        """
        import numpy as np

        signal, sweep, k_factor = self._generate_sweep()
        n_sweep = len(sweep)
        n_pre   = int(self.silence_pre * self.sample_rate)

        async def prog(pct: int, msg: str):
            if progress_cb:
                await progress_cb(pct, msg)

        await prog(5, "Generating sweep signal…")
        await prog(10, "Playing sweep and recording…")

        if self.alsa_device:
            recording = await self._playrec_alsa_direct(signal)
        else:
            recording = await self._playrec_sounddevice(signal)

        rec_peak = float(np.max(np.abs(recording))) if len(recording) > 0 else 0.0
        rec_dbfs = 20.0 * np.log10(max(rec_peak, 1e-9))
        logger.info("RC: recording length=%d (%.2fs)  peak=%.3f (%.1f dBFS)",
                    len(recording), len(recording) / self.sample_rate,
                    rec_peak, rec_dbfs)

        # Sanity check: a usable measurement needs the mic to actually
        # hear the sweep. Below ~ -36 dBFS the SNR is so low that the
        # deconvolution produces a garbage response; report a clear
        # error so the user knows to check cables / gain / speaker
        # power instead of staring at a bizarre 70-dB-span graph.
        if rec_peak < 0.015:    # -36 dBFS
            raise RuntimeError(
                f"Mic input too quiet (peak {rec_dbfs:.1f} dBFS). Check that "
                f"the mic is connected to the audio interface, the input "
                f"gain knob is up, phantom power is on (if needed), the "
                f"speaker is powered, and the speaker volume is audible."
            )

        # ── Alignment via cross-correlation ─────────────────────────────
        # aplay/arecord don't share a clock — there's an unknown latency
        # offset (50–300 ms typical with USB + ALSA buffers). xcorr finds
        # the lag where the recording best matches the sweep, which is
        # where the sweep effectively "starts" in the recording.
        await prog(40, "Aligning recording…")
        align_offset = self._find_sweep_offset(recording, sweep)
        logger.info("RC: alignment offset = %d samples (%.1f ms)",
                    align_offset, 1000.0 * align_offset / self.sample_rate)

        # Pull the aligned window: sweep length + 1 s tail for the late IR
        captured = recording[align_offset : align_offset + n_sweep + self.sample_rate]
        if len(captured) < n_sweep:
            # Pad with zeros if the recording was too short
            captured = np.concatenate([captured, np.zeros(n_sweep - len(captured), dtype=np.float32)])

        await prog(60, "Deconvolving impulse response…")
        ir = self._deconvolve_farina(captured, sweep, k_factor)
        ir = self._window_ir(ir)

        await prog(85, "Computing frequency response…")
        freqs, mag_db = self._fft_response(ir)

        # Sanity check: a real measurement of a speaker in a room is
        # usually in the ±20 dB range after normalization. Anything
        # ±40 dB means alignment / level / signal-chain went sideways
        # — log it so the operator knows the result isn't trustworthy.
        if len(mag_db) > 0:
            mag_min = float(np.min(mag_db))
            mag_max = float(np.max(mag_db))
            logger.info("RC: response range %.1f → %.1f dB (span %.1f)",
                        mag_min, mag_max, mag_max - mag_min)
            if mag_max - mag_min > 60:
                logger.warning("RC: response span > 60 dB — likely a bad measurement "
                              "(wrong device, mic muted, level too low, or signal "
                              "didn't make it to the speaker)")

        await prog(100, "Done")
        return MeasurementResult(
            frequencies=freqs.tolist(),
            magnitude_db=mag_db.tolist(),
            impulse_response=ir.tolist(),
            sample_rate=self.sample_rate,
        )

    @staticmethod
    def _find_sweep_offset(recording, sweep) -> int:
        """Cross-correlate the recording against the sweep template;
        return the sample index in `recording` where the sweep starts.
        Robust against unknown ALSA/USB latency between aplay/arecord.

        Uses scipy.signal.fftconvolve (faster than correlate at this
        length) over the first half of the sweep — the early LF/MF
        portion is distinctive against background noise without being
        as expensive as the full 3-second template.
        """
        import numpy as np
        from scipy.signal import fftconvolve

        tpl = sweep[: min(len(sweep), len(sweep) // 2)]
        # Cross-correlate = convolve with time-reversed template
        c = fftconvolve(recording, tpl[::-1], mode="valid")
        if len(c) == 0:
            return 0
        # The argmax of |c| is where the template aligns inside `recording`.
        # In "valid" mode, c[0] corresponds to recording starting at offset 0,
        # so argmax IS the offset where the sweep begins.
        offset = int(np.argmax(np.abs(c)))
        return max(0, offset)

    @staticmethod
    def _deconvolve_farina(recording, sweep, k_factor: float):
        """Farina (2000) deconvolution via the inverse sweep.

        i(t) = s(T - t) · A(t)  where A compensates the −3 dB/octave
        pink spectrum of the log sweep so the IR comes out flat-spectrum.

        IR = conv(y, i) — pick the linear lobe (right-most peak), the
        earlier lobes are harmonic distortion products that get
        separated in time, which is one of the nice properties of log
        sweeps.
        """
        import numpy as np
        from scipy.signal import fftconvolve

        T = len(sweep)
        # Inverse sweep: time-reversed sweep with exponential amplitude.
        # The exponential makes the IR flat instead of pink.
        t = np.arange(T)
        amp = np.exp(t * k_factor / len(sweep))  # normalized so the end is the loud part
        inv_sweep = sweep[::-1] * amp
        # Convolve y with i — long, but fftconvolve is O(N log N).
        ir_full = fftconvolve(recording, inv_sweep, mode="full")
        # The linear IR is centered around index T-1 (end of the sweep).
        center = T - 1
        # Take 1 second window starting from center
        out_len = min(int(48000), len(ir_full) - center)
        ir = ir_full[center : center + out_len]
        # Normalize peak to ±1 (the absolute level depends on inverse-
        # sweep normalization, not on the actual room — peak normalization
        # is fine for relative frequency-response analysis).
        peak = float(np.max(np.abs(ir)))
        if peak > 0:
            ir = ir / peak
        return ir.astype(np.float32)

    async def _playrec_sounddevice(self, signal):
        """Fallback playback/record via sounddevice (PortAudio).

        Used when no ALSA device string is provided. Reliable only when
        the configured device index/name maps to a working hostapi —
        with PipeWire+JACK-only sounddevice builds this often falls
        back to the system default sink. The ALSA-direct path
        (_playrec_alsa_direct) is preferred for USB audio interfaces.
        """
        import sounddevice as sd
        loop = asyncio.get_event_loop()

        def _playrec():
            rec = sd.playrec(
                signal.reshape(-1, 1),
                samplerate=self.sample_rate,
                channels=1,
                dtype="float32",
                device=(self.input_device, self.output_device),
            )
            sd.wait()
            return rec.flatten()

        return await loop.run_in_executor(None, _playrec)

    async def _playrec_alsa_direct(self, signal):
        """Play sweep + capture mic via raw ALSA (aplay/arecord subprocesses).

        Sounddevice / PortAudio on PipeWire systems often exposes USB
        devices ONLY via the JACK hostapi (which delegates back through
        PipeWire). When JACK isn't running or refuses the open, sounddevice
        silently falls back to the system default sink — which on this
        target ends up being the laptop's built-in PCH audio. The user
        then hears the sweep on the laptop speakers instead of the USB
        DAC they configured for Nebula. Direct ALSA via subprocess
        eliminates that whole layer: aplay opens hw:X,Y or fails.

        Synchronisation: aplay and arecord are started in parallel,
        both with `--buffer-size` constrained so latency is low; we then
        wait on both. Because aplay needs a header it reads from a WAV
        file we write to /tmp, and arecord writes its WAV there too.
        """
        import asyncio as _asyncio
        import os
        import struct
        import tempfile
        import wave

        import numpy as np

        # Write the sweep signal as a WAV file at the engine's preferred format.
        sample_rate = self.sample_rate
        n_total = len(signal)
        record_duration_s = (n_total / sample_rate) + 0.3   # tail margin

        tmpdir = tempfile.mkdtemp(prefix="nebula-rc-")
        sweep_path = os.path.join(tmpdir, "sweep.wav")
        capture_path = os.path.join(tmpdir, "capture.wav")

        # Encode sweep as S32_LE / S24_3LE / S16_LE depending on alsa_format.
        # WAV samples are signed integers; we scale the float32 [-1, 1] up.
        fmt = self.alsa_format
        if fmt == "S32_LE":
            sample_width, scale = 4, (2**31 - 1)
        elif fmt == "S24_3LE":
            sample_width, scale = 3, (2**23 - 1)
        else:                   # S16_LE
            sample_width, scale = 2, (2**15 - 1)

        with wave.open(sweep_path, "wb") as wf:
            wf.setnchannels(2)     # most USB DACs require stereo
            wf.setsampwidth(sample_width)
            wf.setframerate(sample_rate)
            stereo = np.stack([signal, signal], axis=1)
            ints = np.clip(stereo * scale, -scale, scale).astype("<i4")
            if sample_width == 4:
                wf.writeframes(ints.tobytes())
            elif sample_width == 3:
                # 24-bit packed: take 3 LSBytes of each i32
                packed = ints.astype("<i4").view("u1").reshape(-1, 4)[:, :3].tobytes()
                wf.writeframes(packed)
            else:
                wf.writeframes(ints.astype("<i2").tobytes())

        # Launch aplay + arecord in parallel.  arecord first so it's
        # capturing by the time aplay starts emitting; the small lead-in
        # silence (silence_pre) covers the alignment slop.
        record_cmd = [
            "arecord",
            "-D", self.alsa_device,
            "-f", fmt,
            "-r", str(sample_rate),
            "-c", "2",
            "-d", str(int(record_duration_s) + 1),
            capture_path,
        ]
        play_cmd = [
            "aplay",
            "-D", self.alsa_device,
            sweep_path,
        ]

        rec_proc = await _asyncio.create_subprocess_exec(
            *record_cmd,
            stdout=_asyncio.subprocess.DEVNULL,
            stderr=_asyncio.subprocess.PIPE,
        )
        await _asyncio.sleep(0.15)   # let arecord prime
        play_proc = await _asyncio.create_subprocess_exec(
            *play_cmd,
            stdout=_asyncio.subprocess.DEVNULL,
            stderr=_asyncio.subprocess.PIPE,
        )

        play_rc = await play_proc.wait()
        rec_rc  = await rec_proc.wait()

        # If aplay failed, surface a clear error.
        if play_rc != 0:
            err = (await play_proc.stderr.read()).decode("utf-8", errors="replace")
            raise RuntimeError(f"aplay -D {self.alsa_device} failed (rc={play_rc}): {err.strip()}")

        # Read back the captured WAV and downmix to mono.
        with wave.open(capture_path, "rb") as wf:
            n_frames = wf.getnframes()
            raw = wf.readframes(n_frames)
            ch = wf.getnchannels()
            sw = wf.getsampwidth()
        if sw == 4:
            arr = np.frombuffer(raw, dtype="<i4").astype("float32") / (2**31 - 1)
        elif sw == 3:
            # 24-bit packed back to i32
            buf = np.frombuffer(raw, dtype="u1").reshape(-1, 3)
            i32 = np.zeros(len(buf), dtype="<i4")
            i32_view = i32.view("u1").reshape(-1, 4)
            i32_view[:, :3] = buf
            # sign extension
            mask = (i32 & 0x800000).astype(bool)
            i32[mask] |= 0xFF000000
            arr = i32.astype("float32") / (2**23 - 1)
        else:
            arr = np.frombuffer(raw, dtype="<i2").astype("float32") / (2**15 - 1)

        if ch == 2:
            arr = arr.reshape(-1, 2).mean(axis=1)
        return arr

    # _deconvolve (Wiener-style) removed — replaced by Farina inverse-sweep
    # deconvolution (_deconvolve_farina) which has better numerical
    # behaviour for log sweeps and separates linear from non-linear lobes.

    def _window_ir(self, ir):
        """Hann window over first 50 ms — isolates direct sound."""
        import numpy as np
        win_len = min(int(0.05 * self.sample_rate), len(ir))
        window  = np.hanning(win_len * 2)[:win_len]
        result  = ir.copy()
        result[:win_len] *= window
        result[win_len:]  = 0.0
        return result

    def _fft_response(self, ir):
        """Return (frequencies, magnitude_db) arrays, 1/6-octave smoothed."""
        import numpy as np
        N      = 4096
        spec   = np.fft.rfft(ir, n=N)
        freqs  = np.fft.rfftfreq(N, 1.0 / self.sample_rate)
        mag    = np.abs(spec)
        mag    = self._octave_smooth(freqs, mag, fraction=6)

        ref_idx = int(np.argmin(np.abs(freqs - 1000)))
        ref_val = mag[ref_idx] if mag[ref_idx] > 1e-10 else 1.0
        mag_db  = 20.0 * np.log10(np.maximum(mag / ref_val, 1e-10))

        mask = (freqs >= 20) & (freqs <= 20000)
        return freqs[mask], mag_db[mask]

    @staticmethod
    def _octave_smooth(freqs, mag, fraction: int):
        """1/N-octave smoothing."""
        import numpy as np
        smoothed = mag.copy()
        factor   = 2 ** (1.0 / (2 * fraction))
        for i, f in enumerate(freqs):
            if f < 1.0:
                continue
            lo  = f / factor
            hi  = f * factor
            idx = np.where((freqs >= lo) & (freqs <= hi))[0]
            if len(idx):
                smoothed[i] = float(np.mean(mag[idx]))
        return smoothed


# ─── Filter Designer ────────────────────────────────────────────────────────────

class FilterDesigner:
    """Converts a room measurement into IIR biquads or an FIR kernel."""

    IIR_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

    def design_iir(
        self,
        measurement:  MeasurementResult,
        target_name:  str   = "flat",
        max_gain_db:  float = 12.0,
    ) -> DesignResult:
        """Parametric EQ biquads to flatten the measured response."""
        import numpy as np
        freqs  = np.array(measurement.frequencies)
        mag_db = np.array(measurement.magnitude_db)
        target = TargetCurveManager.get(target_name, freqs)

        correction = target - mag_db  # what we need to add

        biquads: List[BiquadFilter] = []
        for fc in self.IIR_BANDS:
            if fc < freqs[0] or fc > freqs[-1]:
                continue
            idx  = int(np.argmin(np.abs(freqs - fc)))
            gain = float(np.clip(correction[idx], -max_gain_db, max_gain_db))
            if abs(gain) < 0.5:
                continue
            biquads.append(BiquadFilter(
                filter_type="Peaking",
                freq=float(fc),
                gain=round(gain, 1),
                q=1.41,
            ))

        return DesignResult(
            mode="iir",
            biquads=biquads,
            fir_path=None,
            target_label=TargetCurveManager.CURVES.get(target_name, target_name),
            correction_db=correction.tolist(),
        )

    def design_fir(
        self,
        measurement: MeasurementResult,
        target_name: str = "flat",
        n_taps:      int = 8192,
        output_dir:  str = "/tmp",
    ) -> DesignResult:
        """Minimum-phase FIR correction filter as a raw float32 file."""
        import numpy as np
        freqs  = np.array(measurement.frequencies)
        mag_db = np.array(measurement.magnitude_db)
        target = TargetCurveManager.get(target_name, freqs)
        correction = target - mag_db

        n_fft      = n_taps * 2
        fft_freqs  = np.fft.rfftfreq(n_fft, 1.0 / measurement.sample_rate)
        corr_full  = np.interp(fft_freqs, freqs, correction, left=0.0, right=0.0)
        gain_lin   = np.clip(10 ** (corr_full / 20.0), 0.1, 10.0)

        # Minimum phase via cepstrum
        log_gain      = np.log(gain_lin + 1e-10)
        log_ir        = np.fft.irfft(log_gain)
        log_ir[1:n_fft // 2] *= 2
        log_ir[n_fft // 2 + 1:] = 0.0
        H_min = np.exp(np.fft.rfft(log_ir))

        kernel = np.fft.irfft(H_min)[:n_taps]
        kernel *= np.hanning(n_taps)
        peak   = float(np.max(np.abs(kernel)))
        if peak > 0:
            kernel /= peak * 1.1

        fir_path = os.path.join(output_dir, f"nebula_fir_{uuid.uuid4().hex[:8]}.raw")
        with open(fir_path, "wb") as f:
            for s in kernel:
                f.write(struct.pack("<f", float(s)))

        return DesignResult(
            mode="fir",
            biquads=[],
            fir_path=fir_path,
            target_label=TargetCurveManager.CURVES.get(target_name, target_name),
            correction_db=correction.tolist(),
        )


# ─── Correction Applier ─────────────────────────────────────────────────────────

class CorrectionApplier:
    """Injects Nebula-generated filters into a live CamillaDSP instance."""

    _FILTER_PREFIX = "nebula_rc_"
    _FIR_KEY       = "nebula_fir"

    def __init__(self, cdsp_host: str = "localhost", cdsp_port: int = 1234):
        self.cdsp_host = cdsp_host
        self.cdsp_port = cdsp_port

    async def apply_iir(self, design: DesignResult, config_path: str) -> bool:
        import yaml
        config = self._load(config_path)
        config.setdefault("filters", {})

        # Remove old correction filters
        config["filters"] = {k: v for k, v in config["filters"].items()
                             if not k.startswith(self._FILTER_PREFIX)}

        names: List[str] = []
        for i, bq in enumerate(design.biquads):
            key = f"{self._FILTER_PREFIX}{i}"
            config["filters"][key] = {
                "type": "Biquad",
                "parameters": {
                    "type": bq.filter_type,
                    "freq": bq.freq,
                    "gain": bq.gain,
                    "q":    bq.q,
                },
            }
            names.append(key)

        config["pipeline"] = self._replace_correction_steps(config, names)
        self._save(config, config_path)
        return await self._reload(config_path)

    async def apply_fir(self, design: DesignResult, config_path: str) -> bool:
        import yaml
        if not design.fir_path or not os.path.exists(design.fir_path):
            logger.error("FIR file not found: %s", design.fir_path)
            return False

        config = self._load(config_path)
        config.setdefault("filters", {})
        config["filters"][self._FIR_KEY] = {
            "type": "Conv",
            "parameters": {
                "type":             "Raw",
                "filename":         design.fir_path,
                # CamillaDSP 4.x: the float format is `F32_LE`, not
                # `FLOAT32LE`. The old name made the engine reject the
                # config with "unknown variant FLOAT32LE" and enter a
                # restart-loop the moment Apply was clicked on a FIR
                # design.
                "format":           "F32_LE",
                "skip_bytes_lines": 0,
                "read_bytes_lines": 0,
            },
        }
        config["pipeline"] = self._replace_correction_steps(config, [self._FIR_KEY])
        self._save(config, config_path)
        return await self._reload(config_path)

    async def remove_correction(self, config_path: str) -> bool:
        config = self._load(config_path)
        config["filters"] = {
            k: v for k, v in config.get("filters", {}).items()
            if not (k.startswith(self._FILTER_PREFIX) or k == self._FIR_KEY)
        }
        config["pipeline"] = [
            s for s in config.get("pipeline", [])
            if not any(
                str(n).startswith(self._FILTER_PREFIX) or str(n) == self._FIR_KEY
                for n in s.get("names", [])
            )
        ]
        self._save(config, config_path)
        return await self._reload(config_path)

    def _replace_correction_steps(self, config: dict, filter_names: List[str]) -> list:
        """Remove old Nebula steps then append a new Filter step covering
        all channels.  Uses the CamillaDSP 4.x schema `channels: [0, 1]`
        (array) — earlier code used `channel: 0` (singular int) which
        the engine rejects with
        `unknown field "channel", expected one of "channels", "names"...`.
        That was the cause of /api/rc/apply returning {"ok": false}."""
        devices = config.get("devices", {})
        n_channels = devices.get("capture", {}).get("channels", 2) or 2

        pipeline = [
            s for s in config.get("pipeline", [])
            if not any(
                str(n).startswith(self._FILTER_PREFIX) or str(n) == self._FIR_KEY
                for n in s.get("names", [])
            )
        ]
        all_channels = list(range(n_channels))
        pipeline.append({
            "type":     "Filter",
            "channels": all_channels,
            "names":    filter_names,
        })
        return pipeline

    @staticmethod
    def _load(path: str) -> dict:
        import yaml
        with open(path) as f:
            return yaml.safe_load(f) or {}

    @staticmethod
    def _save(config: dict, path: str) -> None:
        import yaml
        tmp = path + ".nebula_tmp"
        with open(tmp, "w") as f:
            yaml.dump(config, f, default_flow_style=False, allow_unicode=True)
        os.replace(tmp, path)

    async def _reload(self, config_path: str) -> bool:
        """Tell the engine to load the config we just wrote.

        CamillaDSP 4.x WebSocket protocol wraps the argument:
            {"SetConfigFilePath": {"value": "<path>"}}
        and replies with
            {"SetConfigFilePath": {"result": "Ok"}}
        The previous code sent `{"SetConfigFilePath": "<path>"}` (3.x style)
        and tested `resp.get("SetConfigFilePath") == "Ok"`, so even when
        the actual reload succeeded the function returned False — which
        is why the GUI showed {"ok": false} despite the filters being
        correctly written to disk.
        """
        import websockets
        uri = f"ws://{self.cdsp_host}:{self.cdsp_port}"
        # Protocol (verified against CamillaDSP 4.1.3 by direct probe):
        #   Set commands take the value DIRECTLY (no {value:} wrapper):
        #       {"SetConfigFilePath": "/etc/.../default.yml"}
        #   The response is wrapped:
        #       {"SetConfigFilePath": {"result": "Ok"}}
        # The old code mistakenly used {"value": ...} and tested
        # == "Ok" on a dict; both wrong.
        try:
            async with websockets.connect(uri, open_timeout=3, close_timeout=2) as ws:
                await ws.send(json.dumps({"SetConfigFilePath": config_path}))
                resp = json.loads(await ws.recv())
                result = (resp.get("SetConfigFilePath") or {}).get("result", "")
                if result == "Ok":
                    return True
                logger.error("CamillaDSP reload returned %r — full resp: %s", result, resp)
                return False
        except Exception as e:
            logger.error("CamillaDSP reload failed: %s", e)
            return False


# ─── CLI ────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
    parser = argparse.ArgumentParser(description="Nebula DSP Room Correction")
    parser.add_argument("--test-sweep", action="store_true",
                        help="Write sweep to /tmp/nebula_sweep_test.wav and exit")
    parser.add_argument("--measure",    action="store_true",
                        help="Run full measurement")
    parser.add_argument("--output",     default="/tmp/nebula_measurement.json",
                        help="Output JSON path for --measure")
    parser.add_argument("--design",     metavar="JSON",
                        help="Path to measurement JSON to design filters from")
    parser.add_argument("--mode",       choices=["iir", "fir"], default="iir")
    parser.add_argument("--target",     default="flat",
                        choices=list(TargetCurveManager.CURVES))
    args = parser.parse_args()

    if args.test_sweep:
        engine = MeasurementEngine()
        signal, _ = engine._generate_sweep()
        out = "/tmp/nebula_sweep_test.wav"
        with wave.open(out, "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(4)
            wf.setframerate(48000)
            for s in signal:
                wf.writeframes(struct.pack("<f", float(s)))
        print(f"Sweep written → {out}  ({len(signal)/48000:.1f} s)")

    elif args.measure:
        async def _run():
            engine = MeasurementEngine()

            async def prog(pct, msg):
                print(f"  [{pct:3d}%] {msg}")

            result = await engine.measure(progress_cb=prog)
            payload = {
                "frequencies":      result.frequencies,
                "magnitude_db":     result.magnitude_db,
                "impulse_response": result.impulse_response[:2000],
                "sample_rate":      result.sample_rate,
                "measurement_id":   result.measurement_id,
            }
            with open(args.output, "w") as f:
                json.dump(payload, f, indent=2)
            print(f"Saved → {args.output}")

        asyncio.run(_run())

    elif args.design:
        with open(args.design) as f:
            data = json.load(f)
        measurement = MeasurementResult(
            frequencies=data["frequencies"],
            magnitude_db=data["magnitude_db"],
            impulse_response=data.get("impulse_response", []),
            sample_rate=data.get("sample_rate", 48000),
        )
        designer = FilterDesigner()
        if args.mode == "iir":
            design = designer.design_iir(measurement, target_name=args.target)
            print(f"Generated {len(design.biquads)} biquad filters (target: {design.target_label}):")
            for bq in design.biquads:
                print(f"  {bq.filter_type:12s}  {bq.freq:6.0f} Hz  {bq.gain:+5.1f} dB  Q={bq.q:.2f}")
        else:
            design = designer.design_fir(measurement, target_name=args.target)
            print(f"FIR kernel written → {design.fir_path}")
    else:
        parser.print_help()
