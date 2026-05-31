import { useState, useEffect, useMemo, useCallback } from 'react'
import { nebulaAPI, type CamillaConfig } from '@/lib/nebulaAPI'
import { Card, Badge } from '@/components/ui/Card'
import { useEngineStatus } from '@/hooks/useEngineStatus'
import {
  Mic, Speaker, RefreshCw, Save, Usb, Cpu, Repeat, Layers,
  CircleDot, AlertTriangle, Check,
} from 'lucide-react'

// ── Device classification ──────────────────────────────────────────────────

type DeviceGroup = 'usb' | 'builtin' | 'loopback' | 'system' | 'other'

interface ClassifiedDevice {
  id:    string
  name:  string
  group: DeviceGroup
}

/** Heuristic: classify an ALSA device id+name into a UX group. */
function classify(id: string, name: string): DeviceGroup {
  const haystack = `${id} ${name}`.toLowerCase()
  if (id === 'null' || id === 'pipewire' || id === 'default' || id === 'pulse')
    return 'system'
  if (haystack.includes('loopback')) return 'loopback'
  if (haystack.includes('usb') || haystack.includes('umc') || haystack.includes('focusrite')
      || haystack.includes('plantronics') || haystack.includes('m-audio'))
    return 'usb'
  if (haystack.includes('pch') || haystack.includes('hda intel') || haystack.includes('analog')
      || haystack.includes('hdmi') || haystack.includes('built-in'))
    return 'builtin'
  return 'other'
}

const GROUP_LABEL: Record<DeviceGroup, string> = {
  usb:      '🔌 USB Audio',
  builtin:  '💻 Built-in',
  loopback: '🔁 Loopback',
  system:   '⚙️ System / Virtual',
  other:    '◇ Other',
}

const GROUP_ORDER: DeviceGroup[] = ['usb', 'builtin', 'loopback', 'system', 'other']

/**
 * Filter out the noisy ALSA aliases that the engine reports. For a
 * single USB DAC, /api/playbackdevices/Alsa returns 20+ entries that
 * are all the same hardware via different ALSA plugin paths:
 *   hw:CARD=Seri,DEV=0   plughw:CARD=Seri,DEV=0   sysdefault:CARD=Seri
 *   front:CARD=Seri,DEV=0   dmix:CARD=Seri,DEV=0   surround21:CARD=...
 * The user only cares about the canonical raw `hw:Seri,0,0`. We keep:
 *   - `hw:` entries (raw hardware, one per card)
 *   - the top-level virtual nodes: `null`, `pipewire`, `default`, `pulse`
 * Everything else is discarded as a duplicate alias.
 */
function filterDevices(devices: [string, string][]): ClassifiedDevice[] {
  const VIRTUALS = new Set(['null', 'pipewire', 'default', 'pulse'])
  const keep: ClassifiedDevice[] = []
  const seenCard = new Set<string>()

  for (const [id, name] of devices) {
    if (VIRTUALS.has(id)) {
      keep.push({ id, name: name || id, group: classify(id, name) })
      continue
    }
    if (!id.startsWith('hw:')) continue   // drops plughw, sysdefault, surround*, dmix, hdmi, etc.

    // Dedupe to one entry per card+device. Both `hw:NAME,N` and
    // `hw:CARD=NAME,DEV=N` describe the same hardware.
    const hwMatch = id.match(/^hw:([^,]+),(\d+)/i) || id.match(/^hw:CARD=([^,]+),DEV=(\d+)/i)
    if (hwMatch) {
      const cardKey = `${hwMatch[1]}:${hwMatch[2]}`
      if (seenCard.has(cardKey)) continue
      seenCard.add(cardKey)
    }
    keep.push({ id, name: name || id, group: classify(id, name) })
  }

  return keep
}

// ── Device picker (dropdown with optgroups) ─────────────────────────────────

interface DevicePickerProps {
  label:       string
  icon:        typeof Mic
  color:       string
  devices:     ClassifiedDevice[]
  selected:    string
  activeNow:   string                  // device currently in the engine's config
  onChange:    (id: string) => void
}

