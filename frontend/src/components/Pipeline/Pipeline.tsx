import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { ArrowRight, Box, Sliders, AudioWaveform, GitMerge, Wand2 } from 'lucide-react'
import { nebulaAPI, type CamillaConfig } from '@/lib/nebulaAPI'

type NodeType = 'input' | 'mixer' | 'filter' | 'compressor' | 'processor' | 'output'

interface PipelineNode {
  id: string
  type: NodeType
  label: string
  detail?: string
  channels?: number
}

const NODE_STYLE: Record<NodeType, { icon: typeof Box; color: string; bg: string }> = {
  input:      { icon: Box,           color: '#06b6d4', bg: '#06b6d415' },
  mixer:      { icon: GitMerge,      color: '#a855f7', bg: '#a855f715' },
  filter:     { icon: Sliders,       color: '#6366f1', bg: '#6366f115' },
  compressor: { icon: AudioWaveform, color: '#eab308', bg: '#eab30815' },
  processor:  { icon: Wand2,         color: '#f97316', bg: '#f9731615' },
  output:     { icon: Box,           color: '#22c55e', bg: '#22c55e15' },
}

function PipelineNodeCard({ node }: { node: PipelineNode }) {
  const style = NODE_STYLE[node.type]
  const Icon = style.icon
  return (
    <div
      className="flex flex-col items-center gap-2 p-4 rounded-xl border min-w-[110px]"
      style={{ borderColor: `${style.color}30`, background: style.bg }}
    >
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center"
        style={{ background: `${style.color}20` }}
      >
        <Icon size={18} style={{ color: style.color }} strokeWidth={1.5} />
      </div>
      <div className="text-center">
        <div className="text-xs font-semibold text-[#e8e8ff]">{node.label}</div>
        {node.detail && (
          <div className="text-[10px] text-[#505070] mt-0.5 font-mono">{node.detail}</div>
        )}
        {node.channels && (
          <div className="text-[10px] text-[#505070]">{node.channels}ch</div>
        )}
      </div>
    </div>
  )
}

// CamillaDSP pipeline step → categoría visual + etiqueta legible.
function classifyStep(step: Record<string, unknown>, config: CamillaConfig): PipelineNode | null {
  const type = String(step.type ?? '').toLowerCase()
  if (type === 'mixer') {
    return { id: `mixer-${step.name}`, type: 'mixer', label: String(step.name ?? 'Mixer'), detail: 'Mixer' }
  }
  if (type === 'filter') {
    const names = (step.names as string[] | undefined) ?? []
    const filters = (config.filters as Record<string, Record<string, unknown>> | undefined) ?? {}
    // Si hay un compresor/limiter en la cadena, lo separamos visualmente
    const hasComp = names.some(n => {
      const ft = String(filters[n]?.type ?? '').toLowerCase()
      return ft === 'compressor' || ft === 'limiter'
    })
    if (hasComp) {
      return { id: `comp-${names.join('+')}`, type: 'compressor', label: 'Dynamics', detail: names.join(' · ') || undefined }
    }
    return { id: `fil-${names.join('+')}`, type: 'filter', label: names.length === 1 ? names[0] : `Filters (${names.length})`, detail: names.length > 1 ? names.join(' · ') : undefined, channels: typeof step.channel === 'number' ? undefined : undefined }
  }
  if (type === 'processor') {
    return { id: `proc-${step.name}`, type: 'processor', label: String(step.name ?? 'Processor'), detail: 'Processor' }
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
  for (const step of pipeline) {
    const node = classifyStep(step, config)
    if (node) nodes.push(node)
  }

  nodes.push({ id: 'out', type: 'output', label: 'Playback', detail: playbackDevice, channels: playbackChannels })
  return nodes
}

export function Pipeline() {
  const [config, setConfig] = useState<CamillaConfig | null>(null)
  const [error, setError]   = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = () => {
      nebulaAPI.getConfig()
        .then(c => { if (active) { setConfig(c); setError(null) } })
        .catch(e => { if (active) setError(String(e)) })
    }
    load()
    const id = setInterval(load, 3000)
    return () => { active = false; clearInterval(id) }
  }, [])

  const nodes = config ? buildPipeline(config) : []
  const channelLabels = nodes[0]?.channels
    ? Array.from({ length: nodes[0].channels }, (_, i) => `Ch ${i + 1}`)
    : []

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Pipeline</h1>

      <Card title="Signal Chain" accent="#a855f7">
        {error && (
          <div className="text-xs text-[#ef4444] mb-3">Engine no disponible: {error}</div>
        )}
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
                  <PipelineNodeCard node={node} />
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
        El diagrama refleja en tiempo real la pipeline YAML del engine (refresco cada 3s).
        Para edición gráfica completa de la pipeline, mixers y filtros, ver la próxima versión del editor.
      </div>
    </div>
  )
}
