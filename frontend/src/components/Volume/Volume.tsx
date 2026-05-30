import { useState, useEffect, useCallback } from 'react'
import { nebulaAPI, formatDb } from '@/lib/nebulaAPI'
import { Card } from '@/components/ui/Card'

const MIN_DB = -80
const MAX_DB = 20

function dbToSlider(db: number) {
  return Math.round(((db - MIN_DB) / (MAX_DB - MIN_DB)) * 1000)
}
function sliderToDb(val: number) {
  return parseFloat(((val / 1000) * (MAX_DB - MIN_DB) + MIN_DB).toFixed(1))
}

interface FaderProps {
  label: string
  volume: number
  mute: boolean
  color: string
  onVolumeChange: (db: number) => void
  onMuteToggle: () => void
}

function Fader({ label, volume, mute, color, onVolumeChange, onMuteToggle }: FaderProps) {
  const sliderVal = dbToSlider(Math.max(MIN_DB, Math.min(MAX_DB, volume)))
  const pct = (sliderVal / 1000) * 100

  return (
    <div className="flex flex-col items-center gap-3 w-20">
      <span className="text-[10px] uppercase tracking-widest text-[#505070] font-semibold">{label}</span>

      {/* Vertical fader track */}
      <div className="relative flex items-center justify-center" style={{ height: 160 }}>
        {/* Track */}
        <div
          className="relative rounded-full overflow-hidden"
          style={{
            width: 6,
            height: 160,
            background: `linear-gradient(to top, ${color} ${pct}%, #12121f ${pct}%)`,
          }}
        >
          <input
            type="range"
            min={0} max={1000}
            value={sliderVal}
            onChange={e => onVolumeChange(sliderToDb(Number(e.target.value)))}
            className="absolute opacity-0 cursor-pointer"
            style={{
              writingMode: 'vertical-lr',
              direction: 'rtl',
              width: 28,
              height: 160,
              left: -11,
              top: 0,
            }}
          />
        </div>

        {/* 0 dB tick */}
        <div
          className="absolute left-0 right-0 h-px opacity-30"
          style={{
            bottom: `${dbToSlider(0) / 10}%`,
            background: '#e8e8ff',
            width: 18,
            left: -6,
          }}
        />
      </div>

      {/* dB value */}
      <span
        className="text-sm font-bold font-mono tabular-nums"
        style={{ color: mute ? '#505070' : color }}
      >
        {formatDb(volume, 1)}
      </span>

      {/* Mute button */}
      <button
        onClick={onMuteToggle}
        className={`w-16 py-1.5 rounded-lg text-[11px] font-bold transition-all border ${
          mute
            ? 'bg-[#ef444420] text-[#ef4444] border-[#ef444450]'
            : 'bg-[#12121f] text-[#505070] border-[#252540] hover:border-[#6366f1] hover:text-[#9090bb]'
        }`}
      >
        {mute ? 'MUTED' : 'MUTE'}
      </button>
    </div>
  )
}

const FADER_COLORS = ['#6366f1', '#a855f7', '#06b6d4', '#22c55e', '#eab308']

export function Volume() {
  const [faders, setFaders] = useState({
    main: { volume: 0, mute: false },
    aux1: { volume: 0, mute: false },
    aux2: { volume: 0, mute: false },
    aux3: { volume: 0, mute: false },
    aux4: { volume: 0, mute: false },
  })
  const [hasFaders, setHasFaders] = useState(false)
  const [manualDb, setManualDb] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [volume, mute] = await Promise.all([nebulaAPI.getVolume(), nebulaAPI.getMute()])
      setFaders(prev => ({ ...prev, main: { volume, mute } }))
      try {
        const [volumes, mutes] = await Promise.all([
          nebulaAPI.getAllFaderVolumes(),
          nebulaAPI.getAllFaderMutes(),
        ])
        const vols = Array.isArray(volumes) ? volumes : []
        const mts  = Array.isArray(mutes) ? mutes : []
        if (vols.length > 1) {
          setFaders({
            main: { volume: Number(vols[0]) || 0, mute: Boolean(mts[0]) },
            aux1: { volume: Number(vols[1]) || 0, mute: Boolean(mts[1]) },
            aux2: { volume: Number(vols[2]) || 0, mute: Boolean(mts[2]) },
            aux3: { volume: Number(vols[3]) || 0, mute: Boolean(mts[3]) },
            aux4: { volume: Number(vols[4]) || 0, mute: Boolean(mts[4]) },
          })
          setHasFaders(true)
        } else {
          setHasFaders(false)
        }
      } catch { setHasFaders(false) }
    } catch { /* no connection */ }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 800)
    return () => clearInterval(id)
  }, [refresh])

  const setVolume = async (idx: number, db: number) => {
    if (idx === 0) await nebulaAPI.setVolume(db)
    else await nebulaAPI.setFaderVolume(idx, db)
    await refresh()
  }

  const toggleMute = async (idx: number) => {
    if (idx === 0) {
      const cur = await nebulaAPI.getMute()
      await nebulaAPI.setMute(!cur)
    } else {
      const raw = await nebulaAPI.getAllFaderMutes()
      const mutes = Array.isArray(raw) ? raw : []
      await nebulaAPI.setFaderMute(idx, !Boolean(mutes[idx]))
    }
    await refresh()
  }

  const faderList = hasFaders
    ? [
        { key: 0, label: 'Main',  ...faders.main },
        { key: 1, label: 'Aux 1', ...faders.aux1 },
        { key: 2, label: 'Aux 2', ...faders.aux2 },
        { key: 3, label: 'Aux 3', ...faders.aux3 },
        { key: 4, label: 'Aux 4', ...faders.aux4 },
      ]
    : [{ key: 0, label: 'Main', ...faders.main }]

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Volume & Faders</h1>

      <Card title="Fader Controls" accent="#6366f1">
        <div className="flex gap-6 justify-center flex-wrap py-2">
          {faderList.map((f, i) => (
            <Fader
              key={f.key}
              label={f.label}
              volume={f.volume}
              mute={f.mute}
              color={FADER_COLORS[i] ?? '#6366f1'}
              onVolumeChange={db => setVolume(f.key, db)}
              onMuteToggle={() => toggleMute(f.key)}
            />
          ))}
        </div>

        <div className="mt-4 flex items-center gap-3 border-t border-[#252540] pt-4">
          <span className="text-xs text-[#505070]">Set master:</span>
          <input
            type="number"
            min={MIN_DB} max={MAX_DB} step={0.5}
            value={manualDb}
            placeholder="0.0"
            onChange={e => setManualDb(e.target.value)}
            onBlur={() => {
              const v = parseFloat(manualDb)
              if (!isNaN(v)) setVolume(0, v)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const v = parseFloat(manualDb)
                if (!isNaN(v)) setVolume(0, v)
              }
            }}
            className="w-24 bg-[#12121f] border border-[#252540] rounded-lg px-3 py-1.5 text-sm font-mono text-[#e8e8ff] focus:border-[#6366f1] transition-colors"
          />
          <span className="text-xs text-[#505070]">dB</span>
        </div>
      </Card>
    </div>
  )
}
