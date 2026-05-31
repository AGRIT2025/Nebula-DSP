import { useEffect, useRef, useState } from 'react'
import { useEngineStatus } from '@/hooks/useEngineStatus'
import { nebulaAPI, type CamillaConfig } from '@/lib/nebulaAPI'
import { Card, Badge } from '@/components/ui/Card'
import { ChannelMeters } from '@/components/ui/VuMeter'
import { Power, Save, RotateCcw, AlertTriangle } from 'lucide-react'

// Nombre con el que se inyecta el Compressor processor en el YAML del
// engine. Si el usuario tenía processors con otros nombres, los respetamos
// — sólo manejamos el nuestro.
const PROCESSOR_NAME = 'nebula_compressor'

// Defaults que dan un Dynamics suave / transparente — útiles como
// "punto de partida" cuando no hay nada cargado todavía.
const DEFAULTS = {
  threshold:   -20,    // dB
  factor:      4,      // ratio 4:1
  attack:      0.010,  // 10 ms
  release:     0.200,  // 200 ms
  makeup_gain: 6,      // dB
  clip_limit:  -1.0,   // dBFS (post-compression)
  soft_clip:   true,
}

// GR meter visual.
function GainReductionMeter({ reductionDb }: { reductionDb: number }) {
  const pct = Math.min(100, Math.max(0, (Math.abs(reductionDb) / 30) * 100))
  const color = pct < 30 ? '#22c55e' : pct < 60 ? '#eab308' : pct < 85 ? '#f97316' : '#ef4444'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-[#505070]">Gain Reduction (estimate)</span>
        <span className="text-sm font-mono font-bold" style={{ color }}>
          {reductionDb < -0.1 ? reductionDb.toFixed(1) : '0.0'} dB
        </span>
      </div>
      <div className="relative h-4 bg-[#0a0a14] rounded-md overflow-hidden border border-[#1a1a2e]">
        {[10, 20, 33, 50, 67, 80, 90].map(p => (
          <div key={p} className="absolute top-0 bottom-0 w-px opacity-20" style={{ left: `${p}%`, background: '#505070' }} />
        ))}
        <div
          className="absolute top-0 right-0 bottom-0 rounded-md transition-none"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(to left, ${color}, ${color}88)`,
            boxShadow: pct > 10 ? `0 0 8px ${color}44` : 'none',
          }}
        />
        <div className="absolute top-0 bottom-0 right-0 w-0.5 bg-[#505070] opacity-60" />
      </div>
      <div className="flex justify-between text-[9px] font-mono text-[#505070]">
        <span>-30</span><span>-20</span><span>-10</span><span>-6</span><span>-3</span><span>0 dB</span>
      </div>
    </div>
  )
}

// Curva de transferencia visual (sólo depende de los params, no del audio).
function TransferCurve({ threshold, factor, knee = 6 }: { threshold: number; factor: number; knee?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d'); if (!ctx) return
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)
    ctx.strokeStyle = '#252540'; ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const x = (i / 4) * W, y = (i / 4) * H
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
    }
    ctx.strokeStyle = '#505070'; ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.stroke()
    ctx.setLineDash([])
    ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 2
    ctx.shadowBlur = 8; ctx.shadowColor = '#6366f1'
    ctx.beginPath()
    for (let px = 0; px < W; px++) {
      const inDb = -60 + (px / W) * 60
      let outDb: number
      const halfKnee = knee / 2
      if (inDb < threshold - halfKnee) outDb = inDb
      else if (inDb > threshold + halfKnee) outDb = threshold + (inDb - threshold) / factor
      else {
        const x = inDb - threshold + halfKnee
        outDb = inDb + ((1 / factor - 1) * x * x) / (2 * knee)
      }
      const py = H - ((outDb + 60) / 60) * H
      if (px === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
    }
    ctx.stroke(); ctx.shadowBlur = 0
    const tx = ((threshold + 60) / 60) * W
    ctx.strokeStyle = '#6366f144'; ctx.lineWidth = 1; ctx.setLineDash([3, 3])
    ctx.beginPath(); ctx.moveTo(tx, 0); ctx.lineTo(tx, H); ctx.stroke()
    ctx.setLineDash([])
  }, [threshold, factor, knee])
  return (
    <canvas
      ref={canvasRef}
      width={200}
      height={200}
      className="rounded-lg border border-[#252540]"
      style={{ width: '100%', maxWidth: 200, height: 'auto', aspectRatio: '1' }}
    />
  )
}

// Extrae los params del Compressor processor del YAML cargado, si existe.
function readFromConfig(config: CamillaConfig | null) {
  if (!config) return null
  const processors = (config.processors as Record<string, Record<string, unknown>> | undefined) ?? {}
  const proc = processors[PROCESSOR_NAME]
  if (!proc || proc.type !== 'Compressor') return null
  const p = (proc.parameters as Record<string, unknown> | undefined) ?? {}
  return {
    threshold:   Number(p.threshold   ?? DEFAULTS.threshold),
    factor:      Number(p.factor      ?? DEFAULTS.factor),
    attack:      Number(p.attack      ?? DEFAULTS.attack),
    release:     Number(p.release     ?? DEFAULTS.release),
    makeup_gain: Number(p.makeup_gain ?? DEFAULTS.makeup_gain),
    clip_limit:  Number(p.clip_limit  ?? DEFAULTS.clip_limit),
    soft_clip:   Boolean(p.soft_clip ?? DEFAULTS.soft_clip),
  }
}

// Inserta o actualiza el Compressor processor + pipeline step. Mutación
// inmutable (devuelve copia nueva, no toca la original).
function writeToConfig(
  config: CamillaConfig,
  params: typeof DEFAULTS,
  channels: number,
): CamillaConfig {
  const next: CamillaConfig = { ...config }
  const channelList = Array.from({ length: channels }, (_, i) => i)

  // Update processors
  const processors = { ...((next.processors as Record<string, unknown>) ?? {}) }
  processors[PROCESSOR_NAME] = {
    type: 'Compressor',
    parameters: {
      channels,
      attack:           params.attack,
      release:          params.release,
      threshold:        params.threshold,
      factor:           params.factor,
      makeup_gain:      params.makeup_gain,
      clip_limit:       params.clip_limit,
      soft_clip:        params.soft_clip,
      monitor_channels: channelList,
      process_channels: channelList,
    },
  }
  next.processors = processors

  // Ensure pipeline contains exactly one Processor step for nebula_compressor.
  // Lo insertamos al final del pipeline (post-EQ/filters → último antes del playback).
  const pipeline = [...((next.pipeline as Record<string, unknown>[]) ?? [])]
  const has = pipeline.some(s => s.type === 'Processor' && s.name === PROCESSOR_NAME)
  if (!has) {
    pipeline.push({ type: 'Processor', name: PROCESSOR_NAME })
  }
  next.pipeline = pipeline

  return next
}

// Saca el processor + step del pipeline.
function removeFromConfig(config: CamillaConfig): CamillaConfig {
  const next: CamillaConfig = { ...config }
  const processors = { ...((next.processors as Record<string, unknown>) ?? {}) }
  delete processors[PROCESSOR_NAME]
  next.processors = processors
  const pipeline = ((next.pipeline as Record<string, unknown>[]) ?? [])
    .filter(s => !(s.type === 'Processor' && s.name === PROCESSOR_NAME))
  next.pipeline = pipeline
  return next
}

export function Compressor() {
  const s = useEngineStatus(100)
  const [params, setParams] = useState<typeof DEFAULTS>(DEFAULTS)
  const [active, setActive] = useState(false)
  const [busy,   setBusy]   = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const [dirty,  setDirty]  = useState(false)

  // Cargar params del config activo al montar y cada vez que cambie el
  // active config (poll suave, no agresivo).
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const config = await nebulaAPI.getConfig()
        if (!alive) return
        const fromConfig = readFromConfig(config)
        if (fromConfig) {
          setParams(fromConfig)
          setActive(true)
        } else {
          setActive(false)
        }
        setDirty(false)
      } catch { /* engine offline; mantener defaults */ }
    }
    load()
    const id = setInterval(load, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // Estimación de GR — proxy honesto: peak playback - peak capture, en dB.
  // No es la GR exacta del compressor (upstream no expone ese valor), pero
  // refleja correctamente cuándo hay reducción real en la cadena.
  const peakCapDb = s.capturePeak.length  ? Math.max(...s.capturePeak)  : -60
  const peakPlbDb = s.playbackPeak.length ? Math.max(...s.playbackPeak) : -60
  const grRaw = active ? Math.min(0, peakPlbDb - peakCapDb - params.makeup_gain) : 0
  const grRef = useRef(0)
  grRef.current = grRef.current * 0.85 + grRaw * 0.15

  const update = (patch: Partial<typeof DEFAULTS>) => {
    setParams(prev => ({ ...prev, ...patch }))
    setDirty(true)
    setError(null)
  }

  const apply = async () => {
    setBusy(true); setError(null)
    try {
      const config = await nebulaAPI.getConfig()
      if (!config || !config.devices) {
        throw new Error('No hay config activo en el engine')
      }
      const channels = Number(
        (config.devices as Record<string, Record<string, unknown>>).capture?.channels ?? 2,
      ) || 2
      const next = writeToConfig(config, params, channels)
      // Validar antes de aplicar.
      const v = await nebulaAPI.validateConfig(next)
      if (v && v.result !== 'OK' && v.error) {
        throw new Error(`Validación falló: ${v.error}`)
      }
      await nebulaAPI.setConfig(next)
      setActive(true); setDirty(false)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const bypass = async () => {
    setBusy(true); setError(null)
    try {
      const config = await nebulaAPI.getConfig()
      if (!config) throw new Error('No hay config activo en el engine')
      const next = removeFromConfig(config)
      await nebulaAPI.setConfig(next)
      setActive(false); setDirty(false)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const reset = () => { setParams(DEFAULTS); setDirty(true); setError(null) }

  return (
    <div className="flex flex-col gap-5">

      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Compressor</h1>
        <span className="text-[11px] text-[#505070] bg-[#6366f115] border border-[#6366f130] rounded-md px-2 py-0.5">
          Dynamic Range Processor
        </span>
        <Badge label={active ? 'Active' : 'Bypassed'} color={active ? 'green' : 'gray'} dot pulse={active} />
        {dirty && <Badge label="Unsaved" color="yellow" />}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={reset}
            disabled={busy}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#252540] text-xs text-[#9090bb] hover:border-[#505070] disabled:opacity-50 transition-all"
          >
            <RotateCcw size={12} />
            Reset
          </button>
          <button
            onClick={bypass}
            disabled={busy || !active}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#ef444450] text-xs text-[#ef4444] hover:bg-[#ef444415] disabled:opacity-50 transition-all"
          >
            <Power size={12} />
            Bypass
          </button>
          <button
            onClick={apply}
            disabled={busy || (!dirty && active)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#6366f1] text-xs font-semibold text-white hover:bg-[#818cf8] disabled:opacity-50 transition-all"
          >
            <Save size={12} />
            {active && !dirty ? 'Applied' : 'Apply'}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-[#ef444450] bg-[#ef444410] text-[#ef4444] text-xs">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        <Card title="Parameters" accent="#6366f1" className="lg:col-span-1">
          <div className="flex flex-col gap-4">
            {[
              { key: 'threshold',   label: 'Threshold',   min: -60,  max: 0,   step: 1,    unit: 'dB',  color: '#6366f1' },
              { key: 'factor',      label: 'Ratio',       min: 1,    max: 20,  step: 0.5,  unit: ':1',  color: '#a855f7' },
              { key: 'attack',      label: 'Attack',      min: 0.001, max: 0.5, step: 0.001, unit: 's',   color: '#06b6d4' },
              { key: 'release',     label: 'Release',     min: 0.01, max: 5,   step: 0.01, unit: 's',   color: '#22c55e' },
              { key: 'makeup_gain', label: 'Makeup Gain', min: 0,    max: 24,  step: 0.5,  unit: 'dB',  color: '#f97316' },
              { key: 'clip_limit',  label: 'Clip Ceiling', min: -6,  max: 0,   step: 0.1,  unit: 'dBFS', color: '#eab308' },
            ].map(({ key, label, min, max, step, unit, color }) => {
              const value = params[key as keyof typeof DEFAULTS] as number
              return (
                <div key={key} className="flex flex-col gap-1.5">
                  <div className="flex justify-between">
                    <span className="text-[11px] text-[#9090bb]">{label}</span>
                    <span className="text-[11px] font-mono font-semibold" style={{ color }}>
                      {typeof value === 'number' ? value.toFixed(step < 0.01 ? 3 : 2) : value}{unit}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={min} max={max} step={step}
                    value={value}
                    onChange={e => update({ [key]: Number(e.target.value) } as Partial<typeof DEFAULTS>)}
                    className="w-full h-1 rounded-full appearance-none bg-[#12121f] accent-[#6366f1]"
                    style={{
                      background: `linear-gradient(to right, ${color} 0%, ${color} ${((value - min) / (max - min)) * 100}%, #12121f ${((value - min) / (max - min)) * 100}%, #12121f 100%)`,
                    }}
                  />
                </div>
              )
            })}

            <label className="flex items-center gap-2 cursor-pointer mt-1">
              <input
                type="checkbox"
                checked={params.soft_clip}
                onChange={e => update({ soft_clip: e.target.checked })}
                className="accent-[#6366f1]"
              />
              <span className="text-[11px] text-[#9090bb]">Soft clip (post-compression)</span>
            </label>
          </div>
        </Card>

        <Card title="Gain Reduction" accent="#a855f7" className="lg:col-span-1">
          <div className="flex flex-col gap-5">
            <GainReductionMeter reductionDb={grRef.current} />
            <div className="flex flex-col gap-2">
              <span className="text-[10px] uppercase tracking-widest text-[#505070]">Transfer Curve</span>
              <div className="flex justify-center">
                <TransferCurve threshold={params.threshold} factor={params.factor} />
              </div>
            </div>
            <div className="text-[10px] text-[#505070] leading-relaxed border-t border-[#1a1a2e] pt-3">
              GR estimada del peak playback vs capture. El motor de
              CamillaDSP no expone GR exacta por canal; este número
              refleja cuándo hay reducción real en la cadena.
            </div>
          </div>
        </Card>

        <Card title="Signal Levels" accent="#22c55e" className="lg:col-span-1">
          <div className="flex flex-col gap-4">
            <div>
              <span className="text-[10px] uppercase tracking-widest text-[#505070] mb-2 block">Input (capture)</span>
              <ChannelMeters peaks={s.capturePeak} rms={s.captureRms} />
            </div>
            <div className="border-t border-[#252540] pt-4">
              <span className="text-[10px] uppercase tracking-widest text-[#505070] mb-2 block">Output (playback)</span>
              <ChannelMeters peaks={s.playbackPeak} rms={s.playbackRms} />
            </div>
          </div>
        </Card>

      </div>
    </div>
  )
}
