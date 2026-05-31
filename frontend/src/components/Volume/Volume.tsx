import { useEffect, useState, useCallback, useMemo } from 'react'
import { Activity, Gauge, Timer, RotateCcw, AlertOctagon } from 'lucide-react'
import { nebulaAPI, formatDb, K_SYSTEMS, K_SYSTEM_LABEL, type KSystem } from '@/lib/nebulaAPI'
import { useEngineStatus } from '@/hooks/useEngineStatus'
import { Card } from '@/components/ui/Card'
import { ChannelStrip } from '@/components/ui/ChannelStrip'

const FADER_COLORS = ['#6366f1', '#a855f7', '#06b6d4', '#22c55e', '#eab308']
const STRIP_LABELS = ['Main', 'Aux 1', 'Aux 2', 'Aux 3', 'Aux 4']
const K_SYSTEM_STORAGE = 'nebula.kSystem'

interface FaderState {
  volume: number
  mute:   boolean
}

const DEFAULT_FADER: FaderState = { volume: 0, mute: false }

export function Volume() {
  const status = useEngineStatus(100)   // 10 Hz: meters look fluid + RAF ballistics interpolate

  // ── 5 fader buses state ────────────────────────────────────────────────
  const [faders, setFaders] = useState<FaderState[]>([
    { ...DEFAULT_FADER }, { ...DEFAULT_FADER }, { ...DEFAULT_FADER },
    { ...DEFAULT_FADER }, { ...DEFAULT_FADER },
  ])
  /** True for each bus that the engine actually reports as in-use (i.e. some
   *  Volume filter in the pipeline references this fader index). */
  const [busActive, setBusActive] = useState<boolean[]>([true, false, false, false, false])

  // ── K-system: persisted in localStorage ───────────────────────────────
  const [kSystem, setKSystem] = useState<KSystem>(() => {
    try {
      const stored = localStorage.getItem(K_SYSTEM_STORAGE) as KSystem | null
      if (stored && K_SYSTEMS.includes(stored)) return stored
    } catch { /* ignore */ }
    return 'off'
  })
  useEffect(() => {
    try { localStorage.setItem(K_SYSTEM_STORAGE, kSystem) } catch { /* ignore */ }
  }, [kSystem])

  // ── Solo state (visual-only in v1) ─────────────────────────────────────
  const [solo, setSolo] = useState<boolean[]>([false, false, false, false, false])

  // ── Refresh from engine ────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    try {
      const [volume, mute] = await Promise.all([nebulaAPI.getVolume(), nebulaAPI.getMute()])
      try {
        const [vols, mts] = await Promise.all([
          nebulaAPI.getAllFaderVolumes(),
          nebulaAPI.getAllFaderMutes(),
        ])
        const volArr = Array.isArray(vols) ? vols : []
        const muteArr = Array.isArray(mts)  ? mts  : []
        if (volArr.length > 1) {
          setFaders(Array.from({ length: 5 }, (_, i) => ({
            volume: Number(volArr[i]) || 0,
            mute:   Boolean(muteArr[i]),
          })))
          // A bus is "active" when it's referenced in the pipeline — we infer
          // this from the engine reporting a non-default value, OR keep
          // Main always on. Simpler heuristic: index 0 always on; aux on if
          // the list has > 1 entries (engine reported them).
          setBusActive([true, true, true, true, true])
          return
        }
      } catch { /* fall through */ }
      // No fader list reported → only Main is in use.
      setFaders(prev => {
        const next = [...prev]
        next[0] = { volume, mute }
        return next
      })
      setBusActive([true, false, false, false, false])
    } catch { /* engine offline */ }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 1000)
    return () => clearInterval(id)
  }, [refresh])

  // ── Writes ─────────────────────────────────────────────────────────────
  const setVolume = async (idx: number, db: number) => {
    setFaders(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], volume: db }
      return next
    })
    if (idx === 0) await nebulaAPI.setVolume(db)
    else            await nebulaAPI.setFaderVolume(idx, db)
  }
  const toggleMute = async (idx: number) => {
    const cur = faders[idx].mute
    setFaders(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], mute: !cur }
      return next
    })
    if (idx === 0) await nebulaAPI.setMute(!cur)
    else            await nebulaAPI.setFaderMute(idx, !cur)
  }
  const toggleSolo = (idx: number) => {
    setSolo(prev => prev.map((s, i) => i === idx ? !s : s))
  }

  // ── Master panel data ──────────────────────────────────────────────────
  // Use playback peak/rms (the meter shows what's about to hit the DAC).
  const masterPeakL = status.playbackPeak[0] ?? -60
  const masterPeakR = status.playbackPeak[1] ?? status.playbackPeak[0] ?? -60
  const masterRmsL  = status.playbackRms[0]  ?? -60
  const masterRmsR  = status.playbackRms[1]  ?? status.playbackRms[0]  ?? -60

  // For each strip we use the same playback signal until per-bus metering
  // exists in CamillaDSP (it doesn't). Aux buses without a Volume filter
  // get the same signal — visually the meter just shows that the master is
  // moving but the bus's own gain is unused.
  const stripPeakL = useMemo(() => masterPeakL, [masterPeakL])
  const stripPeakR = useMemo(() => masterPeakR, [masterPeakR])
  const stripRmsL  = useMemo(() => masterRmsL,  [masterRmsL])
  const stripRmsR  = useMemo(() => masterRmsR,  [masterRmsR])

  // Channel count derived from the playback peak array length (the engine
  // reports per-channel peaks). Format string in the header is derived
  // from this + capturerate.
  const channels = status.playbackPeak.length || 2
  const sampleRate = status.captureRate || 48000

  // Clip counter: total + delta since last reset.
  const [clipResetAnchor, setClipResetAnchor] = useState(0)
  const clipDisplay = Math.max(0, status.clippedSamples - clipResetAnchor)
  const handleClipReset = () => setClipResetAnchor(status.clippedSamples)

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Volume & Routing</h1>
        <span className="text-[11px] text-[#505070] bg-[#6366f115] border border-[#6366f130] rounded-md px-2 py-0.5">
          {channels}-channel · {(sampleRate / 1000).toFixed(1)} kHz
        </span>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-[#505070]">Meter scale</span>
          <select
            value={kSystem}
            onChange={e => setKSystem(e.target.value as KSystem)}
            className="bg-[#12121f] border border-[#252540] rounded-md px-2 py-1 text-xs text-[#9090bb]"
            title="K-system shifts the 0-dB reference; affects only the meter display, not the audio"
          >
            {K_SYSTEMS.map(k => (
              <option key={k} value={k}>{K_SYSTEM_LABEL[k]}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">

        {/* ── Channel strips ──────────────────────────────────────────── */}
        <Card title="Fader Bank" accent="#6366f1">
          <div className="flex gap-3 justify-center flex-wrap py-2">
            {faders.map((f, i) => (
              <ChannelStrip
                key={i}
                index={i}
                label={STRIP_LABELS[i]}
                color={FADER_COLORS[i] ?? '#6366f1'}
                enabled={busActive[i]}
                enabledHint={!busActive[i] ? 'no Volume filter references this bus' : undefined}
                volumeDb={f.volume}
                mute={f.mute}
                solo={solo[i]}
                peakL={stripPeakL} peakR={stripPeakR}
                rmsL={stripRmsL}   rmsR={stripRmsR}
                kSystem={kSystem}
                onVolumeChange={db => setVolume(i, db)}
                onMuteToggle={() => toggleMute(i)}
                onSoloToggle={() => toggleSolo(i)}
              />
            ))}
          </div>
          <div className="mt-3 pt-3 border-t border-[#1a1a2e] text-[10px] text-[#505070] text-center">
            <kbd className="px-1 py-0.5 bg-[#0a0a14] border border-[#252540] rounded">scroll</kbd> over a fader = ±0.1 dB ·
            <kbd className="px-1 py-0.5 bg-[#0a0a14] border border-[#252540] rounded ml-1">shift+scroll</kbd> = ±0.5 dB ·
            <kbd className="px-1 py-0.5 bg-[#0a0a14] border border-[#252540] rounded ml-1">dbl-click</kbd> resets to 0 ·
            click the dB value to type a number
          </div>
        </Card>

        {/* ── Master panel ───────────────────────────────────────────── */}
        <Card title="Master" accent="#a855f7">
          <div className="flex flex-col gap-4">

            {/* Peak + RMS readouts */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex items-center gap-1 mb-1">
                  <AlertOctagon size={10} className="text-[#ef4444]" />
                  <span className="text-[10px] uppercase tracking-widest text-[#505070]">Peak</span>
                </div>
                <div className="text-2xl font-mono font-bold tabular-nums" style={{
                  color: masterPeakL > -3 ? '#ef4444' : masterPeakL > -12 ? '#eab308' : '#22c55e',
                }}>
                  {formatDb(Math.max(masterPeakL, masterPeakR), 1)}
                </div>
              </div>
              <div>
                <div className="flex items-center gap-1 mb-1">
                  <Activity size={10} className="text-[#22c55e]" />
                  <span className="text-[10px] uppercase tracking-widest text-[#505070]">RMS</span>
                </div>
                <div className="text-2xl font-mono font-bold tabular-nums text-[#9090bb]">
                  {formatDb((masterRmsL + masterRmsR) / 2, 1)}
                </div>
              </div>
            </div>

            {/* CPU load bar */}
            <div className="border-t border-[#1a1a2e] pt-3">
              <div className="flex items-center gap-1 mb-1">
                <Gauge size={10} className="text-[#6366f1]" />
                <span className="text-[10px] uppercase tracking-widest text-[#505070]">DSP load</span>
                <span className="ml-auto text-[11px] font-mono font-semibold text-[#e8e8ff]">
                  {status.processingLoad.toFixed(1)}%
                </span>
              </div>
              <div className="h-1.5 bg-[#0a0a14] rounded-full overflow-hidden border border-[#1a1a2e]">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, status.processingLoad)}%`,
                    background:
                      status.processingLoad > 80 ? '#ef4444' :
                      status.processingLoad > 50 ? '#eab308' : '#22c55e',
                  }}
                />
              </div>
            </div>

            {/* Latency */}
            <div className="border-t border-[#1a1a2e] pt-3">
              <div className="flex items-center gap-1 mb-1">
                <Timer size={10} className="text-[#06b6d4]" />
                <span className="text-[10px] uppercase tracking-widest text-[#505070]">Latency</span>
                <span className="ml-auto text-[11px] font-mono font-semibold text-[#e8e8ff]">
                  {status.latencyMs > 0 ? `${status.latencyMs.toFixed(1)} ms` : '—'}
                </span>
              </div>
              <div className="text-[9px] font-mono text-[#505070]">
                buffer {status.bufferLevel} smp @ {(sampleRate / 1000).toFixed(0)} kHz
              </div>
            </div>

            {/* Clips counter */}
            <div className="border-t border-[#1a1a2e] pt-3">
              <div className="flex items-center gap-1 mb-1">
                <span className="text-[10px] uppercase tracking-widest text-[#505070]">Clips</span>
                <span className={`ml-auto text-[11px] font-mono font-semibold ${
                  clipDisplay > 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'
                }`}>
                  {clipDisplay > 0 ? `+${clipDisplay.toLocaleString()}` : '0'}
                </span>
              </div>
              {/* LED segment row */}
              <div className="flex gap-0.5 mb-2">
                {Array.from({ length: 12 }, (_, i) => (
                  <div
                    key={i}
                    className="flex-1 h-1.5 rounded-sm"
                    style={{
                      background: i < Math.min(12, clipDisplay > 0 ? Math.log2(clipDisplay + 1) + 1 : 0)
                        ? (i < 4 ? '#22c55e' : i < 8 ? '#eab308' : '#ef4444')
                        : '#252540',
                    }}
                  />
                ))}
              </div>
              <button
                onClick={handleClipReset}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded text-[10px] text-[#9090bb] border border-[#252540] hover:border-[#6366f1] transition-colors"
              >
                <RotateCcw size={10} />
                Reset count
              </button>
              <div className="text-[9px] font-mono text-[#303050] mt-1.5 text-center">
                total: {status.clippedSamples.toLocaleString()}
              </div>
            </div>

            {/* Engine state pill */}
            <div className="border-t border-[#1a1a2e] pt-3 text-[10px] font-mono text-[#505070] text-center">
              {status.connected ? (
                <>
                  <span className="text-[#22c55e]">●</span> {status.state ?? '—'} ·
                  CDSP {status.raw?.cdsp_version ?? '—'}
                </>
              ) : (
                <span className="text-[#ef4444]">● ENGINE OFFLINE</span>
              )}
            </div>

          </div>
        </Card>
      </div>
    </div>
  )
}
