import { useEffect, useRef } from 'react'

interface VuMeterProps {
  peak: number      // dBFS
  rms: number       // dBFS
  label?: string
  vertical?: boolean
}

const MIN_DB = -60
const MAX_DB = 0

// Segmentos del medidor con colores por zona
const SEGMENTS = [
  { from: -60, to: -18, color: '#22c55e' },
  { from: -18, to: -9,  color: '#22c55e' },
  { from:  -9, to: -6,  color: '#eab308' },
  { from:  -6, to: -3,  color: '#f97316' },
  { from:  -3, to:   0, color: '#ef4444' },
]

function dbToPercent(db: number): number {
  if (db <= MIN_DB) return 0
  if (db >= MAX_DB) return 100
  return ((db - MIN_DB) / (MAX_DB - MIN_DB)) * 100
}

export function VuMeter({ peak, rms, label, vertical = true }: VuMeterProps) {
  const peakHoldRef = useRef<number>(-60)
  const peakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (peak > peakHoldRef.current) {
      peakHoldRef.current = peak
      if (peakTimerRef.current) clearTimeout(peakTimerRef.current)
      peakTimerRef.current = setTimeout(() => {
        peakHoldRef.current = peak
      }, 1500)
    }
  }, [peak])

  const rmsPct   = dbToPercent(rms)
  const peakPct  = dbToPercent(peak)
  const holdPct  = dbToPercent(peakHoldRef.current)

  function segmentColor(pct: number): string {
    const db = MIN_DB + (pct / 100) * (MAX_DB - MIN_DB)
    for (let i = SEGMENTS.length - 1; i >= 0; i--) {
      if (db >= SEGMENTS[i].from) return SEGMENTS[i].color
    }
    return '#22c55e'
  }

  if (!vertical) {
    return (
      <div className="flex flex-col gap-1 w-full">
        {label && (
          <span className="text-[10px] text-[#505070] uppercase tracking-widest">{label}</span>
        )}
        <div className="relative h-3 bg-[#0a0a14] rounded-sm overflow-hidden border border-[#1a1a2e]">
          {/* RMS bar */}
          <div
            className="absolute inset-y-0 left-0 rounded-sm transition-none"
            style={{
              width: `${rmsPct}%`,
              background: `linear-gradient(to right, #22c55e 0%, #22c55e 60%, #eab308 75%, #f97316 88%, #ef4444 100%)`,
            }}
          />
          {/* Peak marker */}
          <div
            className="absolute top-0 bottom-0 w-0.5 rounded-full"
            style={{
              left: `${peakPct}%`,
              background: segmentColor(peakPct),
              boxShadow: `0 0 4px ${segmentColor(peakPct)}`,
            }}
          />
          {/* Peak hold */}
          <div
            className="absolute top-0 bottom-0 w-px opacity-60"
            style={{
              left: `${holdPct}%`,
              background: '#ffffff',
            }}
          />
        </div>
      </div>
    )
  }

  // Vertical meter
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="relative rounded-sm overflow-hidden border border-[#1a1a2e]"
        style={{ width: '14px', height: '120px', background: '#0a0a14' }}
      >
        {/* Tick marks */}
        {[-6, -12, -18, -30, -48].map(db => (
          <div
            key={db}
            className="absolute left-0 right-0 h-px opacity-30"
            style={{
              bottom: `${dbToPercent(db)}%`,
              background: '#252540',
            }}
          />
        ))}

        {/* RMS bar (from bottom) */}
        <div
          className="absolute bottom-0 left-0 right-0 transition-none"
          style={{
            height: `${rmsPct}%`,
            background: 'linear-gradient(to top, #22c55e 0%, #22c55e 60%, #eab308 75%, #f97316 88%, #ef4444 100%)',
          }}
        />

        {/* Peak marker */}
        <div
          className="absolute left-0 right-0 h-0.5"
          style={{
            bottom: `${peakPct}%`,
            background: segmentColor(peakPct),
            boxShadow: `0 0 4px ${segmentColor(peakPct)}`,
          }}
        />

        {/* Peak hold */}
        <div
          className="absolute left-0 right-0 h-px opacity-70"
          style={{
            bottom: `${holdPct}%`,
            background: '#ffffff',
          }}
        />

        {/* Clip indicator */}
        {peak >= -0.5 && (
          <div
            className="absolute top-0 left-0 right-0 h-1.5"
            style={{
              background: '#ef4444',
              boxShadow: '0 0 6px #ef4444',
              animation: 'meter-flash 0.3s ease-in-out',
            }}
          />
        )}
      </div>

      {label && (
        <span className="text-[9px] font-mono text-[#505070] uppercase">{label}</span>
      )}
    </div>
  )
}

// Grupo de VuMeters para múltiples canales
interface ChannelMetersProps {
  peaks: number[]
  rms:   number[]
  label?: string
  vertical?: boolean
}

const CHANNEL_LABELS = ['L', 'R', 'C', 'LFE', 'SL', 'SR', 'BL', 'BR']

export function ChannelMeters({ peaks, rms, label, vertical = true }: ChannelMetersProps) {
  if (peaks.length === 0) {
    return (
      <div className="flex items-center justify-center h-20">
        <span className="text-xs text-[#505070]">Sin señal</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {label && (
        <span className="text-[10px] text-[#505070] uppercase tracking-widest">{label}</span>
      )}
      {vertical ? (
        <div className="flex gap-2 items-end justify-center flex-wrap">
          {peaks.map((p, i) => (
            <VuMeter
              key={i}
              peak={p}
              rms={rms[i] ?? p}
              label={peaks.length <= 8 ? (CHANNEL_LABELS[i] ?? `${i + 1}`) : undefined}
              vertical
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {peaks.map((p, i) => (
            <VuMeter
              key={i}
              peak={p}
              rms={rms[i] ?? p}
              label={CHANNEL_LABELS[i] ?? `Ch ${i + 1}`}
              vertical={false}
            />
          ))}
        </div>
      )}
    </div>
  )
}
