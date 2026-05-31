import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Power, Save, RotateCcw, AlertTriangle } from 'lucide-react'
import { Card, Badge } from '@/components/ui/Card'
import { nebulaAPI, type CamillaConfig } from '@/lib/nebulaAPI'
import {
  BIQUAD_SUBTYPES, SUBTYPE_DEFAULTS, SUBTYPE_COLOR, usesGain,
  biquadCoeffs, biquadMagnitudeDb,
  type BiquadSubtype,
} from '@/lib/biquad'

// ── Local state model ───────────────────────────────────────────────────────
//
// Each parametric EQ band the user has set up.  Maps 1:1 to one Biquad
// entry in the CamillaDSP YAML config; the `name` is the YAML key.

interface ParamFilter {
  name:    string         // unique YAML key, e.g. "eq_1"
  subtype: BiquadSubtype
  freq:    number
  q:       number
  gain:    number
  enabled: boolean        // bypass = false
}

// Prefix we use for filter names we own.  Filters whose name starts with
// this string are managed by this tab; others (Conv from Room Correction,
// hand-edited filters, etc.) are preserved untouched on save.
const FILTER_PREFIX = 'eq_'

// Sample rate for response math — read from the active config at load time.
function readSampleRate(c: CamillaConfig | null): number {
  const dev = (c?.devices as Record<string, unknown> | undefined) ?? {}
  return Number(dev.samplerate) || 48000
}

// Read all Biquad filters owned by this tab from the YAML.  Anything that
// isn't `Biquad` with one of our supported sub-types, or doesn't have an
// `eq_*` name, is skipped (and will be preserved on save).
function readFromConfig(c: CamillaConfig | null): ParamFilter[] {
  if (!c) return []
  const filters  = (c.filters  as Record<string, Record<string, unknown>> | undefined) ?? {}
  const pipeline = (c.pipeline as Record<string, unknown>[] | undefined) ?? []
  // Track which names are enabled by being referenced in some Filter step.
  const enabledNames = new Set<string>()
  for (const step of pipeline) {
    if (step.type !== 'Filter') continue
    const names = (step.names as string[] | undefined) ?? []
    if (!(step.bypassed)) for (const n of names) enabledNames.add(n)
  }
  const out: ParamFilter[] = []
  for (const [name, def] of Object.entries(filters)) {
    if (!name.startsWith(FILTER_PREFIX)) continue
    if (def.type !== 'Biquad') continue
    const params = (def.parameters as Record<string, unknown> | undefined) ?? {}
    const sub = String(params.type ?? '') as BiquadSubtype
    if (!BIQUAD_SUBTYPES.includes(sub)) continue
    out.push({
      name,
      subtype: sub,
      freq: Number(params.freq ?? 1000),
      q:    Number(params.q    ?? 1),
      gain: Number(params.gain ?? 0),
      enabled: enabledNames.has(name),
    })
  }
  // Stable order: ascending by name suffix when numeric.
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return out
}

// Re-build the YAML.  Preserves any non-eq_* filter + non-Filter pipeline
// step that the user (or Room Correction) put there.
function writeToConfig(
  base: CamillaConfig,
  bands: ParamFilter[],
  channels: number,
): CamillaConfig {
  const next: CamillaConfig = { ...base }

  // Drop our managed filters; keep the rest.
  const allFilters = (next.filters as Record<string, Record<string, unknown>> | undefined) ?? {}
  const preserved: Record<string, Record<string, unknown>> = {}
  for (const [name, def] of Object.entries(allFilters)) {
    if (!name.startsWith(FILTER_PREFIX)) preserved[name] = def
  }
  for (const b of bands) {
    preserved[b.name] = {
      type: 'Biquad',
      parameters: {
        type: b.subtype,
        freq: b.freq,
        q:    b.q,
        ...(usesGain(b.subtype) ? { gain: b.gain } : {}),
      },
    }
  }
  next.filters = preserved

  // Drop any existing Filter steps that reference our names; keep everything
  // else.  Then re-append a single Filter step listing all enabled bands.
  const pipeline = ((next.pipeline as Record<string, unknown>[] | undefined) ?? []).filter(step => {
    if (step.type !== 'Filter') return true
    const names = (step.names as string[] | undefined) ?? []
    return !names.some(n => n.startsWith(FILTER_PREFIX))
  })
  const enabledNames = bands.filter(b => b.enabled).map(b => b.name)
  if (enabledNames.length > 0) {
    // CamillaDSP Filter step schema (4.x): `channels` is an ARRAY of
    // channel indices to apply the chain to.  For stereo we cover [0, 1].
    const allChannels = Array.from({ length: channels }, (_, i) => i)
    pipeline.push({ type: 'Filter', channels: allChannels, names: enabledNames })
  }
  next.pipeline = pipeline

  return next
}

