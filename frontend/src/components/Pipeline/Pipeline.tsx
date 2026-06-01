import { useEffect, useState, useCallback } from 'react'
import { Card } from '@/components/ui/Card'
import {
  ArrowRight, Box, Sliders, AudioWaveform, GitMerge, Wand2, ShieldCheck,
  X, Trash2, AlertTriangle,
} from 'lucide-react'
import { nebulaAPI, type CamillaConfig, type LimiterStatus } from '@/lib/nebulaAPI'

type NodeType = 'input' | 'mixer' | 'filter' | 'compressor' | 'processor' | 'limiter' | 'output'

interface PipelineNode {
  id:           string
  type:         NodeType
  label:        string
  detail?:      string
  channels?:    number
  /** Index in `config.pipeline` that this visual node corresponds to.
   *  Used to remove the right step on click. `undefined` for synthetic
   *  nodes (capture, playback, sidecar limiter). */
  stepIndex?:   number
  /** Filter names this step references — used to also delete the orphan
   *  filters from config.filters when the user removes the node. */
  filterNames?: string[]
  /** Processor name this step references (mirror of filterNames). */
  processorName?: string
  /** Mixer name this step references. */
  mixerName?: string
}

const NODE_STYLE: Record<NodeType, { icon: typeof Box; color: string; bg: string }> = {
  input:      { icon: Box,           color: '#06b6d4', bg: '#06b6d415' },
  mixer:      { icon: GitMerge,      color: '#a855f7', bg: '#a855f715' },
  filter:     { icon: Sliders,       color: '#6366f1', bg: '#6366f115' },
  compressor: { icon: AudioWaveform, color: '#eab308', bg: '#eab30815' },
  processor:  { icon: Wand2,         color: '#f97316', bg: '#f9731615' },
  limiter:    { icon: ShieldCheck,   color: '#ef4444', bg: '#ef444415' },
  output:     { icon: Box,           color: '#22c55e', bg: '#22c55e15' },
}

// Nodes the user can remove. Capture/Playback/Limiter are structural
// (Limiter is an external sidecar; Capture/Playback come from devices.*)
const REMOVABLE: Set<NodeType> = new Set(['filter', 'compressor', 'processor', 'mixer'])

interface NodeCardProps {
  node:     PipelineNode
  onDelete?: () => void
  busy:     boolean
}

function PipelineNodeCard({ node, onDelete, busy }: NodeCardProps) {
  const style = NODE_STYLE[node.type]
  const Icon = style.icon
  const canDelete = onDelete && REMOVABLE.has(node.type)

  return (
    <div
      className="relative flex flex-col items-center gap-2 p-4 rounded-xl border min-w-[110px] group"
      style={{ borderColor: `${style.color}30`, background: style.bg }}
    >
      {canDelete && (
        <button
          onClick={onDelete}
          disabled={busy}
          title="Remove this step from the pipeline"
          className="absolute top-1 right-1 w-5 h-5 rounded-md bg-[#0a0a14] border border-[#ef444450] text-[#ef4444] hover:bg-[#ef444425] disabled:opacity-30 disabled:cursor-not-allowed transition-all flex items-center justify-center opacity-0 group-hover:opacity-100"
        >
          <X size={11} strokeWidth={3} />
        </button>
      )}
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center"
        style={{ background: `${style.color}20` }}
      >
        <Icon size={18} style={{ color: style.color }} strokeWidth={1.5} />
      </div>
      <div className="text-center">
        <div className="text-xs font-semibold text-[#e8e8ff]">{node.label}</div>
        {node.detail && (
          <div className="text-[10px] text-[#505070] mt-0.5 font-mono break-all max-w-[200px]">
            {node.detail.length > 60 ? node.detail.slice(0, 57) + '…' : node.detail}
          </div>
        )}
        {node.channels && (
          <div className="text-[10px] text-[#505070]">{node.channels}ch</div>
        )}
      </div>
    </div>
  )
}

// Map a CamillaDSP pipeline step → visual node + metadata to enable deletion.
function classifyStep(
  step: Record<string, unknown>,
  config: CamillaConfig,
  stepIndex: number,
): PipelineNode | null {
  const type = String(step.type ?? '').toLowerCase()
  if (type === 'mixer') {
    const name = String(step.name ?? 'Mixer')
    return {
      id: `mixer-${stepIndex}-${name}`,
      type: 'mixer',
      label: name,
      detail: 'Mixer',
      stepIndex,
      mixerName: name,
    }
  }
  if (type === 'filter') {
    const names = (step.names as string[] | undefined) ?? []
    const filters = (config.filters as Record<string, Record<string, unknown>> | undefined) ?? {}
    const hasComp = names.some(n => {
      const ft = String(filters[n]?.type ?? '').toLowerCase()
      return ft === 'compressor' || ft === 'limiter'
    })
    if (hasComp) {
      return {
        id: `comp-${stepIndex}-${names.join('+')}`,
        type: 'compressor',
        label: 'Dynamics',
        detail: names.join(' · ') || undefined,
        stepIndex,
        filterNames: names,
      }
    }
    return {
      id: `fil-${stepIndex}-${names.join('+')}`,
      type: 'filter',
      label: names.length === 1 ? names[0] : `Filters (${names.length})`,
      detail: names.length > 1 ? names.join(' · ') : undefined,
      stepIndex,
      filterNames: names,
    }
  }
  if (type === 'processor') {
    const name = String(step.name ?? 'Processor')
    return {
      id: `proc-${stepIndex}-${name}`,
      type: 'processor',
      label: name,
      detail: 'Processor',
      stepIndex,
      processorName: name,
    }
  }
  return null
}

