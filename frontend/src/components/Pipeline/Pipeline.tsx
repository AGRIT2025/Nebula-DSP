import { Card } from '@/components/ui/Card'
import { ArrowRight, Box, Sliders, AudioWaveform, GitMerge } from 'lucide-react'

interface PipelineNode {
  id: string
  type: 'input' | 'mixer' | 'filter' | 'compressor' | 'output'
  label: string
  channels?: number
}

const DEMO_PIPELINE: PipelineNode[] = [
  { id: 'in',   type: 'input',      label: 'Capture',    channels: 2 },
  { id: 'mix1', type: 'mixer',      label: 'Mixer 1:1',  channels: 2 },
  { id: 'eq1',  type: 'filter',     label: 'EQ Chain',   channels: 2 },
  { id: 'comp', type: 'compressor', label: 'Compressor', channels: 2 },
  { id: 'out',  type: 'output',     label: 'Playback',   channels: 2 },
]

const NODE_STYLE: Record<string, { icon: typeof Box; color: string; bg: string }> = {
  input:      { icon: Box,           color: '#06b6d4', bg: '#06b6d415' },
  mixer:      { icon: GitMerge,      color: '#a855f7', bg: '#a855f715' },
  filter:     { icon: Sliders,       color: '#6366f1', bg: '#6366f115' },
  compressor: { icon: AudioWaveform, color: '#eab308', bg: '#eab30815' },
  output:     { icon: Box,           color: '#22c55e', bg: '#22c55e15' },
}

function PipelineNodeCard({ node }: { node: PipelineNode }) {
  const style = NODE_STYLE[node.type]
  const Icon = style.icon

  return (
    <div
      className="flex flex-col items-center gap-2 p-4 rounded-xl border min-w-[90px]"
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
        {node.channels && (
          <div className="text-[10px] text-[#505070]">{node.channels}ch</div>
        )}
      </div>
    </div>
  )
}

export function Pipeline() {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Pipeline</h1>

      <Card title="Signal Chain" accent="#a855f7">
        {/* Flow diagram — scrollable on mobile */}
        <div className="overflow-x-auto pb-2">
          <div className="flex items-center gap-2 min-w-max py-2">
            {DEMO_PIPELINE.map((node, i) => (
              <div key={node.id} className="flex items-center gap-2">
                <PipelineNodeCard node={node} />
                {i < DEMO_PIPELINE.length - 1 && (
                  <ArrowRight size={16} className="text-[#505070] flex-shrink-0" />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Channel routing hint */}
        <div className="mt-4 border-t border-[#252540] pt-4 flex flex-wrap gap-2">
          {['Ch 1 (L)', 'Ch 2 (R)'].map(ch => (
            <div
              key={ch}
              className="flex items-center gap-1.5 text-[11px] text-[#505070] bg-[#12121f] border border-[#252540] rounded px-2 py-1"
            >
              <div className="w-1.5 h-1.5 rounded-full bg-[#6366f1]" />
              {ch}
            </div>
          ))}
        </div>
      </Card>

      <div className="rounded-xl border border-dashed border-[#252540] p-6 text-center text-sm text-[#505070]">
        Pipeline visual editor — lee la configuración YAML del engine y muestra el flujo de señal en tiempo real.
        <br />
        <span className="text-xs text-[#303050]">Edición completa disponible en la próxima versión.</span>
      </div>
    </div>
  )
}