function DevicePicker({ label, icon: Icon, color, devices, selected, activeNow, onChange }: DevicePickerProps) {
  // Group devices in render order
  const grouped = useMemo(() => {
    const map = new Map<DeviceGroup, ClassifiedDevice[]>()
    for (const d of devices) {
      const list = map.get(d.group) ?? []
      list.push(d)
      map.set(d.group, list)
    }
    return GROUP_ORDER.flatMap(g => {
      const list = map.get(g)
      return list && list.length > 0 ? [{ group: g, items: list }] : []
    })
  }, [devices])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon size={14} style={{ color }} />
        <span className="text-[11px] uppercase tracking-widest text-[#505070]">{label}</span>
        {activeNow && (
          <span className="ml-auto text-[10px] font-mono text-[#505070]">
            active: <span style={{ color }}>{activeNow}</span>
          </span>
        )}
      </div>

      <select
        value={selected}
        onChange={e => onChange(e.target.value)}
        className="bg-[#12121f] border border-[#252540] rounded-lg px-3 py-2.5 text-sm font-medium text-[#e8e8ff] focus:border-[#6366f1] focus:outline-none transition-colors w-full"
        style={{ accentColor: color }}
      >
        <option value="" disabled>— Choose a device —</option>
        {grouped.map(({ group, items }) => (
          <optgroup key={group} label={GROUP_LABEL[group]}>
            {items.map(d => (
              <option key={d.id} value={d.id}>
                {d.name === d.id ? d.id : `${d.name}  ·  ${d.id}`}
                {d.id === activeNow ? '   (currently active)' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {/* Counter chips per group */}
      <div className="flex flex-wrap gap-1.5 text-[10px]">
        {grouped.map(({ group, items }) => (
          <span
            key={group}
            className="px-2 py-0.5 rounded bg-[#0f0f1a] border border-[#252540] text-[#9090bb]"
          >
            {GROUP_LABEL[group].split(' ').slice(1).join(' ')}: {items.length}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────

export function Devices() {
  const status = useEngineStatus(1000)
  const [config, setConfig] = useState<CamillaConfig | null>(null)
  const [backends, setBackends] = useState<[string[], string[]]>([[], []])
  const [playbackDevices, setPlaybackDevices] = useState<[string, string][]>([])
  const [captureDevices,  setCaptureDevices]  = useState<[string, string][]>([])
  const [pbBackend, setPbBackend]   = useState('Alsa')
  const [capBackend, setCapBackend] = useState('Alsa')
  const [selectedPb,  setSelectedPb]  = useState('')
  const [selectedCap, setSelectedCap] = useState('')
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Currently active engine devices (from config) — used as "active" highlight
  const activeCap = useMemo(() => {
    const dev = (config?.devices as Record<string, Record<string, unknown>> | undefined)?.capture
    return typeof dev?.device === 'string' ? dev.device : ''
  }, [config])
  const activePb = useMemo(() => {
    const dev = (config?.devices as Record<string, Record<string, unknown>> | undefined)?.playback
    return typeof dev?.device === 'string' ? dev.device : ''
  }, [config])

  // ── Loader ─────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const cfg = await nebulaAPI.getConfig().catch(() => null)
      setConfig(cfg ?? null)
      const [pb, cap] = await nebulaAPI.getBackends()
      setBackends([pb, cap])
      // Prefer ALSA as default (matches the engine's typical setup on Linux)
      if (!pb.includes(pbBackend) && pb.length > 0) {
        setPbBackend(pb.includes('Alsa') ? 'Alsa' : pb[0])
      }
      if (!cap.includes(capBackend) && cap.length > 0) {
        setCapBackend(cap.includes('Alsa') ? 'Alsa' : cap[0])
      }
      // Pre-select the active devices so the dropdowns show what's running
      if (cfg) {
        const dev = (cfg.devices as Record<string, Record<string, unknown>> | undefined)
        const c = (dev?.capture as Record<string, unknown> | undefined)?.device
        const p = (dev?.playback as Record<string, unknown> | undefined)?.device
        if (typeof c === 'string') setSelectedCap(c)
        if (typeof p === 'string') setSelectedPb(p)
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }, [pbBackend, capBackend])

  useEffect(() => { load() }, [])

  // Re-fetch devices when backend changes
  useEffect(() => {
    if (!pbBackend) return
    nebulaAPI.getPlaybackDevices(pbBackend)
      .then(setPlaybackDevices)
      .catch(() => setPlaybackDevices([]))
  }, [pbBackend])

  useEffect(() => {
    if (!capBackend) return
    nebulaAPI.getCaptureDevices(capBackend)
      .then(setCaptureDevices)
      .catch(() => setCaptureDevices([]))
  }, [capBackend])

  const pbList  = useMemo(() => filterDevices(playbackDevices), [playbackDevices])
  const capList = useMemo(() => filterDevices(captureDevices),  [captureDevices])

  const dirty = (selectedPb !== '' && selectedPb !== activePb)
             || (selectedCap !== '' && selectedCap !== activeCap)

  // ── Apply ──────────────────────────────────────────────────────────────
  const apply = async () => {
    if (!config) {
      setError('No active config loaded')
      return
    }
    setApplying(true); setError(null); setSuccess(null)
    try {
      // Clone config, mutate devices.capture.device + devices.playback.device.
      // Keep format / channels / samplerate / etc. intact — the USB watcher's
      // _reconcile() will detect any format mismatch within ~15 s and fix it.
      const next: CamillaConfig = JSON.parse(JSON.stringify(config))
      const devices = (next.devices as Record<string, Record<string, unknown>>)
      if (selectedPb)  devices.playback.device = selectedPb
      if (selectedCap) devices.capture.device  = selectedCap

      // Also propagate type → Alsa when the picked id is hw:X,Y
      if (selectedPb.startsWith('hw:') || selectedPb === 'default'
          || selectedPb === 'pipewire' || selectedPb === 'null')
        devices.playback.type = pbBackend
      if (selectedCap.startsWith('hw:') || selectedCap === 'default'
          || selectedCap === 'pipewire' || selectedCap === 'null')
        devices.capture.type = capBackend

      const v = await nebulaAPI.validateConfig(next)
      if (v && v.result && v.result !== 'OK' && v.error) {
        throw new Error(`Validation failed: ${v.error}`)
      }
      await nebulaAPI.setConfig(next)
      setConfig(next)
      setSuccess(`Applied — engine reloading with ${selectedPb || activePb} ↔ ${selectedCap || activeCap}`)
      // Auto-clear success message after 4 s
      setTimeout(() => setSuccess(null), 4000)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setApplying(false)
    }
  }

  const reset = () => {
    setSelectedPb(activePb)
    setSelectedCap(activeCap)
    setError(null); setSuccess(null)
  }

  // Detect USB present (any device in the filtered list classified as 'usb')
  const usbConnected = [...pbList, ...capList].some(d => d.group === 'usb')

  const [pbBacks, capBacks] = backends

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Audio Devices</h1>
        {usbConnected ? (
          <Badge label="USB Connected" color="green" dot pulse />
        ) : (
          <Badge label="No USB Device" color="gray" />
        )}
        {dirty && <Badge label="Unsaved selection" color="yellow" />}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading || applying}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#252540] text-xs text-[#9090bb] hover:border-[#6366f1] hover:text-[#818cf8] disabled:opacity-50 transition-all"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={reset}
            disabled={!dirty || applying}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#252540] text-xs text-[#9090bb] hover:border-[#505070] disabled:opacity-50 transition-all"
          >
            <Repeat size={12} />
            Reset
          </button>
          <button
            onClick={apply}
            disabled={!dirty || applying}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#6366f1] text-xs font-semibold text-white hover:bg-[#818cf8] disabled:opacity-50 transition-all"
          >
            <Save size={12} />
            {applying ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-[#ef444450] bg-[#ef444410] text-[#ef4444] text-xs">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-[#22c55e50] bg-[#22c55e10] text-[#22c55e] text-xs">
          <Check size={14} className="flex-shrink-0 mt-0.5" />
          <span>{success}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Playback */}
        <Card title="Playback Device" accent="#22c55e">
          <div className="flex flex-col gap-4">
            {/* Backend selector */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-widest text-[#505070]">Backend</span>
              <div className="flex gap-2 flex-wrap">
                {pbBacks.map(b => (
                  <button
                    key={b}
                    onClick={() => setPbBackend(b)}
                    className={`px-3 py-1 rounded-md text-xs font-semibold transition-all border ${
                      pbBackend === b
                        ? 'bg-[#22c55e20] text-[#22c55e] border-[#22c55e50]'
                        : 'bg-[#12121f] text-[#505070] border-[#252540] hover:border-[#505070]'
                    }`}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>

            <DevicePicker
              label="Output Device"
              icon={Speaker}
              color="#22c55e"
              devices={pbList}
              selected={selectedPb}
              activeNow={activePb}
              onChange={setSelectedPb}
            />
          </div>
        </Card>

        {/* Capture */}
        <Card title="Capture Device" accent="#06b6d4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-widest text-[#505070]">Backend</span>
              <div className="flex gap-2 flex-wrap">
                {capBacks.map(b => (
                  <button
                    key={b}
                    onClick={() => setCapBackend(b)}
                    className={`px-3 py-1 rounded-md text-xs font-semibold transition-all border ${
                      capBackend === b
                        ? 'bg-[#06b6d420] text-[#06b6d4] border-[#06b6d450]'
                        : 'bg-[#12121f] text-[#505070] border-[#252540] hover:border-[#505070]'
                    }`}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>

            <DevicePicker
              label="Input Device"
              icon={Mic}
              color="#06b6d4"
              devices={capList}
              selected={selectedCap}
              activeNow={activeCap}
              onChange={setSelectedCap}
            />
          </div>
        </Card>

      </div>

      {/* Footer info */}
      <Card title="Live engine info" accent="#9090bb">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11px]">
          <div>
            <div className="text-[#505070] uppercase text-[9px] tracking-widest mb-1 flex items-center gap-1">
              <CircleDot size={9} />
              State
            </div>
            <div className="font-mono text-[#e8e8ff]">{status.state ?? 'OFFLINE'}</div>
          </div>
          <div>
            <div className="text-[#505070] uppercase text-[9px] tracking-widest mb-1 flex items-center gap-1">
              <Cpu size={9} />
              Sample rate
            </div>
            <div className="font-mono text-[#e8e8ff]">
              {status.captureRate > 0 ? `${(status.captureRate / 1000).toFixed(1)} kHz` : '—'}
            </div>
          </div>
          <div>
            <div className="text-[#505070] uppercase text-[9px] tracking-widest mb-1 flex items-center gap-1">
              <Layers size={9} />
              Channels
            </div>
            <div className="font-mono text-[#e8e8ff]">
              {status.playbackPeak.length || '—'}
            </div>
          </div>
          <div>
            <div className="text-[#505070] uppercase text-[9px] tracking-widest mb-1 flex items-center gap-1">
              <Usb size={9} />
              USB device
            </div>
            <div className="font-mono text-[#e8e8ff]">
              {usbConnected ? 'detected' : 'none'}
            </div>
          </div>
        </div>
      </Card>

      <div className="text-[10px] text-[#505070] leading-relaxed">
        Applying a new device writes <code className="text-[#a855f7]">devices.capture.device</code> and
        <code className="text-[#a855f7]"> devices.playback.device</code> to the active YAML config.
        The format (S16_LE / S24_3LE / S32_LE) is auto-detected by the USB watcher within ~15 s if it
        doesn't match the new device's capabilities — no manual sample-format selection needed.
      </div>
    </div>
  )
}
