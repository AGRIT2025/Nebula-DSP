import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { nebulaAPI, type CamillaConfig } from '@/lib/nebulaAPI'

interface ConfiguredFilter {
  name:   string
  type:   string
  subtype?: string
  params: Record<string, unknown>
}

const FILTER_COLORS: Record<string, string> = {
  Biquad:        '#6366f1',
  BiquadCombo:   '#818cf8',
  Conv:          '#a855f7',
  Compressor:    '#eab308',
  Limiter:       '#f97316',
  Gain:          '#9090bb',
  Volume:        '#06b6d4',
  Loudness:      '#22c55e',
  Delay:         '#505070',
  DiffEq:        '#ef4444',
}

// Filtros y sub-tipos de biquad soportados por CamillaDSP 4.x. Para
// referencia: https://henquist.github.io/camilladsp.html#filters
const SUPPORTED_FILTER_TYPES = [
  'Biquad', 'BiquadCombo', 'Conv', 'Compressor', 'Limiter',
  'Gain', 'Volume', 'Loudness', 'Delay', 'DiffEq',
]

const BIQUAD_SUBTYPES = [
  'Peaking', 'Highshelf', 'Lowshelf', 'Highpass', 'Lowpass',
  'Notch', 'Allpass', 'Bandpass', 'LinkwitzTransform',
]

function paramSummary(params: Record<string, unknown>): string {
  const keys = ['freq', 'frequency', 'q', 'gain', 'slope', 'threshold', 'ratio', 'attack', 'release']
  const pieces: string[] = []
  for (const k of keys) {
    if (params[k] !== undefined) {
      const v = params[k]
      pieces.push(`${k}: ${typeof v === 'number' ? Number(v).toFixed(1) : String(v)}`)
    }
  }
  return pieces.join('  ·  ')
}

function FilterRow({ filter }: { filter: ConfiguredFilter }) {
  const [expanded, setExpanded] = useState(false)
  const color = FILTER_COLORS[filter.type] ?? '#505070'
  const subtype = filter.subtype ?? (filter.params.type as string | undefined)

  return (
    <div className="rounded-lg border border-[#252540] bg-[#12121f]">
      <div
        className="flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
        <span
          className="text-[10px] font-semibold px-2 py-0.5 rounded-md"
          style={{ background: `${color}18`, color }}
        >
          {filter.type}{subtype ? ` · ${subtype}` : ''}
        </span>
        <span className="text-xs text-[#e8e8ff] font-mono">{filter.name}</span>
        <span className="text-xs text-[#505070] font-mono flex-1 truncate">
          {paramSummary(filter.params)}
        </span>
        {expanded ? <ChevronDown size={14} className="text-[#505070]" /> : <ChevronRight size={14} className="text-[#505070]" />}
      </div>
      {expanded && (
        <div className="px-4 pb-3 border-t border-[#1a1a2e] pt-3">
          <pre className="text-[11px] text-[#9090bb] font-mono leading-relaxed overflow-x-auto">
{JSON.stringify(filter.params, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

function extractFilters(config: CamillaConfig | null): ConfiguredFilter[] {
  if (!config) return []
  const raw = (config.filters as Record<string, Record<string, unknown>> | undefined) ?? {}
  return Object.entries(raw).map(([name, def]) => {
    const type = String(def.type ?? 'Unknown')
    const params = (def.parameters as Record<string, unknown> | undefined) ?? {}
    return { name, type, subtype: params.type as string | undefined, params }
  })
}

export function Filters() {
  const [config, setConfig] = useState<CamillaConfig | null>(null)
  const [error, setError]   = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const reload = async () => {
    setLoading(true)
    try {
      const c = await nebulaAPI.getConfig()
      setConfig(c)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [])

  const filters = extractFilters(config)

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Filters</h1>
        <button
          onClick={reload}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#252540] text-xs text-[#9090bb] hover:border-[#6366f1] hover:text-[#818cf8] transition-all"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <Card title={`Filter Chain (${filters.length})`} accent="#6366f1">
        {error && <div className="text-xs text-[#ef4444] mb-3">Engine no disponible: {error}</div>}
        {!config && !error && <div className="text-xs text-[#505070]">Cargando…</div>}
        {config && filters.length === 0 && (
          <div className="text-center py-8 text-[#505070] text-sm">
            No hay filtros en el config activo.
            <div className="text-[11px] mt-1 text-[#303050]">
              Editor visual de filtros disponible en la próxima versión.
            </div>
          </div>
        )}
        <div className="flex flex-col gap-2">
          {filters.map(f => <FilterRow key={f.name} filter={f} />)}
        </div>
      </Card>

      <Card title="Tipos de filtro soportados por el engine" accent="#9090bb">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {SUPPORTED_FILTER_TYPES.map(type => (
            <div
              key={type}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[#1a1a2e] bg-[#0f0f1a]"
            >
              <div
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: FILTER_COLORS[type] ?? '#505070' }}
              />
              <span className="text-xs text-[#9090bb]">{type}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 text-[10px] text-[#505070] leading-relaxed">
          Sub-tipos Biquad: {BIQUAD_SUBTYPES.join(', ')}.
        </div>
      </Card>
    </div>
  )
}
