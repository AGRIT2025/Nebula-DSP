import type { ReactNode } from 'react'

interface CardProps {
  title?: string
  children: ReactNode
  className?: string
  glow?: boolean
  accent?: string
}

export function Card({ title, children, className = '', glow = false, accent }: CardProps) {
  return (
    <div
      className={`
        rounded-xl border border-[#252540] bg-[#1a1a2e] p-4
        ${glow ? 'shadow-[0_0_20px_2px_rgba(99,102,241,0.08)]' : ''}
        ${className}
      `}
    >
      {title && (
        <div className="flex items-center gap-2 mb-3">
          {accent && (
            <div className="w-1 h-4 rounded-full" style={{ background: accent }} />
          )}
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#505070]">
            {title}
          </span>
        </div>
      )}
      {children}
    </div>
  )
}

interface StatCardProps {
  label: string
  value: string | number
  unit?: string
  warning?: boolean
  dim?: boolean
  accent?: string
}

export function StatCard({ label, value, unit, warning, dim, accent }: StatCardProps) {
  return (
    <div className="rounded-xl border border-[#252540] bg-[#1a1a2e] px-4 py-3 flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-[#505070]">{label}</span>
      <div className="flex items-baseline gap-1.5">
        <span
          className={`text-2xl font-bold tabular-nums font-mono leading-none ${
            warning ? 'text-[#ef4444]' :
            dim     ? 'text-[#505070]' :
                      (accent ? '' : 'text-[#e8e8ff]')
          }`}
          style={accent && !warning && !dim ? { color: accent } : undefined}
        >
          {value}
        </span>
        {unit && (
          <span className="text-xs text-[#505070]">{unit}</span>
        )}
      </div>
    </div>
  )
}

interface BadgeProps {
  label: string
  color?: 'green' | 'yellow' | 'red' | 'blue' | 'purple' | 'gray'
  dot?: boolean
  pulse?: boolean
}

const BADGE_COLORS = {
  green:  { bg: '#22c55e15', text: '#22c55e', dot: '#22c55e' },
  yellow: { bg: '#eab30815', text: '#eab308', dot: '#eab308' },
  red:    { bg: '#ef444415', text: '#ef4444', dot: '#ef4444' },
  blue:   { bg: '#6366f115', text: '#6366f1', dot: '#6366f1' },
  purple: { bg: '#a855f715', text: '#a855f7', dot: '#a855f7' },
  gray:   { bg: '#50507015', text: '#505070', dot: '#505070' },
}

export function Badge({ label, color = 'gray', dot = false, pulse = false }: BadgeProps) {
  const c = BADGE_COLORS[color]
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold"
      style={{ background: c.bg, color: c.text }}
    >
      {dot && (
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${pulse ? 'animate-[pulse-dot_1.5s_ease-in-out_infinite]' : ''}`}
          style={{ background: c.dot }}
        />
      )}
      {label}
    </span>
  )
}