// ── Response graph ──────────────────────────────────────────────────────────

const F_MIN = 20, F_MAX = 20000
const DB_MIN = -24, DB_MAX = 24
const GRID_F = [20, 30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const LABEL_F = ['20', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '20k']
const GRID_DB = [-24, -18, -12, -6, 0, 6, 12, 18, 24]

function freqToX(f: number, w: number): number {
  return (Math.log10(f / F_MIN) / Math.log10(F_MAX / F_MIN)) * w
}
function dbToY(db: number, h: number): number {
  return h - ((db - DB_MIN) / (DB_MAX - DB_MIN)) * h
}

function ResponseGraph({ bands, fs }: { bands: ParamFilter[]; fs: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current; if (!canvas) return
    const ctx = canvas.getContext('2d'); if (!ctx) return
    const PAD = { top: 12, right: 16, bottom: 28, left: 44 }
    const W = canvas.width, H = canvas.height
    const cw = W - PAD.left - PAD.right
    const ch = H - PAD.top  - PAD.bottom

    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#080810'
    ctx.fillRect(0, 0, W, H)

    const tx = (f: number)  => PAD.left + freqToX(f, cw)
    const ty = (db: number) => PAD.top  + dbToY(db, ch)

    // Grid + axis labels.
    ctx.strokeStyle = '#1a1a2e'; ctx.lineWidth = 1
    for (const f of GRID_F) {
      const x = tx(f)
      ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + ch); ctx.stroke()
    }
    for (const db of GRID_DB) {
      const y = ty(db)
      ctx.strokeStyle = db === 0 ? '#2a2a4a' : '#1a1a2e'
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cw, y); ctx.stroke()
    }
    ctx.fillStyle = '#505070'; ctx.font = '10px monospace'
    ctx.textAlign = 'center'
    for (let i = 0; i < LABEL_F.length; i++) {
      ctx.fillText(LABEL_F[i], tx([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000][i]), PAD.top + ch + 16)
    }
    ctx.textAlign = 'right'
    for (const db of GRID_DB) {
      ctx.fillText(`${db > 0 ? '+' : ''}${db}`, PAD.left - 6, ty(db) + 3)
    }

    // Sample the curves at every pixel column for smooth lines.
    const xs = cw
    const sampleF = (px: number) => F_MIN * Math.pow(F_MAX / F_MIN, px / xs)

    // Per-filter curves (translucent).
    for (const b of bands) {
      if (!b.enabled) continue
      const coeffs = biquadCoeffs(b, fs)
      ctx.strokeStyle = SUBTYPE_COLOR[b.subtype] + '55'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      for (let px = 0; px <= xs; px++) {
        const f = sampleF(px)
        const db = biquadMagnitudeDb(coeffs, f, fs)
        const y = ty(Math.max(DB_MIN, Math.min(DB_MAX, db)))
        if (px === 0) ctx.moveTo(PAD.left + px, y)
        else          ctx.lineTo(PAD.left + px, y)
      }
      ctx.stroke()
    }

    // Combined curve (solid, bright).  Sum of dB per filter at each freq.
    const enabled = bands.filter(b => b.enabled)
    if (enabled.length > 0) {
      const coeffList = enabled.map(b => biquadCoeffs(b, fs))
      ctx.strokeStyle = '#e8e8ff'
      ctx.lineWidth = 2
      ctx.shadowBlur = 6
      ctx.shadowColor = '#818cf8'
      ctx.beginPath()
      for (let px = 0; px <= xs; px++) {
        const f = sampleF(px)
        let dbTotal = 0
        for (const c of coeffList) dbTotal += biquadMagnitudeDb(c, f, fs)
        const y = ty(Math.max(DB_MIN, Math.min(DB_MAX, dbTotal)))
        if (px === 0) ctx.moveTo(PAD.left + px, y)
        else          ctx.lineTo(PAD.left + px, y)
      }
      ctx.stroke()
      ctx.shadowBlur = 0
    }
  }, [bands, fs])

  return (
    <canvas
      ref={ref}
      width={760}
      height={260}
      className="rounded-lg border border-[#252540]"
      style={{ width: '100%', height: 'auto', aspectRatio: '760/260' }}
    />
  )
}

// ── Row UI ──────────────────────────────────────────────────────────────────

