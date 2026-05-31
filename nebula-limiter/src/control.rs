//! Unix-socket control API.
//!
//! Wire protocol: newline-delimited JSON.
//!
//!   client → server:  {"op": "status"}                                  → returns Status
//!   client → server:  {"op": "set",   "params": {ceiling_db, lookahead_ms, true_peak, release_ms}} → returns Status
//!   client → server:  {"op": "reset_stats"}                             → returns Status
//!
//! The server side runs in its own thread.  Audio thread polls
//! `SharedState.command()` once per block; updates are applied between
//! blocks so we never touch buffers concurrently.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::limiter::{LimiterParams, Stats};

#[derive(Serialize, Clone, Debug)]
pub struct StatusReport {
    pub gr_db:             f32,
    pub isp_hits:          u64,
    pub samples_processed: u64,
    pub samples_clipped:   u64,
    pub ceiling_db:        f32,
    pub lookahead_ms:      f32,
    pub true_peak:         bool,
    pub release_ms:        f32,
    pub sample_rate:       u32,
    pub channels:          u32,
}

#[derive(Deserialize, Debug)]
struct ParamUpdate {
    ceiling_db:   Option<f32>,
    lookahead_ms: Option<f32>,
    true_peak:    Option<bool>,
    release_ms:   Option<f32>,
}

/// What the audio thread needs to expose to the control thread.
pub struct SharedState {
    pub stats:        Mutex<Stats>,
    pub params:       Mutex<LimiterParams>,
    pub pending:      Mutex<Option<LimiterParams>>,
    pub reset_pending: Mutex<bool>,
    pub sample_rate:  u32,
    pub channels:     u32,
}

impl SharedState {
    pub fn new(initial: LimiterParams, sample_rate: u32, channels: u32) -> Arc<Self> {
        Arc::new(Self {
            stats:         Mutex::new(Stats::default()),
            params:        Mutex::new(initial),
            pending:       Mutex::new(None),
            reset_pending: Mutex::new(false),
            sample_rate,
            channels,
        })
    }
}

fn build_report(s: &SharedState) -> StatusReport {
    let stats = *s.stats.lock().unwrap();
    let params = *s.params.lock().unwrap();
    StatusReport {
        gr_db:             stats.gr_db,
        isp_hits:          stats.isp_hits,
        samples_processed: stats.samples_processed,
        samples_clipped:   stats.samples_clipped,
        ceiling_db:        params.ceiling_db,
        lookahead_ms:      (params.lookahead as f32 / s.sample_rate as f32) * 1000.0,
        true_peak:         params.true_peak,
        release_ms:        (params.release_samples / s.sample_rate as f32) * 1000.0,
        sample_rate:       s.sample_rate,
        channels:          s.channels,
    }
}

fn handle_line(line: &str, state: &SharedState) -> serde_json::Value {
    let req: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return serde_json::json!({ "error": format!("bad json: {e}") }),
    };
    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
    match op {
        "status" => serde_json::to_value(build_report(state)).unwrap(),
        "reset_stats" => {
            *state.reset_pending.lock().unwrap() = true;
            serde_json::to_value(build_report(state)).unwrap()
        }
        "set" => {
            let upd: ParamUpdate = match serde_json::from_value(
                req.get("params").cloned().unwrap_or(serde_json::Value::Null),
            ) {
                Ok(p) => p,
                Err(e) => return serde_json::json!({ "error": format!("bad params: {e}") }),
            };
            let current = *state.params.lock().unwrap();
            let next = LimiterParams {
                ceiling_db:      upd.ceiling_db.unwrap_or(current.ceiling_db),
                lookahead:       upd.lookahead_ms
                    .map(|ms| ((ms / 1000.0) * state.sample_rate as f32) as usize)
                    .unwrap_or(current.lookahead),
                true_peak:       upd.true_peak.unwrap_or(current.true_peak),
                release_samples: upd.release_ms
                    .map(|ms| (ms / 1000.0) * state.sample_rate as f32)
                    .unwrap_or(current.release_samples),
            };
            *state.pending.lock().unwrap() = Some(next);
            // Reflect the requested params immediately in /status; the
            // audio thread will apply them at the next block boundary.
            *state.params.lock().unwrap() = next;
            serde_json::to_value(build_report(state)).unwrap()
        }
        _ => serde_json::json!({ "error": format!("unknown op: {op}") }),
    }
}

fn handle_client(stream: UnixStream, state: Arc<SharedState>) -> Result<()> {
    let peer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let mut writer = peer;
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 { break; } // client closed
        let resp = handle_line(line.trim_end(), &state);
        let mut text = resp.to_string();
        text.push('\n');
        writer.write_all(text.as_bytes())?;
        writer.flush()?;
    }
    Ok(())
}

pub fn spawn(socket_path: &Path, state: Arc<SharedState>) -> Result<()> {
    if socket_path.exists() {
        std::fs::remove_file(socket_path)?;
    }
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listener = UnixListener::bind(socket_path)?;
    // 0666 so the backend (running as same user) can connect; the parent
    // dir's perms gate access for everyone else.
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o666))?;

    let path_display = socket_path.display().to_string();
    log::info!("control socket listening on {path_display}");

    thread::spawn(move || {
        for conn in listener.incoming() {
            match conn {
                Ok(stream) => {
                    let st = state.clone();
                    thread::spawn(move || {
                        if let Err(e) = handle_client(stream, st) {
                            log::warn!("control client error: {e}");
                        }
                    });
                }
                Err(e) => log::warn!("control accept error: {e}"),
            }
        }
    });
    Ok(())
}
