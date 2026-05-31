import { useEffect, useState } from 'react'
import { Usb, CheckCircle, AlertCircle, Loader } from 'lucide-react'
import { nebulaAPI } from '@/lib/nebulaAPI'

type UsbStatus = 'detected' | 'missing' | 'checking' | 'changed'

interface DeviceInfo {
  capture: string
  playback: string
}

// Devices que el host integra siempre (built-in chipset audio, HDMI,
// loopbacks de software). Si el primer ALSA card que aparece NO está en
// esta lista, asumimos que es un dispositivo USB externo conectado.
const BUILTIN_KEYWORDS = ['PCH', 'HDMI', 'pipewire', 'pulse', 'default', 'null', 'jack']

function isUsbCard(id: string, label: string): boolean {
  if (!id || !id.startsWith('hw:')) return false
  const haystack = `${id} ${label}`.toLowerCase()
  return !BUILTIN_KEYWORDS.some(kw => haystack.includes(kw.toLowerCase()))
}

export function UsbDeviceStatus() {
  const [status, setStatus]   = useState<UsbStatus>('checking')
  const [device, setDevice]   = useState<DeviceInfo | null>(null)
  const [prevDevice, setPrev] = useState<string>('')
  const [flash, setFlash]     = useState(false)

  useEffect(() => {
    let active = true

    const check = async () => {
      if (!active) return
      try {
        // /api/status reporta los devices ALSA cacheados por el backend
        // (refrescados cada vez que un endpoint los pide). Es la fuente
        // de verdad — no el config guardado, que puede estar vacío si
        // todavía no se cargó ninguno.
        const status = await nebulaAPI.getStatus()
        const playback = (status.playback_devices?.Alsa ?? []) as [string, string][]
        const capture  = (status.capture_devices?.Alsa  ?? []) as [string, string][]

        const usbPb  = playback.find(([id, name]) => isUsbCard(id, name))
        const usbCap = capture.find(([id, name])  => isUsbCard(id, name))

        if (usbPb || usbCap) {
          const capId = usbCap?.[0] ?? ''
          const pbId  = usbPb?.[0]  ?? ''
          if (prevDevice && prevDevice !== capId) {
            setStatus('changed')
            setFlash(true)
            setTimeout(() => setFlash(false), 3000)
          } else {
            setStatus('detected')
          }
          setDevice({ capture: capId, playback: pbId })
          setPrev(capId)
        } else {
          setStatus('missing')
          setDevice(null)
        }
      } catch {
        setStatus('checking')
      }
    }

    check()
    const id = setInterval(check, 2000)
    return () => { active = false; clearInterval(id) }
  }, [prevDevice])

  const config: Record<UsbStatus, { icon: typeof Usb; color: string; bg: string; label: string }> = {
    detected: { icon: CheckCircle, color: '#22c55e', bg: '#22c55e15', label: 'USB Connected' },
    missing:  { icon: AlertCircle, color: '#505070', bg: '#50507015', label: 'No USB Device'  },
    checking: { icon: Loader,      color: '#6366f1', bg: '#6366f115', label: 'Detecting...'   },
    changed:  { icon: CheckCircle, color: '#eab308', bg: '#eab30815', label: 'Device Changed' },
  }

  const cfg = config[status]
  const Icon = cfg.icon

  return (
    <div
      className={`
        flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-all duration-500
        ${flash ? 'scale-105' : 'scale-100'}
      `}
      style={{
        background: cfg.bg,
        borderColor: `${cfg.color}30`,
        boxShadow: flash ? `0 0 12px ${cfg.color}40` : 'none',
      }}
    >
      <Icon
        size={14}
        style={{ color: cfg.color }}
        className={status === 'checking' ? 'animate-spin' : ''}
      />
      <div className="flex flex-col leading-none">
        <span className="text-[10px] font-semibold" style={{ color: cfg.color }}>
          {cfg.label}
        </span>
        {device && (
          <span className="text-[9px] font-mono text-[#505070] mt-0.5">
            {device.capture}
          </span>
        )}
      </div>
    </div>
  )
}
