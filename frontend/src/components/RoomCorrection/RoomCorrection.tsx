import { useState, useEffect, useRef, useCallback } from 'react'
import { nebulaAPI, type RcBiquad, type RcDesignResult } from '@/lib/nebulaAPI'
import { Card, Badge } from '@/components/ui/Card'
import { Mic, Activity, Check, Trash2, Download, RefreshCw } from 'lucide-react'

// ── Canvas helpers ───────────────────────────────────────────────────────────

const FREQ_MIN = 20
const FREQ_MAX = 20000
const DB_MIN   = -40
const DB_MAX   = 24

function freqToX(f: number, w: number): number {
  return (Math.log10(f / FREQ_MIN) / Math.log10(FREQ_MAX / FREQ_MIN)) * w
}

function dbToY(db: number, h: number): number {
  return h - ((db - DB_MIN) / (DB_MAX - DB_MIN)) * h
}

const GRID_FREQS  = [20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000]
const GRID_LABELS = ['20', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '20k']
const LABEL_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const GRID_DBS    = [-40, -30, -20, -10, 0, 10, 20]

function drawCanvas(
  canvas:      HTMLCanvasElement,
  measured:    { freqs: number[]; db: number[] } | null,
  corrected:   { freqs: number[]; db: number[] } | null,
  target:      { freqs: number[]; db: number[] } | null,
  placeholder: string,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width: W, height: H } = canvas
  const PAD = { top: 12, right: 12, bottom: 30, left: 44 }
  const cw = W - PAD.left - PAD.right
  const ch = H - PAD.top  - PAD.bottom

  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = '#080810'
  ctx.fillRect(0, 0, W, H)

  const tx = (f: number) => PAD.left + freqToX(f, cw)
  const ty = (db: number) => PAD.top  + dbToY(db, ch)

  // Grid
  ctx.strokeStyle = '#1a1a2e'
  ctx.lineWidth   = 1
  for (const f of GRID_FREQS) {
    const x = tx(f)
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + ch); ctx.stroke()
  }
  for (const db of GRID_DBS) {
    const y = ty(db)
    ctx.strokeStyle = db === 0 ? '#2a2a4a' : '#1a1a2e'
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cw, y); ctx.stroke()
  }

  // Axis labels
  ctx.fillStyle = '#505070'
  ctx.font      = '10px monospace'
  ctx.textAlign = 'center'
  for (let i = 0; i < LABEL_FREQS.length; i++) {
    const x = tx(LABEL_FREQS[i])
    ctx.fillText(GRID_LABELS[i], x, PAD.top + ch + 18)
  }
  ctx.textAlign = 'right'
  for (const db of GRID_DBS) {
    ctx.fillText(`${db > 0 ? '+' : ''}${db}`, PAD.left - 6, ty(db) + 3)
  }

  if (!measured) {
    // Placeholder
    ctx.fillStyle = '#303050'
    ctx.font      = '13px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(placeholder, W / 2, H / 2)
    return
  }

  const drawCurve = (freqs: number[], db: number[], color: string, width: number, dash: number[] = []) => {
    ctx.strokeStyle = color
    ctx.lineWidth   = width
    ctx.setLineDash(dash)
    ctx.beginPath()
    let started = false
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] < FREQ_MIN || freqs[i] > FREQ_MAX) continue
      const x = tx(freqs[i])
      const y = ty(Math.max(DB_MIN, Math.min(DB_MAX, db[i])))
      if (!started) { ctx.moveTo(x, y); started = true } else { ctx.lineTo(x, y) }
    }
    ctx.stroke()
    ctx.setLineDash([])
  }

  if (target)    drawCurve(target.freqs,    target.db,    '#22c55e',  1,   [4, 4])
  if (measured)  drawCurve(measured.freqs,  measured.db,  '#06b6d4',  1.5, [])
  if (corrected) drawCurve(corrected.freqs, corrected.db, '#818cf8',  2,   [])

  // Legend
  const legends: [string, string][] = []
  if (measured)  legends.push(['Measured',   '#06b6d4'])
  if (target)    legends.push(['Target',     '#22c55e'])
  if (corrected) legends.push(['Corrected',  '#818cf8'])
  let lx = PAD.left + 8
  ctx.font = '10px monospace'
  for (const [label, color] of legends) {
    ctx.fillStyle   = color
    ctx.strokeStyle = color
    ctx.lineWidth   = 2
    ctx.setLineDash([])
    ctx.beginPath(); ctx.moveTo(lx, PAD.top + 10); ctx.lineTo(lx + 18, PAD.top + 10); ctx.stroke()
    ctx.fillText(label, lx + 22, PAD.top + 13)
    lx += 22 + ctx.measureText(label).width + 16
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'measuring' | 'measured' | 'designing' | 'designed' | 'applied'

interface Measurement {
  frequencies: number[]
  magnitude_db: number[]
}

// ── Component ────────────────────────────────────────────────────────────────

export function RoomCorrection() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [phase,       setPhase]     = useState<Phase>('idle')
  const [progress,    setProgress]  = useState(0)
  const [progressMsg, setMsg]       = useState('')
  const [jobId,       setJobId]     = useState<string | null>(null)
  const [measurement, setMeasurement] = useState<Measurement | null>(null)
  const [design,      setDesign]    = useState<RcDesignResult | null>(null)
  const [targets,     setTargets]   = useState<{ id: string; label: string }[]>([])
  const [selectedTarget, setTarget] = useState('flat')
  const [filterMode,  setMode]      = useState<'iir' | 'fir'>('iir')
  const [error,       setError]     = useState<string | null>(null)

  // Load target curves on mount
  useEffect(() => {
    nebulaAPI.rcTargets().then(setTargets).catch(() => {})
  }, [])

  // Poll job status
  useEffect(() => {
    if (!jobId || phase !== 'measuring') return
    const id = setInterval(async () => {
      try {
        const status = await nebulaAPI.rcJobStatus(jobId)
        setProgress(status.progress)
        setMsg(status.message)
        if (status.status === 'done') {
          clearInterval(id)
          const result = await nebulaAPI.rcResult()
          setMeasurement({ frequencies: result.frequencies, magnitude_db: result.magnitude_db })
          setPhase('measured')
        } else if (status.status === 'error') {
          clearInterval(id)
          setError(status.message)
          setPhase('idle')
        }
      } catch { /* retry next tick */ }
    }, 400)
    return () => clearInterval(id)
  }, [jobId, phase])

  // Redraw canvas whenever data changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const corrected: { freqs: number[]; db: number[] } | null = (() => {
      if (!measurement || !design) return null
      const correctedDb = measurement.magnitude_db.map((v, i) => v + (design.correction_db[i] ?? 0))
      return { freqs: measurement.frequencies, db: correctedDb }
    })()

    const placeholder = 'No measurement yet — press Start Measurement'

    drawCanvas(
      canvas,
      measurement ? { freqs: measurement.frequencies, db: measurement.magnitude_db } : null,
      corrected,
      null,
      placeholder,
    )
  }, [measurement, design, phase, progress])

  const startMeasurement = useCallback(async () => {
    setError(null)
    setDesign(null)
    setMeasurement(null)
    setPhase('measuring')
    setProgress(0)
    setMsg('Initializing…')
    try {
      const { job_id } = await nebulaAPI.rcMeasure()
      setJobId(job_id)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to start measurement')
      setPhase('idle')
    }
  }, [])

  const designFilters = useCallback(async () => {
    if (!measurement) return
    setPhase('designing')
    setError(null)
    try {
      const result = await nebulaAPI.rcDesign({
        mode:    filterMode,
        target:  selectedTarget,
        max_gain_db: 12,
      })
      setDesign(result)
      setPhase('designed')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Filter design failed')
      setPhase('measured')
    }
  }, [measurement, filterMode, selectedTarget])

  const applyCorrection = useCallback(async () => {
    try {
      const { ok } = await nebulaAPI.rcApply()
      if (ok) setPhase('applied')
      else    setError('Engine rejected the filters — check the config path')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Apply failed')
    }
  }, [])

  const removeCorrection = useCallback(async () => {
    try {
      await nebulaAPI.rcRemove()
      setPhase('designed')
    } catch { /* ignore */ }
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  const p         = phase as string
  const canStart  = p === 'idle' || p === 'measured' || p === 'designed' || p === 'applied'
  const canDesign = p === 'measured' || p === 'designed' || p === 'applied'
  const canApply  = p === 'designed'
  const canRemove = p === 'applied'
  const measuring = p === 'measuring'
  const designing = p === 'designing'

  return (
    <div className="flex flex-col gap-5">

      {/* ── Header ── */}
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Room Correction</h1>
        {measuring && <Badge label="Measuring…" color="blue" dot pulse />}
        {phase === 'measured'  && <Badge label="Measured"   color="green" dot />}
        {designing && <Badge label="Designing…" color="yellow" dot pulse />}
        {phase === 'designed'  && <Badge label="Ready"      color="yellow" dot />}
        {phase === 'applied'   && <Badge label="Active"     color="green"  dot pulse />}
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="px-4 py-3 rounded-lg bg-[#ef444415] border border-[#ef444430] text-[#ef4444] text-sm flex items-center gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-[#ef4444] hover:text-white">✕</button>
        </div>
      )}

      {/* ── FFT canvas ── */}
      <Card title="Frequency Response" accent="#06b6d4">
        <canvas
          ref={canvasRef}
          width={820}
          height={280}
          className="w-full rounded"
          style={{ imageRendering: 'pixelated' }}
        />
        <div className="mt-2 flex gap-4 text-[10px] font-mono text-[#505070]">
          <span>X: frequency (log scale, 20–20 kHz)</span>
          <span>Y: magnitude ({DB_MIN} to +{DB_MAX} dB)</span>
        </div>
      </Card>

      {/* ── Controls row ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

        {/* Measurement card */}
        <Card title="Measurement" accent="#06b6d4">
          <p className="text-xs text-[#505070] mb-4 leading-relaxed">
            Plays a logarithmic sweep through your speakers and records the
            room's response via the microphone input. Keep the room quiet
            during the 3-second sweep.
          </p>

          {measuring && (
            <div className="mb-4">
              <div className="flex justify-between text-xs text-[#505070] mb-1.5">
                <span>{progressMsg}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 bg-[#12121f] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${progress}%`,
                    background: 'linear-gradient(to right, #06b6d4, #6366f1)',
                  }}
                />
              </div>
            </div>
          )}

          <button
            onClick={startMeasurement}
            disabled={!canStart || measuring}
            className={`
              flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all
              ${canStart && phase !== 'measuring'
                ? 'bg-[#06b6d420] border border-[#06b6d430] text-[#06b6d4] hover:bg-[#06b6d435]'
                : 'bg-[#12121f] border border-[#252540] text-[#505070] cursor-not-allowed'
              }
            `}
          >
            {measuring
              ? <RefreshCw size={14} className="animate-spin" />
              : <Mic size={14} />
            }
            {measuring ? 'Measuring…' : 'Start Measurement'}
          </button>
        </Card>

        {/* Filter design card */}
        <Card title="Filter Design" accent="#6366f1">

          {/* Target curve selector */}
          <div className="flex flex-col gap-1.5 mb-4">
            <span className="text-[10px] uppercase tracking-widest text-[#505070] font-semibold">
              Target Curve
            </span>
            <div className="grid grid-cols-2 gap-1.5">
              {targets.map(t => (
                <button
                  key={t.id}
                  onClick={() => setTarget(t.id)}
                  className={`
                    text-[11px] px-3 py-1.5 rounded-lg border transition-all text-left
                    ${selectedTarget === t.id
                      ? 'bg-[#6366f120] border-[#6366f140] text-[#818cf8]'
                      : 'bg-[#12121f] border-[#252540] text-[#505070] hover:border-[#6366f130] hover:text-[#9090bb]'
                    }
                  `}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Mode toggle */}
          <div className="flex flex-col gap-1.5 mb-4">
            <span className="text-[10px] uppercase tracking-widest text-[#505070] font-semibold">
              Filter Type
            </span>
            <div className="flex gap-1.5">
              {(['iir', 'fir'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`
                    flex-1 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider border transition-all
                    ${filterMode === m
                      ? 'bg-[#6366f120] border-[#6366f140] text-[#818cf8]'
                      : 'bg-[#12121f] border-[#252540] text-[#505070] hover:border-[#6366f130]'
                    }
                  `}
                >
                  {m === 'iir' ? 'IIR (low latency)' : 'FIR (max quality)'}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={designFilters}
            disabled={!canDesign || designing}
            className={`
              flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all w-full justify-center
              ${canDesign && phase !== 'designing'
                ? 'bg-[#6366f120] border border-[#6366f140] text-[#818cf8] hover:bg-[#6366f130]'
                : 'bg-[#12121f] border border-[#252540] text-[#505070] cursor-not-allowed'
              }
            `}
          >
            {designing
              ? <RefreshCw size={14} className="animate-spin" />
              : <Activity size={14} />
            }
            {designing ? 'Designing…' : 'Design Filters'}
          </button>
        </Card>
      </div>

      {/* ── Filter list (IIR mode) ── */}
      {design && design.mode === 'iir' && design.biquads.length > 0 && (
        <Card title="Generated Biquad Filters" accent="#a855f7">
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-[#505070] border-b border-[#252540]">
                  <th className="text-left pb-2 pr-4">Type</th>
                  <th className="text-right pb-2 pr-4">Freq</th>
                  <th className="text-right pb-2 pr-4">Gain</th>
                  <th className="text-right pb-2">Q</th>
                </tr>
              </thead>
              <tbody>
                {design.biquads.map((bq: RcBiquad, i: number) => (
                  <tr key={i} className="border-b border-[#1a1a2e] last:border-0">
                    <td className="py-1.5 pr-4 text-[#a855f7]">{bq.type}</td>
                    <td className="py-1.5 pr-4 text-right text-[#e8e8ff]">
                      {bq.freq >= 1000 ? `${(bq.freq / 1000).toFixed(1)} kHz` : `${bq.freq} Hz`}
                    </td>
                    <td className={`py-1.5 pr-4 text-right font-bold ${bq.gain >= 0 ? 'text-[#06b6d4]' : 'text-[#f97316]'}`}>
                      {bq.gain >= 0 ? '+' : ''}{bq.gain.toFixed(1)} dB
                    </td>
                    <td className="py-1.5 text-right text-[#505070]">{bq.q.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {design.fir_path && (
            <p className="mt-2 text-[10px] text-[#505070]">
              FIR kernel: {design.fir_path}
            </p>
          )}
        </Card>
      )}

      {/* ── Action buttons ── */}
      {(canApply || canRemove) && (
        <div className="flex flex-wrap gap-3">
          {canApply && (
            <button
              onClick={applyCorrection}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#22c55e20] border border-[#22c55e40] text-[#22c55e] text-sm font-semibold hover:bg-[#22c55e30] transition-all"
            >
              <Check size={14} />
              Apply to Engine
            </button>
          )}
          {canRemove && (
            <button
              onClick={removeCorrection}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#ef444415] border border-[#ef444430] text-[#ef4444] text-sm font-semibold hover:bg-[#ef444425] transition-all"
            >
              <Trash2 size={14} />
              Remove Correction
            </button>
          )}
          <a
            href={nebulaAPI.rcExport()}
            download="nebula_correction.yml"
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#6366f115] border border-[#6366f130] text-[#818cf8] text-sm font-semibold hover:bg-[#6366f125] transition-all"
          >
            <Download size={14} />
            Export YAML
          </a>
        </div>
      )}

      {/* ── Applied status ── */}
      {phase === 'applied' && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-[#22c55e15] border border-[#22c55e30] text-[#22c55e] text-sm">
          <span className="w-2 h-2 rounded-full bg-[#22c55e] animate-[pulse-dot_2s_ease-in-out_infinite]" />
          Room correction active — filters injected into the DSP engine
        </div>
      )}

    </div>
  )
}
