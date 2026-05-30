import { useEffect, useRef, useState } from 'react'
import { useEngineStatus } from '@/hooks/useEngineStatus'
import { Card } from '@/components/ui/Card'
import { ChannelMeters } from '@/components/ui/VuMeter'

// GR meter: gain reduction visual (-30 dB to 0 dB)
function GainReductionMeter({ reductionDb }: { reductionDb: number }) {
  const pct = Math.min(100, Math.max(0, (Math.abs(reductionDb) / 30) * 100))
  const color =
    pct < 30 ? '#22c55e' :
    pct < 60 ? '#eab308' :
    pct < 85 ? '#f97316' : '#ef4444'

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-[#505070]">Gain Reduction</span>
        <span className="text-sm font-mono font-bold" style={{ color }}>
          {reductionDb < -0.1 ? reductionDb.toFixed(1) : '0.0'} dB
        </span>
      </div>

      {/* Horizontal GR bar (right-to-left) */}
      <div className="relative h-4 bg-[#0a0a14] rounded-md overflow-hidden border border-[#1a1a2e]">
        {/* Tick marks */}
        {[10, 20, 33, 50, 67, 80, 90].map(p => (
          <div
            key={p}
            className="absolute top-0 bottom-0 w-px opacity-20"
            style={{ left: `${p}%`, background: '#505070' }}
          />
        ))}
        {/* GR bar (from right side) */}
        <div
          className="absolute top-0 right-0 bottom-0 rounded-md transition-none"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(to left, ${color}, ${color}88)`,
            boxShadow: pct > 10 ? `0 0 8px ${color}44` : 'none',
          }}
        />
        {/* 0 dB marker */}
        <div className="absolute top-0 bottom-0 right-0 w-0.5 bg-[#505070] opacity-60" />
      </div>

      {/* Scale */}
      <div className="flex justify-between text-[9px] font-mono text-[#505070]">
        <span>-30</span>
        <span>-20</span>
        <span>-10</span>
        <span>-6</span>
        <span>-3</span>
        <span>0 dB</span>
      </div>
    </div>
  )
}

// Transfer curve canvas
function TransferCurve({
  threshold, ratio, knee
}: { threshold: number; ratio: number; knee: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width
    const H = canvas.height

    ctx.clearRect(0, 0, W, H)

    // Grid
    ctx.strokeStyle = '#252540'
    ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const x = (i / 4) * W
      const y = (i / 4) * H
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
    }

    // 1:1 reference
    ctx.strokeStyle = '#505070'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.stroke()
    ctx.setLineDash([])

    // Transfer curve
    ctx.strokeStyle = '#6366f1'
    ctx.lineWidth = 2
    ctx.shadowBlur = 8
    ctx.shadowColor = '#6366f1'
    ctx.beginPath()

    for (let px = 0; px < W; px++) {
      const inDb = -60 + (px / W) * 60
      let outDb: number
      const halfKnee = knee / 2

      if (inDb < threshold - halfKnee) {
        outDb = inDb
      } else if (inDb > threshold + halfKnee) {
        outDb = threshold + (inDb - threshold) / ratio
      } else {
        // Soft knee
        const x = inDb - threshold + halfKnee
        outDb = inDb + ((1 / ratio - 1) * x * x) / (2 * knee)
      }

      const py = H - ((outDb + 60) / 60) * H
      if (px === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
    ctx.shadowBlur = 0

    // Threshold line
    const tx = ((threshold + 60) / 60) * W
    ctx.strokeStyle = '#6366f144'
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath(); ctx.moveTo(tx, 0); ctx.lineTo(tx, H); ctx.stroke()
    ctx.setLineDash([])
  }, [threshold, ratio, knee])

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

export function Compressor() {
  const s = useEngineStatus(100)

  // Simulated GR from signal level + threshold (real GR needs engine support)
  const [threshold, setThreshold] = useState(-20)
  const [ratio, setRatio] = useState(4)
  const [attack, setAttack] = useState(10)
  const [release, setRelease] = useState(200)
  const [makeupGain, setMakeupGain] = useState(6)
  const [knee, setKnee] = useState(6)

  // Estimate GR from playback peak
  const peakDb = s.playbackPeak.length > 0
    ? Math.max(...s.playbackPeak)
    : -60
  const computedGr = peakDb > threshold
    ? -((peakDb - threshold) * (ratio - 1)) / ratio
    : 0

  const grRef = useRef(0)
  // Smooth GR display
  grRef.current = grRef.current * 0.85 + computedGr * 0.15

  const params = [
    { label: 'Threshold', value: `${threshold} dB`, color: '#6366f1' },
    { label: 'Ratio',     value: `${ratio}:1`,       color: '#a855f7' },
    { label: 'Attack',    value: `${attack} ms`,     color: '#06b6d4' },
    { label: 'Release',   value: `${release} ms`,    color: '#22c55e' },
    { label: 'Knee',      value: `${knee} dB`,       color: '#eab308' },
    { label: 'Makeup',    value: `+${makeupGain} dB`, color: '#f97316' },
  ]

  return (
    <div className="flex flex-col gap-5">

      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Compressor</h1>
        <span className="text-[11px] text-[#505070] bg-[#6366f115] border border-[#6366f130] rounded-md px-2 py-0.5">
          Dynamic Range Processor
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* ── Controls ── */}
        <Card title="Parameters" accent="#6366f1" className="lg:col-span-1">
          <div className="flex flex-col gap-4">

            {[
              { label: 'Threshold', value: threshold, setter: setThreshold, min: -60, max: 0, step: 1, unit: 'dB', color: '#6366f1' },
              { label: 'Ratio', value: ratio, setter: setRatio, min: 1, max: 20, step: 0.5, unit: ':1', color: '#a855f7' },
              { label: 'Attack', value: attack, setter: setAttack, min: 0.1, max: 500, step: 0.1, unit: 'ms', color: '#06b6d4' },
              { label: 'Release', value: release, setter: setRelease, min: 10, max: 5000, step: 10, unit: 'ms', color: '#22c55e' },
              { label: 'Knee', value: knee, setter: setKnee, min: 0, max: 24, step: 1, unit: 'dB', color: '#eab308' },
              { label: 'Makeup Gain', value: makeupGain, setter: setMakeupGain, min: 0, max: 24, step: 0.5, unit: 'dB', color: '#f97316' },
            ].map(({ label, value, setter, min, max, step, unit, color }) => (
              <div key={label} className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-[11px] text-[#9090bb]">{label}</span>
                  <span className="text-[11px] font-mono font-semibold" style={{ color }}>
                    {value}{unit}
                  </span>
                </div>
                <input
                  type="range"
                  min={min} max={max} step={step}
                  value={value}
                  onChange={e => setter(Number(e.target.value))}
                  className="w-full h-1 rounded-full appearance-none bg-[#12121f] accent-[#6366f1]"
                  style={{
                    background: `linear-gradient(to right, ${color} 0%, ${color} ${((value - min) / (max - min)) * 100}%, #12121f ${((value - min) / (max - min)) * 100}%, #12121f 100%)`,
                  }}
                />
              </div>
            ))}
          </div>
        </Card>

        {/* ── GR Meter + Transfer curve ── */}
        <Card title="Gain Reduction" accent="#a855f7" className="lg:col-span-1">
          <div className="flex flex-col gap-5">
            <GainReductionMeter reductionDb={grRef.current} />

            <div className="flex flex-col gap-2">
              <span className="text-[10px] uppercase tracking-widest text-[#505070]">Transfer Curve</span>
              <div className="flex justify-center">
                <TransferCurve threshold={threshold} ratio={ratio} knee={knee} />
              </div>
            </div>
          </div>
        </Card>

        {/* ── Signal levels ── */}
        <Card title="Signal Levels" accent="#22c55e" className="lg:col-span-1">
          <div className="flex flex-col gap-4">
            <div>
              <span className="text-[10px] uppercase tracking-widest text-[#505070] mb-2 block">Input</span>
              <ChannelMeters peaks={s.capturePeak} rms={s.captureRms} />
            </div>
            <div className="border-t border-[#252540] pt-4">
              <span className="text-[10px] uppercase tracking-widest text-[#505070] mb-2 block">Output</span>
              <ChannelMeters peaks={s.playbackPeak} rms={s.playbackRms} />
            </div>
            <div className="grid grid-cols-3 gap-2 border-t border-[#252540] pt-4">
              {params.map(p => (
                <div key={p.label} className="flex flex-col gap-0.5">
                  <span className="text-[9px] text-[#505070] uppercase">{p.label}</span>
                  <span className="text-xs font-mono font-semibold" style={{ color: p.color }}>{p.value}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>

      </div>
    </div>
  )
}
