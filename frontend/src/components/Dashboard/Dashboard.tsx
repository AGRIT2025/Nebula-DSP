import { useEngineStatus } from '@/hooks/useEngineStatus'
import { nebulaAPI, formatDb } from '@/lib/nebulaAPI'
import { Card, StatCard, Badge } from '@/components/ui/Card'
import { ChannelMeters } from '@/components/ui/VuMeter'
import { UsbDeviceStatus } from '@/components/ui/UsbDeviceStatus'

const STATE_CONFIG = {
  RUNNING:  { label: 'Running',  color: 'green'  as const },
  PAUSED:   { label: 'Paused',   color: 'yellow' as const },
  STARTING: { label: 'Starting', color: 'blue'   as const },
  INACTIVE: { label: 'Inactive', color: 'gray'   as const },
  STALLED:  { label: 'Stalled',  color: 'red'    as const },
}

function latencyLabel(ms: number): { color: 'green' | 'yellow' | 'red'; label: string } {
  if (ms <= 0)   return { color: 'gray' as any, label: '—' }
  if (ms < 20)   return { color: 'green',  label: 'Excellent' }
  if (ms < 50)   return { color: 'green',  label: 'Good' }
  if (ms < 100)  return { color: 'yellow', label: 'Moderate' }
  return           { color: 'red',    label: 'High' }
}

export function Dashboard() {
  const s = useEngineStatus(200)
  const stateCfg = s.state ? STATE_CONFIG[s.state] : null
  const lat = latencyLabel(s.latencyMs)

  return (
    <div className="flex flex-col gap-5">

      {/* ── Header row ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Dashboard</h1>
          {stateCfg
            ? <Badge label={stateCfg.label} color={stateCfg.color} dot pulse={s.state === 'RUNNING'} />
            : <Badge label="Disconnected" color="gray" dot />
          }
        </div>
        {s.connected && s.raw && (
          <span className="text-[11px] text-[#505070] font-mono">
            CamillaDSP {s.raw.cdsp_version} · Backend {s.raw.backend_version}
          </span>
        )}
        {!s.connected && (
          <span className="text-[11px] text-[#ef4444]">Engine unavailable</span>
        )}
        <UsbDeviceStatus />
      </div>

      {/* ── Stats row ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="CPU Load"
          value={s.processingLoad.toFixed(1)}
          unit="%"
          warning={s.processingLoad > 80}
          accent="#6366f1"
        />
        <StatCard
          label="Capture Rate"
          value={s.captureRate > 0 ? (s.captureRate / 1000).toFixed(1) : '—'}
          unit={s.captureRate > 0 ? 'kHz' : ''}
          accent="#06b6d4"
        />
        <StatCard
          label="Buffer"
          value={s.bufferLevel || '—'}
          unit={s.bufferLevel > 0 ? 'smp' : ''}
          accent="#a855f7"
        />
        <StatCard
          label="Clipped"
          value={s.clippedDelta > 0 ? `+${s.clippedDelta}` : (s.clippedSamples || '0')}
          warning={s.clippedDelta > 0}
        />
      </div>

      {/* ── VU meters ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card title="Capture Levels" accent="#06b6d4">
          <ChannelMeters peaks={s.capturePeak} rms={s.captureRms} />
        </Card>
        <Card title="Playback Levels" accent="#22c55e">
          <ChannelMeters peaks={s.playbackPeak} rms={s.playbackRms} />
        </Card>
      </div>

      {/* ── Volume + Latency ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

        {/* Master Volume */}
        <Card title="Master Volume" accent="#6366f1">
          <div className="flex items-center justify-between">
            <span className="text-3xl font-bold font-mono tabular-nums text-[#e8e8ff]">
              {formatDb(s.volume)}
            </span>
            <Badge
              label={s.mute ? 'MUTED' : 'LIVE'}
              color={s.mute ? 'red' : 'green'}
            />
          </div>
          {/* Volume bar */}
          <div className="mt-3 h-1 bg-[#12121f] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-none"
              style={{
                width: `${Math.max(0, Math.min(100, ((s.volume + 80) / 100) * 100))}%`,
                background: s.mute
                  ? '#ef4444'
                  : 'linear-gradient(to right, #6366f1, #a855f7)',
              }}
            />
          </div>
        </Card>

        {/* Latency */}
        <Card title="Latency" accent="#eab308">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold font-mono tabular-nums text-[#e8e8ff]">
              {s.latencyMs > 0 ? s.latencyMs.toFixed(1) : '—'}
            </span>
            {s.latencyMs > 0 && <span className="text-sm text-[#505070]">ms</span>}
            <span className="ml-auto"><Badge label={lat.label} color={lat.color as any} /></span>
          </div>
          <div className="mt-3 h-1 bg-[#12121f] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-none"
              style={{
                width: `${Math.min(100, (s.latencyMs / 200) * 100)}%`,
                background: s.latencyMs < 50 ? '#22c55e' : s.latencyMs < 100 ? '#eab308' : '#ef4444',
              }}
            />
          </div>
          <div className="flex justify-between mt-1.5 text-[10px] text-[#505070] font-mono">
            <span>Buffer: {s.bufferLevel} smp</span>
            <span>0 · 50 · 100 · 200 ms</span>
          </div>
        </Card>
      </div>

      {/* ── Clipping alert ── */}
      {s.clippedDelta > 0 && (
        <button
          onClick={() => nebulaAPI.setVolume(s.volume - 1)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#ef444415] border border-[#ef444430] text-[#ef4444] text-sm hover:bg-[#ef444425] transition-colors self-start"
        >
          <span className="w-2 h-2 rounded-full bg-[#ef4444] animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
          {s.clippedDelta} samples clipped — click to reduce volume by 1 dB
        </button>
      )}

    </div>
  )
}