function buildPipeline(config: CamillaConfig): PipelineNode[] {
  const devices = (config.devices as Record<string, unknown> | undefined) ?? {}
  const capture = (devices.capture as Record<string, unknown> | undefined) ?? {}
  const playback = (devices.playback as Record<string, unknown> | undefined) ?? {}

  const captureChannels = Number(capture.channels ?? 0) || undefined
  const playbackChannels = Number(playback.channels ?? 0) || undefined
  const captureDevice = String(capture.device ?? capture.type ?? 'Capture')
  const playbackDevice = String(playback.device ?? playback.type ?? 'Playback')

  const nodes: PipelineNode[] = [
    { id: 'in', type: 'input', label: 'Capture', detail: captureDevice, channels: captureChannels },
  ]

  const pipeline = (config.pipeline as Record<string, unknown>[] | undefined) ?? []
  for (let i = 0; i < pipeline.length; i++) {
    const node = classifyStep(pipeline[i], config, i)
    if (node) nodes.push(node)
  }

  nodes.push({ id: 'out', type: 'output', label: 'Playback', detail: playbackDevice, channels: playbackChannels })
  return nodes
}

// Remove one pipeline step (by index) and clean up the orphan filters/
// processors/mixers it referenced. Returns a new config object — the
// caller passes it to setConfig.
function removeStep(config: CamillaConfig, node: PipelineNode): CamillaConfig {
  const next: CamillaConfig = JSON.parse(JSON.stringify(config))
  const pipe = ((next.pipeline as Record<string, unknown>[] | undefined) ?? []).slice()
  if (typeof node.stepIndex === 'number' && node.stepIndex < pipe.length) {
    pipe.splice(node.stepIndex, 1)
  }
  next.pipeline = pipe

  // Clean up orphans — if no remaining step references these names,
  // delete them from filters/processors/mixers maps.
  const stillReferenced = new Set<string>()
  for (const step of pipe) {
    const names = (step.names as string[] | undefined) ?? []
    for (const n of names) stillReferenced.add(n)
    if (typeof step.name === 'string') stillReferenced.add(step.name)
  }

  if (node.filterNames) {
    const filters = { ...((next.filters as Record<string, unknown>) ?? {}) }
    for (const n of node.filterNames) {
      if (!stillReferenced.has(n)) delete filters[n]
    }
    next.filters = filters
  }
  if (node.processorName) {
    const processors = { ...((next.processors as Record<string, unknown>) ?? {}) }
    if (!stillReferenced.has(node.processorName)) delete processors[node.processorName]
    next.processors = processors
  }
  if (node.mixerName) {
    const mixers = { ...((next.mixers as Record<string, unknown>) ?? {}) }
    if (!stillReferenced.has(node.mixerName)) delete mixers[node.mixerName]
    next.mixers = mixers
  }
  return next
}

// Wipe ALL processing steps (keeps devices + sidecar limiter untouched).
function clearAllSteps(config: CamillaConfig): CamillaConfig {
  const next: CamillaConfig = JSON.parse(JSON.stringify(config))
  next.pipeline   = []
  next.filters    = {}
  next.processors = {}
  next.mixers     = {}
  return next
}

