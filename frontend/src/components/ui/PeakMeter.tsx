import { useEffect, useRef } from 'react'
import { type KSystem, K_SYSTEM_SHIFT } from '@/lib/nebulaAPI'

/**
 * Professional vertical peak/RMS meter.
 *
 * Render path is canvas-based so we can draw:
 *   - a side scale with dB ticks + labels
 *   - smooth ballistics (peak decay 20 dB/s, RMS lowpass τ=300 ms)
 *   - peak-hold sticky tick (1.5 s)
 *   - color gradient bar (green → yellow → orange → red)
 *   - clip-flash overlay at the top
 *
 * Ballistics run in a private `requestAnimationFrame` loop driven by the
 * latest `peak` / `rms` props (refs avoid re-render on every frame).
 * HiDPI is handled via `devicePixelRatio` scaling.
 */

const MIN_DB = -60
const MAX_DB = 6              // headroom above 0 dBFS for K-system shifts
const PEAK_DECAY_DB_PER_SEC = 20
const RMS_TAU_MS            = 300
const PEAK_HOLD_MS          = 1500

const SEGMENT_GRADIENT: Array<[number, string]> = [
  [-60, '#22c55e'],   // green
  [-18, '#22c55e'],
  [-12, '#86efac'],
  [-6,  '#eab308'],   // yellow
  [-3,  '#f97316'],   // orange
  [0,   '#ef4444'],   // red
]

interface PeakMeterProps {
  /** Raw dBFS peak from the engine (will be shifted by kSystem). */
  peak:        number
  /** Raw dBFS RMS from the engine. */
  rms:         number
  channelLabel?: string
  height?:     number   // px in CSS pixels; default 220
  width?:      number   // px in CSS pixels; default 16
  kSystem?:    KSystem  // default 'off' → raw dBFS
  /** Render the side scale with tick labels. Set to true on the first meter
   *  of a strip; the second can omit it to save horizontal space. */
  showScale?:  boolean
}

function dbToY(db: number, height: number): number {
  const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db))
  return height - ((clamped - MIN_DB) / (MAX_DB - MIN_DB)) * height
}

function colorAt(db: number): string {
  for (let i = SEGMENT_GRADIENT.length - 1; i >= 0; i--) {
    if (db >= SEGMENT_GRADIENT[i][0]) return SEGMENT_GRADIENT[i][1]
  }
  return SEGMENT_GRADIENT[0][1]
}

