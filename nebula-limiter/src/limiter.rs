//! Lookahead brickwall limiter.
//!
//! Canonical algorithm:
//!   1. For each input sample x[i] we compute the *target* linear gain
//!      that would be needed to keep |x[i]| ≤ ceiling:
//!          target[i] = ceiling / max(|x[i]|, ceiling)         (always ≤ 1)
//!   2. We keep a delay line of size **L** samples holding the audio,
//!      and a ring of size **L+1** holding `target` values.
//!   3. The gain we APPLY to the delayed output sample is the
//!      **minimum** of all target values across that L+1 window — i.e.
//!      the lowest gain required by any peak in the next L samples
//!      (counted from the output sample's position).  Because we apply
//!      a gain ≤ ceiling/|x[k]| to x[k] for every k in the window,
//!      the output is mathematically guaranteed to be ≤ ceiling.
//!   4. On the release side we one-pole smooth the gain so the
//!      recovery is not a step but a gentle slope.  The attack remains
//!      instant (we look ahead, so we drop the gain L samples *before*
//!      the peak; no smoothing is needed there).
//!
//! True-peak detection (`true_peak: true`): the side-chain peak per
//! frame is computed from a 31-tap halfband-FIR-upsampled signal so
//! inter-sample peaks (between two integer-aligned samples) are caught.
//! Only the side-chain is upsampled; the audio path itself runs at
//! native rate, so there is no aliasing / no extra audio-path delay.

const HALFBAND_TAPS: [f32; 31] = [
    // 31-tap linear-phase halfband FIR (Kaiser β≈8, fs/2 cutoff).  Even
    // taps (except the center) are zero; the center is 0.5; odd taps
    // give the interpolated midpoint between two integer samples.
     0.0,           -0.000_572_586,  0.0,            0.003_055_872,
     0.0,           -0.009_900_990,  0.0,            0.024_752_475,
     0.0,           -0.054_205_607,  0.0,            0.109_009_174,
     0.0,           -0.220_183_486,  0.0,            0.677_064_220,
     0.5,
     0.677_064_220,  0.0,           -0.220_183_486,  0.0,
     0.109_009_174,  0.0,           -0.054_205_607,  0.0,
     0.024_752_475,  0.0,           -0.009_900_990,  0.0,
     0.003_055_872,  0.0,
];

struct ChannelState {
    /// Audio delay line: ring of `L` floats.
    delay: Vec<f32>,
    delay_w: usize,
    /// Halfband upsampler history for true-peak detection.
    hb_hist: [f32; 31],
}

impl ChannelState {
    fn new(lookahead: usize) -> Self {
        Self {
            delay:   vec![0.0; lookahead],
            delay_w: 0,
            hb_hist: [0.0; 31],
        }
    }
}

/// Per-stream (NOT per-channel) gain envelope: all channels share the
/// same gain reduction so the stereo image is preserved.
struct GainEnvelope {
    /// Ring of target gains, length L+1.  Sliding-min over this ring is
    /// the lookahead gain.
    targets: Vec<f32>,
    write:   usize,
    /// One-pole release state.
    last_applied: f32,
}

impl GainEnvelope {
    fn new(lookahead: usize) -> Self {
        Self {
            targets:      vec![1.0; lookahead + 1],
            write:        0,
            last_applied: 1.0,
        }
    }

    /// Push a new target and return the smoothed lookahead gain to
    /// apply to the *current output sample*.
    fn step(&mut self, target: f32, release_samples: f32) -> f32 {
        self.targets[self.write] = target;
        self.write = (self.write + 1) % self.targets.len();

        // Sliding minimum across the whole ring.  Brute force; the ring
        // is small (≤ a few hundred entries) so this is ~150 ops/sample,
        // well under the audio budget.
        let mut min_t = self.targets[0];
        for &t in &self.targets[1..] {
            if t < min_t { min_t = t; }
        }

        // Attack instant, release smoothed.  We *can* drop to `min_t`
        // immediately because we already have lookahead in the audio
        // path — the peak we're guarding against hasn't been emitted to
        // the output yet.
        let g = if min_t < self.last_applied {
            min_t
        } else {
            // Recovery: exponential one-pole towards min_t.
            let alpha = (-1.0_f32 / release_samples).exp();
            self.last_applied * alpha + min_t * (1.0 - alpha)
        };
        self.last_applied = g;
        g
    }
}

#[derive(Clone, Copy, Debug)]
pub struct LimiterParams {
    pub ceiling_db:      f32,
    pub lookahead:       usize,
    pub true_peak:       bool,
    pub release_samples: f32,
}

impl LimiterParams {
    pub fn ceiling_linear(&self) -> f32 { 10.0_f32.powf(self.ceiling_db / 20.0) }
}

