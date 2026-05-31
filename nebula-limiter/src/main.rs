//! Nebula Limiter — lookahead brickwall limiter sidecar.
//!
//! ALSA capture device → limiter algorithm → ALSA playback device.
//! Live parameters and stats are exposed on a Unix socket so the
//! Nebula GUI backend can proxy them as /api/limiter/*.

mod limiter;
mod control;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use alsa::pcm::{Access, Format, HwParams, PCM, State};
use alsa::{Direction, ValueOr};
use anyhow::{anyhow, Context, Result};
use clap::Parser;

use crate::limiter::{Limiter, LimiterParams};
use crate::control::SharedState;

#[derive(Parser, Debug)]
#[command(name = "nebula-limiter", version, about)]
struct Args {
    /// ALSA capture device (e.g. "hw:Loopback,1,0").
    #[arg(long, default_value = "hw:Loopback,1,0")]
    capture: String,

    /// ALSA playback device (e.g. "hw:Seri,0,0").
    #[arg(long, default_value = "default")]
    playback: String,

    /// Sample rate in Hz.
    #[arg(long, default_value_t = 48000)]
    rate: u32,

    /// Channels.
    #[arg(long, default_value_t = 2)]
    channels: u32,

    /// ALSA period size in frames (smaller = lower latency, more CPU).
    #[arg(long, default_value_t = 256)]
    period: u32,

    /// Number of ALSA periods in the ring buffer.
    #[arg(long, default_value_t = 4)]
    periods: u32,

    /// Ceiling in dBFS (negative or zero).  `allow_hyphen_values` lets us
    /// pass `-1.0` without clap mistaking the leading minus for a flag.
    #[arg(long, default_value_t = -1.0, allow_hyphen_values = true)]
    ceiling_db: f32,

    /// Lookahead in milliseconds.
    #[arg(long, default_value_t = 3.0)]
    lookahead_ms: f32,

    /// Release time constant in milliseconds.
    #[arg(long, default_value_t = 50.0)]
    release_ms: f32,

    /// Enable 2× true-peak detection in the side-chain.
    #[arg(long, default_value_t = true)]
    true_peak: bool,

    /// Unix socket for the control / status API.
    #[arg(long, default_value = "/run/nebula-limiter.sock")]
    socket: PathBuf,
}

fn open_capture(args: &Args) -> Result<PCM> {
    let pcm = PCM::new(&args.capture, Direction::Capture, false)
        .with_context(|| format!("open capture {}", args.capture))?;
    {
        let hwp = HwParams::any(&pcm)?;
        hwp.set_access(Access::RWInterleaved)?;
        hwp.set_format(Format::s16())?;
        hwp.set_channels(args.channels)?;
        hwp.set_rate(args.rate, ValueOr::Nearest)?;
        hwp.set_period_size(args.period as alsa::pcm::Frames, ValueOr::Nearest)?;
        hwp.set_periods(args.periods, ValueOr::Nearest)?;
        pcm.hw_params(&hwp)?;
    }
    pcm.prepare()?;
    Ok(pcm)
}

fn open_playback(args: &Args) -> Result<PCM> {
    let pcm = PCM::new(&args.playback, Direction::Playback, false)
        .with_context(|| format!("open playback {}", args.playback))?;
    {
        let hwp = HwParams::any(&pcm)?;
        hwp.set_access(Access::RWInterleaved)?;
        hwp.set_format(Format::s16())?;
        hwp.set_channels(args.channels)?;
        hwp.set_rate(args.rate, ValueOr::Nearest)?;
        hwp.set_period_size(args.period as alsa::pcm::Frames, ValueOr::Nearest)?;
        hwp.set_periods(args.periods, ValueOr::Nearest)?;
        pcm.hw_params(&hwp)?;
    }
    pcm.prepare()?;
    Ok(pcm)
}

fn i16_to_f32(buf: &[i16], out: &mut [f32]) {
    debug_assert_eq!(buf.len(), out.len());
    let scale = 1.0 / 32768.0;
    for (i, &s) in buf.iter().enumerate() {
        out[i] = (s as f32) * scale;
    }
}

