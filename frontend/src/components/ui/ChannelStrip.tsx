import { useEffect, useRef, useState } from 'react'
import { PeakMeter } from './PeakMeter'
import { type KSystem, formatDb } from '@/lib/nebulaAPI'

/**
 * Professional channel strip: label · meter L/R · fader · numeric · pan · S/M.
 *
 * Designed to be one of N siblings inside the Volume tab.  Receives raw
 * dBFS peak/rms per channel from the parent (so all strips share one
 * useEngineStatus poll, not N independent ones).
 */

interface ChannelStripProps {
  index:        number     // 0 = Main, 1..4 = Aux N
  label:        string
  color:        string
  enabled:      boolean    // false → strip greyed out
  enabledHint?: string     // shown under the strip when disabled
  volumeDb:     number
  mute:         boolean
  solo:         boolean
  peakL:        number;   peakR: number
  rmsL:         number;   rmsR:  number
  kSystem:      KSystem
  onVolumeChange: (db: number) => void
  onMuteToggle:   () => void
  onSoloToggle:   () => void
}

const MIN_DB = -80
const MAX_DB = 10

// Slider 0..1000 ↔ dB so the input range gives 0.1 dB resolution.
function dbToSlider(db: number): number {
  return Math.round(((Math.max(MIN_DB, Math.min(MAX_DB, db)) - MIN_DB) / (MAX_DB - MIN_DB)) * 1000)
}
function sliderToDb(val: number): number {
  return parseFloat(((val / 1000) * (MAX_DB - MIN_DB) + MIN_DB).toFixed(1))
}