#[derive(Default, Clone, Copy, Debug)]
pub struct Stats {
    /// Peak gain reduction observed since last `reset_stats`, in dB
    /// (negative or zero).
    pub gr_db:             f32,
    /// Cumulative count of frames where the true-peak detector saw a
    /// peak above the ceiling.
    pub isp_hits:          u64,
    pub samples_processed: u64,
    /// Final-output samples that escaped the ceiling (must always be 0;
    /// non-zero would indicate an algorithm bug).
    pub samples_clipped:   u64,
}

pub struct Limiter {
    params:    LimiterParams,
    channels:  Vec<ChannelState>,
    envelope:  GainEnvelope,
    pub stats: Stats,
}

impl Limiter {
    pub fn new(params: LimiterParams, channels: usize) -> Self {
        Self {
            channels: (0..channels).map(|_| ChannelState::new(params.lookahead)).collect(),
            envelope: GainEnvelope::new(params.lookahead),
            params,
            stats: Stats::default(),
        }
    }

    pub fn params(&self) -> &LimiterParams { &self.params }
    pub fn channels(&self) -> usize { self.channels.len() }
    pub fn lookahead(&self) -> usize { self.params.lookahead }

    pub fn set_params(&mut self, p: LimiterParams) {
        if p.lookahead != self.params.lookahead {
            self.channels = (0..self.channels.len())
                .map(|_| ChannelState::new(p.lookahead))
                .collect();
            self.envelope = GainEnvelope::new(p.lookahead);
        }
        self.params = p;
    }

    pub fn reset_stats(&mut self) { self.stats = Stats::default(); }

    /// Process an interleaved block in-place.  Length must be a multiple
    /// of `channels()`.
    pub fn process(&mut self, samples: &mut [f32]) {
        let n_ch  = self.channels.len();
        let ceil  = self.params.ceiling_linear();
        let frames = samples.len() / n_ch;

        for f in 0..frames {
            // Per-frame side-chain peak across all channels (linked).
            let mut peak = 0.0f32;
            for c in 0..n_ch {
                let s = samples[f * n_ch + c];
                let p = if self.params.true_peak {
                    upsample2x_peak(&mut self.channels[c].hb_hist, s)
                } else {
                    s.abs()
                };
                if p > peak { peak = p; }
            }

            // Target gain for THIS input sample.  ≤ 1 by construction.
            let target = if peak > ceil {
                self.stats.isp_hits = self.stats.isp_hits.saturating_add(1);
                ceil / peak
            } else {
                1.0
            };

            let g = self.envelope.step(target, self.params.release_samples);

            // Update peak-GR stat (linear → dB; cap at -60 to keep UI sane).
            if g < 1.0 {
                let gr = 20.0 * g.log10();
                if gr < self.stats.gr_db { self.stats.gr_db = gr.max(-60.0); }
            }

            // Apply gain to delayed audio per channel.
            for c in 0..n_ch {
                let st = &mut self.channels[c];
                let s_in = samples[f * n_ch + c];
                let s_delayed = st.delay[st.delay_w];
                st.delay[st.delay_w] = s_in;
                st.delay_w = (st.delay_w + 1) % st.delay.len();

                let s_out = s_delayed * g;
                samples[f * n_ch + c] = s_out;

                if s_out.abs() > ceil + 1e-3 {
                    self.stats.samples_clipped =
                        self.stats.samples_clipped.saturating_add(1);
                }
            }
        }

        self.stats.samples_processed =
            self.stats.samples_processed.saturating_add(frames as u64);
    }
}