fn f32_to_i16(buf: &[f32], out: &mut [i16]) {
    debug_assert_eq!(buf.len(), out.len());
    for (i, &s) in buf.iter().enumerate() {
        // Clamp belt-and-suspenders: the limiter must already keep |s| ≤
        // ceiling ≤ 1.0, but be defensive in case ceiling > 0 was set.
        let v = (s * 32767.0).round().clamp(-32768.0, 32767.0);
        out[i] = v as i16;
    }
}

fn run() -> Result<()> {
    let args = Args::parse();

    let lookahead = ((args.lookahead_ms / 1000.0) * args.rate as f32) as usize;
    if lookahead == 0 {
        return Err(anyhow!("lookahead_ms too small for sample rate"));
    }
    let params = LimiterParams {
        ceiling_db:      args.ceiling_db,
        lookahead,
        true_peak:       args.true_peak,
        release_samples: (args.release_ms / 1000.0) * args.rate as f32,
    };
    log::info!(
        "starting limiter: capture={} → playback={} @ {} Hz × {} ch, period={}, lookahead={}ms ({} samples), ceiling={} dBFS, true_peak={}",
        args.capture, args.playback, args.rate, args.channels, args.period,
        args.lookahead_ms, lookahead, args.ceiling_db, args.true_peak,
    );

    let cap = open_capture(&args)?;
    let pb  = open_playback(&args)?;

    let cap_io = cap.io_i16().map_err(|e| anyhow!("capture i16 io: {e}"))?;
    let pb_io  = pb.io_i16().map_err(|e| anyhow!("playback i16 io: {e}"))?;

    let mut limiter = Limiter::new(params, args.channels as usize);

    let state = SharedState::new(params, args.rate, args.channels);
    control::spawn(&args.socket, state.clone())
        .context("spawn control socket")?;

    let buf_frames = args.period as usize;
    let buf_len    = buf_frames * args.channels as usize;
    let mut int_buf = vec![0i16; buf_len];
    let mut flt_buf = vec![0.0f32; buf_len];

    loop {
        // Read one period from capture.  EAGAIN / EPIPE → recover.
        let read = match cap_io.readi(&mut int_buf) {
            Ok(n) => n,
            Err(e) => {
                log::warn!("capture error: {e}, recovering");
                cap.recover(e.errno() as i32, true).ok();
                0
            }
        };
        if read == 0 { continue; }

        let frames_now = read;
        let samples = &mut flt_buf[..frames_now * args.channels as usize];
        let i16s    = &int_buf[..frames_now * args.channels as usize];

        i16_to_f32(i16s, samples);

        // Apply any pending parameter update at block boundary, then run.
        if let Some(new) = state.pending.lock().unwrap().take() {
            limiter.set_params(new);
            log::info!("applied new params: {:?}", limiter.params());
        }
        if std::mem::take(&mut *state.reset_pending.lock().unwrap()) {
            limiter.reset_stats();
        }

        limiter.process(samples);

        let i16s_out = &mut int_buf[..frames_now * args.channels as usize];
        f32_to_i16(samples, i16s_out);

        // Publish stats once per block (cheap mutex, only the GUI reads).
        *state.stats.lock().unwrap() = limiter.stats;

        // Write to playback.  Same recovery logic.
        let mut to_write = i16s_out;
        while !to_write.is_empty() {
            match pb_io.writei(to_write) {
                Ok(n) => {
                    if n == 0 { break; }
                    to_write = &mut to_write[n * args.channels as usize..];
                }
                Err(e) => {
                    log::warn!("playback error: {e}, recovering");
                    pb.recover(e.errno() as i32, true).ok();
                    if pb.state() == State::Prepared {
                        pb.start().ok();
                    }
                    break;
                }
            }
        }
    }
}

fn main() {
    // Initialize the logger ONCE before the retry loop; env_logger panics
    // if init() is called twice, and the retry loop re-enters run().
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // Restart on fatal errors so a transient ALSA hiccup (USB hot-unplug,
    // device suspend) doesn't kill us permanently — but back off so we
    // don't spin if the device is genuinely gone.
    let mut backoff_ms = 100u64;
    loop {
        if let Err(e) = run() {
            log::error!("fatal: {e:#}");
            std::thread::sleep(Duration::from_millis(backoff_ms));
            backoff_ms = (backoff_ms * 2).min(5000);
        }
    }
}
