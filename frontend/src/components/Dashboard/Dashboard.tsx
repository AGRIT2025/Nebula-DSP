import { useEngineStatus } from '@/hooks/useEngineStatus'
import { nebulaAPI } from '@/lib/nebulaAPI'
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

export function Dashboard() {
  const s = useEngineStatus(200)
  const stateCfg = s.state ? STATE_CONFIG[s.state] : null

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
        {/* Engine version pill removed intentionally — the underlying engine
            brand is an implementation detail and shouldn't be advertised in
            the user-facing UI. Connection state is communicated via the
            sidebar badge and the "Engine unavailable" message below. */}
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

      {/* Master Volume + Latency vivieron acá hasta el rediseño del tab Volume
         (que ahora tiene su propio Master panel con peak/RMS/load/latency/clip
         y un fader bank de 5 strips). Para evitar duplicación, el Dashboard
         queda enfocado en VU + stats agregadas; los controles de volumen
         viven en el tab Volume. */}

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
