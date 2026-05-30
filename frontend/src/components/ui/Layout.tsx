import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import {
  LayoutDashboard, Sliders, AudioWaveform, Route,
  Volume2, Cpu, Menu, X, Radio, ScanLine
} from 'lucide-react'
import { useEngineStatus } from '@/hooks/useEngineStatus'

const NAV = [
  { to: '/',          icon: LayoutDashboard, label: 'Dashboard'   },
  { to: '/compressor',icon: AudioWaveform,   label: 'Compressor'  },
  { to: '/filters',   icon: Sliders,         label: 'Filters'     },
  { to: '/pipeline',  icon: Route,           label: 'Pipeline'    },
  { to: '/volume',    icon: Volume2,          label: 'Volume'      },
  { to: '/devices',         icon: Cpu,      label: 'Devices'         },
  { to: '/room-correction', icon: ScanLine, label: 'Room Correction' },
]

const STATE_COLOR: Record<string, string> = {
  RUNNING:  '#22c55e',
  PAUSED:   '#eab308',
  STARTING: '#6366f1',
  INACTIVE: '#505070',
  STALLED:  '#ef4444',
}

function EngineStatusDot() {
  const { state, connected } = useEngineStatus(1000)
  const color = connected && state ? (STATE_COLOR[state] ?? '#505070') : '#505070'
  const label = connected && state ? state : 'OFFLINE'
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#12121f] border border-[#252540]">
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{
          background: color,
          boxShadow: connected && state === 'RUNNING' ? `0 0 6px ${color}` : 'none',
          animation: state === 'RUNNING' ? 'pulse-dot 2s ease-in-out infinite' : 'none',
        }}
      />
      <span className="text-[10px] font-mono font-semibold" style={{ color }}>
        {label}
      </span>
    </div>
  )
}

interface LayoutProps { children: ReactNode }

export function Layout({ children }: LayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  useLocation()

  return (
    <div className="flex h-full bg-[#080810]">

      {/* ── Sidebar desktop ── */}
      <aside className="hidden md:flex flex-col w-56 shrink-0 bg-[#0f0f1a] border-r border-[#252540]">
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-[#252540]">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#6366f1] to-[#a855f7] flex items-center justify-center">
            <Radio size={14} className="text-white" />
          </div>
          <div>
            <div className="text-sm font-bold text-[#e8e8ff] tracking-tight">Nebula DSP</div>
            <div className="text-[9px] text-[#505070] uppercase tracking-widest">Pro Audio</div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-3 flex flex-col gap-0.5">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `
                flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-150
                ${isActive
                  ? 'bg-[#6366f115] text-[#818cf8] border border-[#6366f130]'
                  : 'text-[#505070] hover:text-[#9090bb] hover:bg-[#ffffff08]'
                }
              `}
            >
              <Icon size={16} strokeWidth={1.8} />
              <span className="font-medium">{label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Engine status bottom */}
        <div className="p-3 border-t border-[#252540]">
          <EngineStatusDot />
        </div>
      </aside>

      {/* ── Mobile header ── */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50 bg-[#0f0f1a] border-b border-[#252540] flex items-center justify-between px-4 h-14">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-[#6366f1] to-[#a855f7] flex items-center justify-center">
            <Radio size={12} className="text-white" />
          </div>
          <span className="text-sm font-bold text-[#e8e8ff]">Nebula DSP</span>
        </div>
        <button
          onClick={() => setMobileOpen(o => !o)}
          className="text-[#9090bb] hover:text-[#e8e8ff] transition-colors p-1"
        >
          {mobileOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>

      {/* ── Mobile drawer ── */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={() => setMobileOpen(false)}>
          <div
            className="absolute top-14 left-0 bottom-0 w-64 bg-[#0f0f1a] border-r border-[#252540] p-3 flex flex-col gap-0.5"
            onClick={e => e.stopPropagation()}
          >
            {NAV.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) => `
                  flex items-center gap-3 px-3 py-3 rounded-lg text-sm transition-all
                  ${isActive
                    ? 'bg-[#6366f115] text-[#818cf8] border border-[#6366f130]'
                    : 'text-[#505070] hover:text-[#9090bb]'
                  }
                `}
              >
                <Icon size={18} strokeWidth={1.8} />
                <span className="font-medium">{label}</span>
              </NavLink>
            ))}
            <div className="mt-auto pt-3 border-t border-[#252540]">
              <EngineStatusDot />
            </div>
          </div>
        </div>
      )}

      {/* ── Main content ── */}
      <main className="flex-1 overflow-y-auto md:pt-0 pt-14">
        <div className="max-w-6xl mx-auto px-4 py-6">
          {children}
        </div>
      </main>

    </div>
  )
}