export function Pipeline() {
  const [config, setConfig] = useState<CamillaConfig | null>(null)
  const [limiter, setLimiter] = useState<LimiterStatus | null>(null)
  const [error, setError]   = useState<string | null>(null)
  const [busy, setBusy]     = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  const load = useCallback(() => {
    Promise.all([
      nebulaAPI.getConfig().catch(e => { setError(String(e)); return null }),
      nebulaAPI.limiterStatus().catch(() => null),
    ]).then(([c, l]) => {
      if (c) { setConfig(c as CamillaConfig); setError(null) }
      setLimiter(l)
    })
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 3000)
    return () => clearInterval(id)
  }, [load])

  const handleDeleteNode = async (node: PipelineNode) => {
    if (!config || busy) return
    setBusy(true); setError(null)
    try {
      const next = removeStep(config, node)
      await nebulaAPI.setConfig(next)
      setConfig(next)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const handleClearAll = async () => {
    if (!config || busy) return
    setBusy(true); setError(null)
    try {
      const next = clearAllSteps(config)
      await nebulaAPI.setConfig(next)
      setConfig(next)
      setConfirmClear(false)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const handleStopLimiter = async () => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const r = await nebulaAPI.limiterStop()
      if (!r.ok) throw new Error(r.error || 'systemctl stop failed')
      // Optimistically clear local state — next poll (≤3 s) confirms.
      setLimiter(prev => prev ? { ...prev, online: false } : prev)
    } catch (e) {
      setError(`Limiter stop: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const baseNodes = config ? buildPipeline(config) : []
  const nodes = limiter?.online
    ? [
        ...baseNodes.slice(0, -1),
        {
          id: 'nebula-limiter',
          type: 'limiter' as NodeType,
          label: 'Limiter',
          detail: `${(limiter.ceiling_db ?? -1).toFixed(1)} dBFS · ${limiter.lookahead_ms?.toFixed(0) ?? 3} ms LA`,
        },
        ...baseNodes.slice(-1),
      ]
    : baseNodes

  const removableCount = baseNodes.filter(n => REMOVABLE.has(n.type)).length
  const channelLabels = nodes[0]?.channels
    ? Array.from({ length: nodes[0].channels }, (_, i) => `Ch ${i + 1}`)
    : []

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Pipeline</h1>
        {removableCount > 0 && (
          <span className="text-[10px] uppercase tracking-widest text-[#505070]">
            {removableCount} processing step{removableCount > 1 ? 's' : ''}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={load}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg border border-[#252540] text-xs text-[#9090bb] hover:border-[#505070] disabled:opacity-50 transition-all"
            title="Reload from engine"
          >
            Refresh
          </button>
          <button
            onClick={() => setConfirmClear(true)}
            disabled={busy || removableCount === 0}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#ef444450] text-xs text-[#ef4444] hover:bg-[#ef444415] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            title="Remove every processing step from the pipeline"
          >
            <Trash2 size={12} />
            Clear pipeline
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-[#ef444450] bg-[#ef444410] text-[#ef4444] text-xs">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {confirmClear && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-[#ef444450] bg-[#ef444410]">
          <AlertTriangle size={16} className="text-[#ef4444] flex-shrink-0" />
          <span className="text-sm text-[#e8e8ff] flex-1">
            Borrar TODOS los pasos del pipeline ({removableCount}) — filtros, processors, mixers — y dejar la cadena en passthrough?
          </span>
          <button
            onClick={() => setConfirmClear(false)}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-xs text-[#9090bb] border border-[#252540] hover:border-[#505070] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleClearAll}
            disabled={busy}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold bg-[#ef4444] text-white hover:bg-[#dc2626] transition-colors"
          >
            <Trash2 size={12} />
            {busy ? 'Clearing…' : 'Yes, clear all'}
          </button>
        </div>
      )}

      <Card title="Signal Chain" accent="#a855f7">
        {!config && !error && (
          <div className="text-xs text-[#505070]">Cargando…</div>
        )}
        {config && nodes.length === 2 && (
          <div className="text-xs text-[#505070] mb-3">
            No hay procesamiento configurado — capture pasa directo al playback.
          </div>
        )}
        {nodes.length > 0 && (
          <div className="overflow-x-auto pb-2">
            <div className="flex items-center gap-2 min-w-max py-2">
              {nodes.map((node, i) => (
                <div key={node.id} className="flex items-center gap-2">
                  <PipelineNodeCard
                    node={node}
                    busy={busy}
                    onDelete={
                      node.type === 'limiter'
                        ? handleStopLimiter
                        : REMOVABLE.has(node.type)
                          ? () => handleDeleteNode(node)
                          : undefined
                    }
                  />
                  {i < nodes.length - 1 && (
                    <ArrowRight size={16} className="text-[#505070] flex-shrink-0" />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {channelLabels.length > 0 && (
          <div className="mt-4 border-t border-[#252540] pt-4 flex flex-wrap gap-2">
            {channelLabels.map(ch => (
              <div
                key={ch}
                className="flex items-center gap-1.5 text-[11px] text-[#505070] bg-[#12121f] border border-[#252540] rounded px-2 py-1"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-[#6366f1]" />
                {ch}
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="rounded-xl border border-dashed border-[#252540] p-4 text-[11px] text-[#505070] leading-relaxed">
        Pasá el mouse por cualquier nodo eliminable para ver el botón <kbd className="px-1 py-0.5 bg-[#0a0a14] border border-[#ef444450] text-[#ef4444] rounded">×</kbd>.
        El × en <span className="text-[#ef4444]">Limiter</span> detiene el sidecar (<code className="text-[#a855f7]">systemctl stop nebula-limiter</code>);
        el × en filtros/processors/mixers borra ese paso del YAML del engine y limpia los huérfanos asociados.
        Capture y Playback no se borran desde acá — para cambiarlos usá el tab Devices.
      </div>
    </div>
  )
}
