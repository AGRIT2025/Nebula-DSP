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

logger = logging.getLogger(__name__)

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
    ):
        self.sample_rate    = sample_rate
        self.sweep_duration = sweep_duration
        self.silence_pre    = silence_pre
        self.silence_post   = silence_post
        self.output_device  = output_device
        self.input_device   = input_device

    def _generate_sweep(self):
        """Return (full_signal, raw_sweep) as float32 numpy arrays."""
        import numpy as np
        import scipy.signal as sig

        n_sweep = int(self.sweep_duration * self.sample_rate)
        n_pre   = int(self.silence_pre  * self.sample_rate)
        n_post  = int(self.silence_post * self.sample_rate)

        t = np.linspace(0, self.sweep_duration, n_sweep, endpoint=False)
        sweep = sig.chirp(t, f0=20, f1=20000, t1=self.sweep_duration, method="logarithmic")
        sweep = sweep * np.hanning(n_sweep)

        signal = np.concatenate([np.zeros(n_pre), sweep, np.zeros(n_post)])
        return signal.astype(np.float32), sweep.astype(np.float32)

    async def measure(self, progress_cb: Optional[ProgressCallback] = None) -> MeasurementResult:
        """Play sweep, record simultaneously, deconvolve → IR → FFT."""
        import sounddevice as sd
        import numpy as np

        signal, sweep = self._generate_sweep()
        n_pre = int(self.silence_pre * self.sample_rate)

        async def prog(pct: int, msg: str):
            if progress_cb:
                await progress_cb(pct, msg)

        await prog(5, "Generating sweep signal…")

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

        await prog(10, "Playing sweep and recording…")
        recording = await loop.run_in_executor(None, _playrec)

        await prog(60, "Deconvolving impulse response…")
        start = n_pre
        end   = min(len(recording), start + int(self.sweep_duration * self.sample_rate) + int(0.5 * self.sample_rate))
        captured = recording[start:end]

        ir = self._deconvolve(captured, sweep)
        ir = self._window_ir(ir)

        await prog(85, "Computing frequency response…")
        freqs, mag_db = self._fft_response(ir)

        await prog(100, "Done")
        return MeasurementResult(
            frequencies=freqs.tolist(),
            magnitude_db=mag_db.tolist(),
            impulse_response=ir.tolist(),
            sample_rate=self.sample_rate,
        )

    def _deconvolve(self, recording, sweep):
        """Wiener deconvolution in frequency domain."""
        import numpy as np
        n = max(len(recording), len(sweep)) * 2
        R = np.fft.rfft(recording, n=n)
        S = np.fft.rfft(sweep,     n=n)
        eps = 1e-6 * float(np.max(np.abs(S) ** 2))
        H = R * np.conj(S) / (np.abs(S) ** 2 + eps)
        ir = np.fft.irfft(H)
        return ir[:self.sample_rate]  # keep first second

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
                "format":           "FLOAT32LE",
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
        """Remove old Nebula steps then append new ones for every channel."""
        n_channels = 2
        devices = config.get("devices", {})
        n_channels = devices.get("capture", {}).get("channels", 2)

        pipeline = [
            s for s in config.get("pipeline", [])
            if not any(
                str(n).startswith(self._FILTER_PREFIX) or str(n) == self._FIR_KEY
                for n in s.get("names", [])
            )
        ]
        for ch in range(n_channels):
            pipeline.append({"type": "Filter", "channel": ch, "names": filter_names})
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
        import websockets
        uri = f"ws://{self.cdsp_host}:{self.cdsp_port}"
        try:
            async with websockets.connect(uri, open_timeout=3) as ws:
                await ws.send(json.dumps({"SetConfigFilePath": config_path}))
                resp = json.loads(await ws.recv())
                return resp.get("SetConfigFilePath") == "Ok"
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