interface RowProps {
  filter: ParamFilter
  onChange: (next: ParamFilter) => void
  onDelete: () => void
}

function FilterRow({ filter, onChange, onDelete }: RowProps) {
  const color = SUBTYPE_COLOR[filter.subtype]
  const showGain = usesGain(filter.subtype)

  const setField = <K extends keyof ParamFilter>(k: K, v: ParamFilter[K]) =>
    onChange({ ...filter, [k]: v })

  return (
    <div
      className="rounded-lg border bg-[#12121f] transition-opacity"
      style={{
        borderColor: filter.enabled ? '#252540' : '#1a1a2e',
        opacity: filter.enabled ? 1 : 0.55,
      }}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
        <select
          value={filter.subtype}
          onChange={e => {
            const sub = e.target.value as BiquadSubtype
            // Reset to defaults of the new sub-type so freq/q/gain make sense.
            onChange({ ...filter, subtype: sub, ...SUBTYPE_DEFAULTS[sub] })
          }}
          className="text-[11px] font-semibold rounded-md px-2 py-1 border bg-[#0f0f1a] text-[#e8e8ff]"
          style={{ borderColor: `${color}40`, color }}
        >
          {BIQUAD_SUBTYPES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="text-xs font-mono text-[#505070] flex-1">{filter.name}</span>
        <button
          onClick={() => setField('enabled', !filter.enabled)}
          title={filter.enabled ? 'Bypass' : 'Enable'}
          className={`p-1.5 rounded-md border transition-colors ${
            filter.enabled
              ? 'border-[#22c55e50] text-[#22c55e] hover:bg-[#22c55e15]'
              : 'border-[#252540] text-[#505070] hover:bg-[#ffffff08]'
          }`}
        >
          <Power size={12} />
        </button>
        <button
          onClick={onDelete}
          title="Delete"
          className="p-1.5 rounded-md border border-[#ef444450] text-[#ef4444] hover:bg-[#ef444415] transition-colors"
        >
          <Trash2 size={12} />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 px-4 pb-3 pt-1 border-t border-[#1a1a2e]">
        {/* Frequency: log slider 20 Hz – 20 kHz */}
        <div className="flex flex-col gap-1">
          <div className="flex justify-between">
            <span className="text-[10px] uppercase tracking-widest text-[#505070]">Freq</span>
            <span className="text-[11px] font-mono font-semibold text-[#e8e8ff]">
              {filter.freq < 1000 ? filter.freq.toFixed(0) + ' Hz' : (filter.freq / 1000).toFixed(2) + ' kHz'}
            </span>
          </div>
          <input
            type="range"
            min={Math.log10(20)} max={Math.log10(20000)} step={0.001}
            value={Math.log10(filter.freq)}
            onChange={e => setField('freq', Math.round(Math.pow(10, Number(e.target.value))))}
            className="w-full h-1 rounded-full appearance-none bg-[#12121f] accent-[#818cf8]"
          />
        </div>

        {/* Q */}
        <div className="flex flex-col gap-1">
          <div className="flex justify-between">
            <span className="text-[10px] uppercase tracking-widest text-[#505070]">Q</span>
            <span className="text-[11px] font-mono font-semibold text-[#e8e8ff]">{filter.q.toFixed(3)}</span>
          </div>
          <input
            type="range" min={0.1} max={30} step={0.01}
            value={filter.q}
            onChange={e => setField('q', Number(e.target.value))}
            className="w-full h-1 rounded-full appearance-none bg-[#12121f] accent-[#818cf8]"
          />
        </div>

        {/* Gain (only used by Peaking + shelves) */}
        <div className={`flex flex-col gap-1 ${showGain ? '' : 'opacity-30'}`}>
          <div className="flex justify-between">
            <span className="text-[10px] uppercase tracking-widest text-[#505070]">Gain</span>
            <span className="text-[11px] font-mono font-semibold text-[#e8e8ff]">
              {filter.gain >= 0 ? '+' : ''}{filter.gain.toFixed(1)} dB
            </span>
          </div>
          <input
            type="range" min={-24} max={24} step={0.1}
            disabled={!showGain}
            value={filter.gain}
            onChange={e => setField('gain', Number(e.target.value))}
            className="w-full h-1 rounded-full appearance-none bg-[#12121f] accent-[#818cf8] disabled:opacity-30"
          />
        </div>
      </div>
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

function nextName(existing: ParamFilter[]): string {
  // pick eq_<smallest unused integer ≥ 1>
  const used = new Set(existing.map(f => f.name))
  for (let i = 1; i < 1000; i++) {
    const n = `${FILTER_PREFIX}${i}`
    if (!used.has(n)) return n
  }
  return `${FILTER_PREFIX}${Date.now()}`
}

export function Filters() {
  const [config,    setConfig]    = useState<CamillaConfig | null>(null)
  const [bands,     setBands]     = useState<ParamFilter[]>([])
  const [dirty,     setDirty]     = useState(false)
  const [busy,      setBusy]      = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [addType,   setAddType]   = useState<BiquadSubtype>('Peaking')

  const load = async () => {
    try {
      const c = await nebulaAPI.getConfig()
      setConfig(c)
      setBands(readFromConfig(c))
      setDirty(false); setError(null)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  useEffect(() => { load() }, [])

  const fs = readSampleRate(config)

  const updateBand = (i: number, next: ParamFilter) => {
    setBands(prev => prev.map((b, idx) => idx === i ? next : b))
    setDirty(true)
  }
  const deleteBand = (i: number) => {
    setBands(prev => prev.filter((_, idx) => idx !== i))
    setDirty(true)
  }
  const addBand = () => {
    setBands(prev => [
      ...prev,
      {
        name:    nextName(prev),
        subtype: addType,
        ...SUBTYPE_DEFAULTS[addType],
        enabled: true,
      },
    ])
    setDirty(true)
  }
  const apply = async () => {
    if (!config) return
    setBusy(true); setError(null)
    try {
      const channels = Number(
        ((config.devices as Record<string, Record<string, unknown>>).capture?.channels) ?? 2
      ) || 2
      const next = writeToConfig(config, bands, channels)
      const v = await nebulaAPI.validateConfig(next)
      if (v && v.result && v.result !== 'OK' && v.error) {
        throw new Error(`Validación falló: ${v.error}`)
      }
      await nebulaAPI.setConfig(next)
      setConfig(next); setDirty(false)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Filters — Parametric EQ</h1>
        <Badge label={`${bands.filter(b => b.enabled).length} active`} color="blue" />
        {dirty && <Badge label="Unsaved" color="yellow" />}

        <div className="ml-auto flex items-center gap-2">
          <select
            value={addType}
            onChange={e => setAddType(e.target.value as BiquadSubtype)}
            className="bg-[#12121f] border border-[#252540] rounded-lg px-3 py-1.5 text-xs text-[#9090bb]"
          >
            {BIQUAD_SUBTYPES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <button
            onClick={addBand}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#6366f1] text-xs font-semibold text-white hover:bg-[#818cf8] transition-colors"
          >
            <Plus size={12} />
            Add filter
          </button>
          <button
            onClick={() => load()}
            disabled={busy}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#252540] text-xs text-[#9090bb] hover:border-[#505070] disabled:opacity-50 transition-all"
          >
            <RotateCcw size={12} />
            Reload
          </button>
          <button
            onClick={apply}
            disabled={busy || !dirty}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#22c55e] text-xs font-semibold text-white hover:bg-[#4ade80] disabled:opacity-50 transition-all"
          >
            <Save size={12} />
            Apply
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-[#ef444450] bg-[#ef444410] text-[#ef4444] text-xs">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <Card title="Frequency Response" accent="#818cf8">
        <ResponseGraph bands={bands} fs={fs} />
        <div className="mt-2 flex items-center gap-3 flex-wrap text-[10px] text-[#505070]">
          <span>Curvas finas = filtros individuales · Curva blanca gruesa = respuesta combinada</span>
          <span className="ml-auto font-mono">fs = {fs.toLocaleString()} Hz</span>
        </div>
      </Card>

      <Card title={`Filter Chain (${bands.length})`} accent="#6366f1">
        {bands.length === 0 ? (
          <div className="text-center py-8 text-[#505070] text-sm">
            No hay filtros. Tocá <span className="text-[#818cf8] font-semibold">Add filter</span> para empezar.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {bands.map((b, i) => (
              <FilterRow
                key={b.name}
                filter={b}
                onChange={next => updateBand(i, next)}
                onDelete={() => deleteBand(i)}
              />
            ))}
          </div>
        )}
      </Card>

      <div className="text-[10px] text-[#505070] leading-relaxed">
        Los filtros se llaman <code className="text-[#a855f7]">eq_1</code>, <code className="text-[#a855f7]">eq_2</code>, etc. en el YAML.
        Filtros con otros nombres (Conv de Room Correction, hand-edits) se preservan intactos al hacer Apply.
        Cada filtro se aplica a todos los canales de la pipeline.
      </div>
    </div>
  )
}
