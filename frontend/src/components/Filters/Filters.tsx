import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Plus, ChevronDown, ChevronRight } from 'lucide-react'

interface Filter {
  id: string
  type: string
  channel: number
  enabled: boolean
  params: Record<string, number | string>
}

const FILTER_TYPES = [
  'Peaking', 'Highshelf', 'Lowshelf', 'Highpass', 'Lowpass',
  'Notch', 'Allpass', 'Gain', 'Delay', 'Loudness',
]

const FILTER_COLORS: Record<string, string> = {
  Peaking: '#6366f1', Highshelf: '#a855f7', Lowshelf: '#06b6d4',
  Highpass: '#22c55e', Lowpass: '#eab308', Notch: '#f97316',
  Allpass: '#ef4444', Gain: '#9090bb', Delay: '#505070', Loudness: '#818cf8',
}

const DEMO_FILTERS: Filter[] = [
  { id: '1', type: 'Highpass',  channel: 0, enabled: true,  params: { freq: 80,    q: 0.707 } },
  { id: '2', type: 'Peaking',   channel: 0, enabled: true,  params: { freq: 1000,  q: 1.5, gain: -3 } },
  { id: '3', type: 'Highshelf', channel: 0, enabled: false, params: { freq: 10000, gain: 2 } },
  { id: '4', type: 'Lowpass',   channel: 1, enabled: true,  params: { freq: 18000, q: 0.707 } },
]

function FilterRow({ filter }: { filter: Filter }) {
  const [expanded, setExpanded] = useState(false)
  const color = FILTER_COLORS[filter.type] ?? '#505070'

  return (
    <div className={`rounded-lg border transition-all ${
      filter.enabled ? 'border-[#252540] bg-[#12121f]' : 'border-[#1a1a2e] bg-[#0f0f1a] opacity-50'
    }`}>
      <div
        className="flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none"
        onClick={() => setExpanded(e => !e)}
      >
        {/* Color dot */}
        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />

        {/* Type badge */}
        <span
          className="text-[10px] font-semibold px-2 py-0.5 rounded-md"
          style={{ background: `${color}18`, color }}
        >
          {filter.type}
        </span>

        {/* Params summary */}
        <span className="text-xs text-[#505070] font-mono flex-1">
          {Object.entries(filter.params).map(([k, v]) =>
            `${k}: ${typeof v === 'number' ? v.toFixed(0) : v}`
          ).join('  ·  ')}
        </span>

        {/* Channel */}
        <span className="text-[10px] text-[#505070] bg-[#12121f] border border-[#252540] rounded px-1.5 py-0.5">
          Ch {filter.channel + 1}
        </span>

        {expanded ? <ChevronDown size={14} className="text-[#505070]" /> : <ChevronRight size={14} className="text-[#505070]" />}
      </div>

      {expanded && (
        <div className="px-4 pb-3 border-t border-[#1a1a2e] pt-3 flex flex-wrap gap-4">
          {Object.entries(filter.params).map(([key, value]) => (
            <div key={key} className="flex flex-col gap-1">
              <span className="text-[10px] text-[#505070] uppercase">{key}</span>
              <input
                type="number"
                defaultValue={value as number}
                className="w-24 bg-[#0a0a14] border border-[#252540] rounded px-2 py-1 text-sm font-mono text-[#e8e8ff] focus:border-[#6366f1]"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function Filters() {
  const [filters] = useState<Filter[]>(DEMO_FILTERS)
  const [addType, setAddType] = useState('Peaking')

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Filters</h1>
        <div className="flex items-center gap-2">
          <select
            value={addType}
            onChange={e => setAddType(e.target.value)}
            className="bg-[#12121f] border border-[#252540] rounded-lg px-3 py-1.5 text-sm text-[#9090bb] focus:border-[#6366f1]"
          >
            {FILTER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#6366f1] text-white text-xs font-semibold hover:bg-[#818cf8] transition-colors">
            <Plus size={14} />
            Add Filter
          </button>
        </div>
      </div>

      <Card title="Filter Chain" accent="#6366f1">
        <div className="flex flex-col gap-2">
          {filters.map(f => <FilterRow key={f.id} filter={f} />)}
          {filters.length === 0 && (
            <div className="text-center py-8 text-[#505070] text-sm">
              No filters configured. Add your first filter above.
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {FILTER_TYPES.map(type => (
          <div
            key={type}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[#1a1a2e] bg-[#0f0f1a] cursor-pointer hover:border-[#252540] transition-colors"
          >
            <div
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: FILTER_COLORS[type] ?? '#505070' }}
            />
            <span className="text-xs text-[#505070]">{type}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