export function ChannelStrip({
  index, label, color, enabled, enabledHint,
  volumeDb, mute, solo,
  peakL, peakR, rmsL, rmsR,
  kSystem,
  onVolumeChange, onMuteToggle, onSoloToggle,
}: ChannelStripProps) {
  const [editing, setEditing] = useState(false)
  const [draftDb, setDraftDb] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const sliderVal = dbToSlider(volumeDb)
  const dim       = !enabled

  // ── Touches pro ─────────────────────────────────────────────────────
  const handleWheel = (e: React.WheelEvent<HTMLInputElement>) => {
    if (!enabled) return
    e.preventDefault()
    const step = e.ctrlKey ? 0.01 : e.shiftKey ? 0.5 : 0.1
    const dir  = e.deltaY < 0 ? 1 : -1
    const next = parseFloat((volumeDb + step * dir).toFixed(2))
    onVolumeChange(Math.max(MIN_DB, Math.min(MAX_DB, next)))
  }

  const handleDoubleClick = () => {
    if (enabled) onVolumeChange(0)
  }

  const handleMouseUp = () => {
    // Snap to 0 dB if within ±0.3 dB
    if (enabled && Math.abs(volumeDb) < 0.3 && volumeDb !== 0) {
      onVolumeChange(0)
    }
  }

  const commitDraft = () => {
    const v = parseFloat(draftDb)
    if (!isNaN(v)) onVolumeChange(Math.max(MIN_DB, Math.min(MAX_DB, v)))
    setEditing(false)
  }

  // ── Layout ──────────────────────────────────────────────────────────
  return (
    <div
      className="flex flex-col items-center bg-[#0f0f1a] border border-[#252540] rounded-lg overflow-hidden"
      style={{
        width: 110,
        opacity: dim ? 0.45 : 1,
        cursor: dim ? 'not-allowed' : 'auto',
      }}
    >
      {/* Color tag */}
      <div className="w-full h-1" style={{ background: color }} />

      {/* Label */}
      <div className="w-full px-2 pt-2 pb-1 text-center">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-[#e8e8ff]">
          {label}
        </div>
        <div className="text-[9px] text-[#505070]">{index === 0 ? 'Main bus' : `Aux ${index}`}</div>
      </div>

      {/* Meters L/R with scale */}
      <div className="flex items-end gap-1 pt-1 pb-2 px-1">
        <PeakMeter
          peak={peakL} rms={rmsL}
          channelLabel="L"
          height={180} width={14}
          kSystem={kSystem}
          showScale
        />
        <PeakMeter
          peak={peakR} rms={rmsR}
          channelLabel="R"
          height={180} width={14}
          kSystem={kSystem}
        />
      </div>

      {/* Fader */}
      <div className="relative flex items-center justify-center" style={{ height: 140, width: 70 }}>
        {/* Fader rail */}
        <div
          className="relative rounded-full overflow-hidden"
          style={{
            width: 6,
            height: 140,
            background: `linear-gradient(to top, ${color} ${(sliderVal / 1000) * 100}%, #12121f ${(sliderVal / 1000) * 100}%)`,
          }}
        >
          <input
            type="range"
            min={0} max={1000} step={1}
            value={sliderVal}
            disabled={dim}
            onChange={e => onVolumeChange(sliderToDb(Number(e.target.value)))}
            onWheel={handleWheel}
            onDoubleClick={handleDoubleClick}
            onMouseUp={handleMouseUp}
            className="absolute opacity-0 cursor-pointer disabled:cursor-not-allowed"
            style={{
              writingMode: 'vertical-lr' as React.CSSProperties['writingMode'],
              direction: 'rtl',
              width: 28, height: 140, left: -11, top: 0,
            }}
            title={`${formatDb(volumeDb, 1)} — scroll wheel to fine-tune, double-click to reset`}
          />
        </div>

        {/* 0 dB tick on the rail */}
        <div
          className="absolute left-0 right-0 h-px opacity-50 pointer-events-none"
          style={{
            bottom: `${(dbToSlider(0) / 1000) * 100}%`,
            background: '#e8e8ff',
            width: 22, left: -8,
          }}
        />
      </div>

      {/* dB numeric (editable on click) */}
      <div className="h-7 w-full text-center">
        {editing ? (
          <input
            ref={inputRef}
            value={draftDb}
            onChange={e => setDraftDb(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={e => {
              if (e.key === 'Enter') commitDraft()
              else if (e.key === 'Escape') setEditing(false)
            }}
            className="w-20 bg-[#0a0a14] border border-[#6366f1] rounded px-1 py-0.5 text-xs font-mono text-center text-[#e8e8ff]"
          />
        ) : (
          <button
            disabled={dim}
            onClick={() => {
              setDraftDb(volumeDb.toFixed(1))
              setEditing(true)
            }}
            className="w-full text-sm font-mono font-bold tabular-nums hover:text-[#e8e8ff] transition-colors"
            style={{ color: mute ? '#505070' : color }}
            title="Click to edit"
          >
            {formatDb(volumeDb, 1)}
          </button>
        )}
      </div>

      {/* Pan placeholder (visual only in v1; see plan) */}
      <div className="w-full px-3 py-1.5 border-t border-[#1a1a2e]">
        <div className="text-[8px] uppercase tracking-widest text-[#505070] text-center mb-1">Pan</div>
        <div className="relative h-1.5 bg-[#0a0a14] rounded-full">
          <div className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 w-2 h-2 bg-[#9090bb] rounded-full" />
          <div className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 w-px h-2 bg-[#252540]" />
        </div>
        <div className="text-[8px] text-center text-[#303050] mt-1">— v2 —</div>
      </div>

      {/* S / M buttons */}
      <div className="w-full flex gap-1 px-2 py-2 border-t border-[#1a1a2e]">
        <button
          onClick={onSoloToggle}
          disabled={dim}
          className={`flex-1 py-1 rounded text-[10px] font-bold border transition-all disabled:opacity-50 ${
            solo
              ? 'bg-[#eab30820] text-[#eab308] border-[#eab30850]'
              : 'bg-[#0f0f1a] text-[#505070] border-[#252540] hover:border-[#eab30850]'
          }`}
          title="Solo (visual only in v1)"
        >
          S
        </button>
        <button
          onClick={onMuteToggle}
          disabled={dim}
          className={`flex-1 py-1 rounded text-[10px] font-bold border transition-all disabled:opacity-50 ${
            mute
              ? 'bg-[#ef444420] text-[#ef4444] border-[#ef444450]'
              : 'bg-[#0f0f1a] text-[#505070] border-[#252540] hover:border-[#ef444450]'
          }`}
          title="Mute"
        >
          M
        </button>
      </div>

      {/* Disabled hint */}
      {dim && enabledHint && (
        <div className="w-full px-2 py-1 text-[8px] text-[#505070] text-center border-t border-[#1a1a2e]">
          {enabledHint}
        </div>
      )}
    </div>
  )
}
