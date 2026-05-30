import { useEffect, useRef, useState } from 'react'
import { nebulaAPI, type EngineState, type StatusResponse } from '@/lib/nebulaAPI'

export interface EngineStatus {
  state: EngineState | null
  processingLoad: number
  captureRate: number
  bufferLevel: number
  latencyMs: number
  clippedSamples: number
  clippedDelta: number
  captureRms: number[]
  capturePeak: number[]
  playbackRms: number[]
  playbackPeak: number[]
  volume: number
  mute: boolean
  connected: boolean
  raw: StatusResponse | null
}

const DEFAULT_STATUS: EngineStatus = {
  state: null, processingLoad: 0, captureRate: 0, bufferLevel: 0,
  latencyMs: 0, clippedSamples: 0, clippedDelta: 0,
  captureRms: [], capturePeak: [], playbackRms: [], playbackPeak: [],
  volume: 0, mute: false, connected: false, raw: null,
}

export function useEngineStatus(interval = 250): EngineStatus {
  const [status, setStatus] = useState<EngineStatus>(DEFAULT_STATUS)
  const sampleRateRef = useRef<number>(48000)
  const prevClippedRef = useRef<number | null>(null)
  const activeRef = useRef(true)

  useEffect(() => {
    nebulaAPI.getConfig().then((cfg) => {
      const sr = (cfg?.devices as Record<string, unknown>)?.samplerate
      if (typeof sr === 'number' && sr > 0) sampleRateRef.current = sr
    }).catch(() => {})
  }, [])

  useEffect(() => {
    activeRef.current = true
    const tick = async () => {
      if (!activeRef.current) return
      try {
        const [s, volume, mute] = await Promise.all([
          nebulaAPI.getStatus(),
          nebulaAPI.getVolume(),
          nebulaAPI.getMute(),
        ])
        const total = s.clippedsamples ?? 0
        const delta = prevClippedRef.current !== null
          ? Math.max(0, total - prevClippedRef.current)
          : 0
        prevClippedRef.current = total

        const sr = (s.capturerate && s.capturerate > 0)
          ? s.capturerate : sampleRateRef.current
        const latencyMs = s.bufferlevel > 0
          ? parseFloat(((s.bufferlevel / sr) * 1000).toFixed(1))
          : 0

        setStatus({
          state: s.cdsp_status,
          processingLoad: s.processingload * 100,
          captureRate: s.capturerate ?? 0,
          bufferLevel: s.bufferlevel,
          latencyMs,
          clippedSamples: total,
          clippedDelta: delta,
          captureRms: s.capturesignalrms,
          capturePeak: s.capturesignalpeak,
          playbackRms: s.playbacksignalrms,
          playbackPeak: s.playbacksignalpeak,
          volume,
          mute,
          connected: true,
          raw: s,
        })
      } catch {
        setStatus(prev => ({ ...prev, connected: false, state: null }))
      }
      if (activeRef.current) setTimeout(tick, interval)
    }
    tick()
    return () => { activeRef.current = false }
  }, [interval])

  return status
}
