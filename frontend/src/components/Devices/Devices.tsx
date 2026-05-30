import { useState, useEffect } from 'react'
import { nebulaAPI } from '@/lib/nebulaAPI'
import { Card } from '@/components/ui/Card'
import { Mic, Speaker, RefreshCw } from 'lucide-react'

interface DeviceSelectProps {
  label: string
  icon: typeof Mic
  devices: [string, string][]
  selected: string
  onSelect: (id: string) => void
  color: string
}

function DeviceSelect({ label, icon: Icon, devices, selected, onSelect, color }: DeviceSelectProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon size={14} style={{ color }} />
        <span className="text-[11px] uppercase tracking-widest text-[#505070]">{label}</span>
      </div>
      <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto pr-1">
        {devices.length === 0 ? (
          <div className="text-xs text-[#505070] py-3 text-center border border-dashed border-[#252540] rounded-lg">
            No devices found
          </div>
        ) : (
          devices.map(([id, name]) => (
            <button
              key={id}
              onClick={() => onSelect(id)}
              className={`flex flex-col items-start px-3 py-2.5 rounded-lg border text-left transition-all ${
                selected === id
                  ? 'border-[#6366f150] bg-[#6366f110]'
                  : 'border-[#252540] bg-[#12121f] hover:border-[#505070]'
              }`}
            >
              <span className={`text-sm font-medium ${selected === id ? 'text-[#818cf8]' : 'text-[#9090bb]'}`}>
                {name || id}
              </span>
              <span className="text-[10px] font-mono text-[#505070] mt-0.5">{id}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

export function Devices() {
  const [backends, setBackends] = useState<[string[], string[]]>([[], []])
  const [playbackBackend, setPlaybackBackend] = useState('')
  const [captureBackend, setCaptureBackend] = useState('')
  const [playbackDevices, setPlaybackDevices] = useState<[string, string][]>([])
  const [captureDevices, setCaptureDevices] = useState<[string, string][]>([])
  const [selectedPlayback, setSelectedPlayback] = useState('')
  const [selectedCapture, setSelectedCapture] = useState('')
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [pb, cap] = await nebulaAPI.getBackends()
      setBackends([pb, cap])
      if (pb.length > 0 && !playbackBackend) setPlaybackBackend(pb[0])
      if (cap.length > 0 && !captureBackend)  setCaptureBackend(cap[0])
    } catch { /* no connection */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!playbackBackend) return
    nebulaAPI.getPlaybackDevices(playbackBackend)
      .then(setPlaybackDevices)
      .catch(() => setPlaybackDevices([]))
  }, [playbackBackend])

  useEffect(() => {
    if (!captureBackend) return
    nebulaAPI.getCaptureDevices(captureBackend)
      .then(setCaptureDevices)
      .catch(() => setCaptureDevices([]))
  }, [captureBackend])

  const [playbackBacks, captureBacks] = backends

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Audio Devices</h1>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#252540] text-xs text-[#9090bb] hover:border-[#6366f1] hover:text-[#818cf8] transition-all"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Playback */}
        <Card title="Playback Device" accent="#22c55e">
          <div className="flex flex-col gap-4">
            {/* Backend selector */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-widest text-[#505070]">Backend</span>
              <div className="flex gap-2 flex-wrap">
                {playbackBacks.map(b => (
                  <button
                    key={b}
                    onClick={() => setPlaybackBackend(b)}
                    className={`px-3 py-1 rounded-md text-xs font-semibold transition-all border ${
                      playbackBackend === b
                        ? 'bg-[#22c55e20] text-[#22c55e] border-[#22c55e50]'
                        : 'bg-[#12121f] text-[#505070] border-[#252540] hover:border-[#505070]'
                    }`}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>
            <DeviceSelect
              label="Output Device"
              icon={Speaker}
              devices={playbackDevices}
              selected={selectedPlayback}
              onSelect={setSelectedPlayback}
              color="#22c55e"
            />
          </div>
        </Card>

        {/* Capture */}
        <Card title="Capture Device" accent="#06b6d4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-widest text-[#505070]">Backend</span>
              <div className="flex gap-2 flex-wrap">
                {captureBacks.map(b => (
                  <button
                    key={b}
                    onClick={() => setCaptureBackend(b)}
                    className={`px-3 py-1 rounded-md text-xs font-semibold transition-all border ${
                      captureBackend === b
                        ? 'bg-[#06b6d420] text-[#06b6d4] border-[#06b6d450]'
                        : 'bg-[#12121f] text-[#505070] border-[#252540] hover:border-[#505070]'
                    }`}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>
            <DeviceSelect
              label="Input Device"
              icon={Mic}
              devices={captureDevices}
              selected={selectedCapture}
              onSelect={setSelectedCapture}
              color="#06b6d4"
            />
          </div>
        </Card>

      </div>
    </div>
  )
}