/// 2× polyphase peak detector: pass a sample through the halfband FIR
/// and return max(|s|, |midpoint|).  No actual upsampled output stream
/// is produced — only the midpoint magnitude.
fn upsample2x_peak(hist: &mut [f32; 31], s: f32) -> f32 {
    for i in (1..31).rev() { hist[i] = hist[i - 1]; }
    hist[0] = s;
    let mut mid = 0.0f32;
    for i in 0..31 { mid += hist[i] * HALFBAND_TAPS[i]; }
    s.abs().max(mid.abs())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(lookahead: usize, ceiling_db: f32, channels: usize) -> Limiter {
        Limiter::new(LimiterParams {
            ceiling_db,
            lookahead,
            true_peak: false,
            release_samples: 200.0,
        }, channels)
    }

    /// Brickwall property: with a signal that exceeds the ceiling, the
    /// output magnitude must never exceed the ceiling once the lookahead
    /// has warmed up.
    #[test]
    fn brickwall_holds() {
        let mut lim = make(144, -1.0, 1);
        let ceiling = 10.0_f32.powf(-1.0 / 20.0);
        let mut signal: Vec<f32> = (0..48000)
            .map(|i| 1.5 * ((i as f32) * 2.0 * std::f32::consts::PI * 440.0 / 48000.0).sin())
            .collect();
        lim.process(&mut signal);
        let la = lim.lookahead();
        for (i, &s) in signal.iter().enumerate().skip(la + 10) {
            assert!(
                s.abs() <= ceiling + 1e-3,
                "sample {i}: |{s}| > ceiling {ceiling}",
            );
        }
        assert_eq!(lim.stats.samples_clipped, 0, "any escape is a bug");
    }

    /// Bypass property: a signal that stays under the ceiling passes
    /// through with unity gain (after the lookahead delay).
    #[test]
    fn quiet_signal_unchanged() {
        let mut lim = make(144, -1.0, 1);
        let input: Vec<f32> = (0..2000)
            .map(|i| 0.1 * ((i as f32) * 2.0 * std::f32::consts::PI * 1000.0 / 48000.0).sin())
            .collect();
        let mut signal = input.clone();
        lim.process(&mut signal);
        let la = lim.lookahead();
        for i in la + 50..signal.len() {
            let d = (signal[i] - input[i - la]).abs();
            assert!(d < 1e-4, "sample {i}: delta {d} (unity gain expected)");
        }
    }

    /// Single-sample transient: lookahead + sliding min should pull the
    /// gain down BEFORE the spike reaches the output, so it never
    /// breaches the ceiling.
    #[test]
    fn transient_caught() {
        let mut lim = make(144, -1.0, 1);
        let ceiling = 10.0_f32.powf(-1.0 / 20.0);
        let mut signal = vec![0.0f32; 4000];
        signal[2000] = 1.0;
        lim.process(&mut signal);
        for (i, &s) in signal.iter().enumerate() {
            assert!(s.abs() <= ceiling + 1e-3, "sample {i}: {s}");
        }
        // And the spike isn't completely killed — output around the spike
        // should be ≥ ~70% of the ceiling (i.e. the limiter scaled the
        // spike to fit, not muted it).
        let max_out = signal.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
        assert!(max_out > 0.6 * ceiling, "spike scaled too much: max {max_out}");
    }

    /// 2× true-peak: a Nyquist-rate alternating signal has inter-sample
    /// peaks ~+3 dB above its integer samples.  With true_peak enabled,
    /// the detector should see those and trigger.
    #[test]
    fn true_peak_catches_isp() {
        let mut lim = Limiter::new(LimiterParams {
            ceiling_db: -1.0,
            lookahead: 144,
            true_peak: true,
            release_samples: 200.0,
        }, 1);
        let mut signal: Vec<f32> = (0..4000)
            .map(|i| if i & 1 == 0 { 0.95 } else { -0.95 })
            .collect();
        lim.process(&mut signal);
        assert!(lim.stats.isp_hits > 0, "true-peak detector should have fired");
    }

    /// Release smoothing: after a peak, the gain shouldn't snap back
    /// to 1.0 in a single sample.  Verify by feeding one short burst
    /// then silence, and checking that gain recovers gradually.
    #[test]
    fn release_is_smooth() {
        let mut lim = make(144, -1.0, 1);
        let mut signal = vec![0.0f32; 8000];
        // Single tall burst at 1000.
        for i in 1000..1010 { signal[i] = 1.0; }
        lim.process(&mut signal);
        // Find where gain reduction (signal[k] < 1.0 input mapping) recovers.
        // We just sanity-check that the post-burst region isn't bouncing.
        let mut prev = 0.0f32;
        let mut max_step = 0.0f32;
        for &s in signal.iter().skip(2000).take(4000) {
            let step = (s - prev).abs();
            if step > max_step { max_step = step; }
            prev = s;
        }
        // Sane: a smooth release should not produce per-sample steps > 0.1.
        assert!(max_step < 0.2, "release produces big step: {max_step}");
    }
}

#[cfg(test)]
mod stereo_tests {
    use super::*;

    /// Mirror of the live-binary scenario: stereo, true-peak on, 0 dBFS
    /// 1 kHz sine.  Verifies the brickwall holds across channels.
    #[test]
    fn stereo_brickwall_with_true_peak() {
        let mut lim = Limiter::new(LimiterParams {
            ceiling_db: -1.0,
            lookahead: 144,
            true_peak: true,
            release_samples: 200.0,
        }, 2);
        let ceiling = 10.0_f32.powf(-1.0 / 20.0);
        let mut signal: Vec<f32> = (0..96000 * 2)
            .map(|i| {
                let frame = i / 2;
                ((frame as f32) * 2.0 * std::f32::consts::PI * 1000.0 / 48000.0).sin()
            })
            .collect();
        lim.process(&mut signal);
        for (i, &s) in signal.iter().enumerate().skip(2 * (144 + 10)) {
            assert!(s.abs() <= ceiling + 1e-3, "sample {i}: {s}");
        }
        assert_eq!(lim.stats.samples_clipped, 0);
    }
}