export function PeakMeter({
  peak, rms,
  channelLabel,
  height   = 220,
  width    = 16,
  kSystem  = 'off',
  showScale = false,
}: PeakMeterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Live values fed by the caller; refs avoid React re-render at 60 Hz.
  const peakInRef = useRef(peak)
  const rmsInRef  = useRef(rms)
  peakInRef.current = peak
  rmsInRef.current  = rms

  // Smoothed values driven by the rAF loop.
  const peakSmoothRef = useRef(MIN_DB)
  const rmsSmoothRef  = useRef(MIN_DB)
  const peakHoldRef   = useRef(MIN_DB)
  const peakHoldExpiryRef = useRef(0)
  const lastFrameRef  = useRef(performance.now())

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // HiDPI: paint at device resolution, scale via canvas style w/h.
    const dpr = window.devicePixelRatio || 1
    const scaleWidth = showScale ? 28 : 0  // px for tick labels at left
    const fullW = width + scaleWidth
    const fullH = height + 14              // space for label below
    canvas.width  = fullW * dpr
    canvas.height = fullH * dpr
    canvas.style.width  = `${fullW}px`
    canvas.style.height = `${fullH}px`
    ctx.scale(dpr, dpr)

    let rafId = 0
    const shift = K_SYSTEM_SHIFT[kSystem]

    const draw = (now: number) => {
      const dt = Math.max(0, (now - lastFrameRef.current) / 1000)
      lastFrameRef.current = now

      // ── update peak (instant up, linear decay down) ──────────────
      const liveP = peakInRef.current + shift
      if (liveP > peakSmoothRef.current) {
        peakSmoothRef.current = liveP
      } else {
        peakSmoothRef.current = Math.max(
          MIN_DB,
          peakSmoothRef.current - PEAK_DECAY_DB_PER_SEC * dt,
        )
      }

      // ── update RMS (one-pole lowpass with τ = RMS_TAU_MS) ────────
      const liveR = rmsInRef.current + shift
      const alpha = 1 - Math.exp(-(dt * 1000) / RMS_TAU_MS)
      rmsSmoothRef.current = rmsSmoothRef.current + alpha * (liveR - rmsSmoothRef.current)

      // ── peak hold: bumps up to current peak, sticks for PEAK_HOLD_MS ──
      if (liveP >= peakHoldRef.current) {
        peakHoldRef.current = liveP
        peakHoldExpiryRef.current = now + PEAK_HOLD_MS
      } else if (now >= peakHoldExpiryRef.current) {
        peakHoldRef.current = peakSmoothRef.current   // follow the bar back down
      }

      // ── render ──────────────────────────────────────────────────
      ctx.clearRect(0, 0, fullW, fullH)

      // Background of the meter column
      const x = scaleWidth
      ctx.fillStyle = '#0a0a14'
      ctx.fillRect(x, 0, width, height)
      ctx.strokeStyle = '#1a1a2e'
      ctx.lineWidth = 1
      ctx.strokeRect(x + 0.5, 0.5, width - 1, height - 1)

      // RMS bar (filled gradient from bottom up to RMS level)
      const rmsY = dbToY(rmsSmoothRef.current, height)
      const grd  = ctx.createLinearGradient(0, height, 0, 0)
      grd.addColorStop(0.0, '#22c55e')                       // -60
      grd.addColorStop((MAX_DB - 0 + Math.abs(MIN_DB - (-18))) / (MAX_DB - MIN_DB), '#22c55e')
      grd.addColorStop((MAX_DB - (-6)) / (MAX_DB - MIN_DB),  '#eab308')
      grd.addColorStop((MAX_DB - (-3)) / (MAX_DB - MIN_DB),  '#f97316')
      grd.addColorStop((MAX_DB - 0)    / (MAX_DB - MIN_DB),  '#ef4444')
      ctx.fillStyle = grd
      ctx.fillRect(x + 1, rmsY, width - 2, height - rmsY)

      // Peak bar (thin line at smoothed peak height with color)
      const peakY = dbToY(peakSmoothRef.current, height)
      ctx.fillStyle = colorAt(peakSmoothRef.current - shift)  // color uses raw dB so red still means clipping at DAC
      ctx.fillRect(x + 1, peakY, width - 2, 2)

      // Peak hold tick (white)
      const holdY = dbToY(peakHoldRef.current, height)
      ctx.fillStyle = '#e8e8ff'
      ctx.fillRect(x + 1, holdY, width - 2, 1)

      // Clip indicator: lit while raw peak (pre-K) crosses -0.5 dBFS
      if (peakInRef.current >= -0.5) {
        ctx.fillStyle = '#ef4444'
        ctx.fillRect(x, 0, width, 4)
        ctx.shadowBlur = 6; ctx.shadowColor = '#ef4444'
        ctx.fillRect(x, 0, width, 4)
        ctx.shadowBlur = 0
      }

      // Side scale (optional)
      if (showScale) {
        ctx.fillStyle = '#505070'
        ctx.font = '9px monospace'
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        const ticks = [0, -3, -6, -12, -18, -24, -36, -48]
        for (const t of ticks) {
          const ty = dbToY(t + shift, height)
          ctx.fillText(t === 0 ? '0' : `${t}`, scaleWidth - 4, ty)
          ctx.fillStyle = t === 0 ? '#9090bb' : '#252540'
          ctx.fillRect(scaleWidth - 2, ty, 2, t === 0 ? 1.5 : 1)
          ctx.fillStyle = '#505070'
        }
      }

      // 0 dB reference line on the bar itself (prominent in K-system)
      const zeroY = dbToY(0 + shift, height)
      ctx.strokeStyle = '#9090bb55'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, zeroY); ctx.lineTo(x + width, zeroY)
      ctx.stroke()

      // Channel label below
      if (channelLabel) {
        ctx.fillStyle = '#505070'
        ctx.font = '9px monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText(channelLabel, x + width / 2, height + 2)
      }

      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafId)
  }, [width, height, channelLabel, kSystem, showScale])

  return <canvas ref={canvasRef} />
}
