export type EngineState = 'RUNNING' | 'PAUSED' | 'INACTIVE' | 'STARTING' | 'STALLED'

export interface StatusResponse {
  backend_version: string
  cdsp_status: EngineState
  cdsp_version: string
  processingload: number
  resamplerload: number
  bufferlevel: number
  clippedsamples: number
  rateadjust: number
  capturerate: number | null
  capturesignalrms: number[]
  capturesignalpeak: number[]
  playbacksignalrms: number[]
  playbacksignalpeak: number[]
  playback_devices: Record<string, [string, string][]>
  capture_devices: Record<string, [string, string][]>
  backends: [string[], string[]]
}

export type CamillaConfig = Record<string, unknown>

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`)
  const text = await res.text()
  if (!text) return undefined as T
  if (text === 'True')  return true  as unknown as T
  if (text === 'False') return false as unknown as T
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'string') {
      try { return JSON.parse(parsed) as T } catch { /* not nested */ }
    }
    return parsed as T
  } catch {
    return text as unknown as T
  }
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`)
  const text = await res.text()
  if (!text) return undefined as T
  try { return JSON.parse(text) } catch { return text as unknown as T }
}

export interface RcDevice {
  index:      number
  name:       string
  max_input:  number
  max_output: number
  default_sr: number
}

export interface RcBiquad {
  type: string
  freq: number
  gain: number
  q:    number
}

export interface RcDesignResult {
  mode:          'iir' | 'fir'
  target_label:  string
  correction_db: number[]
  biquads:       RcBiquad[]
  fir_path:      string | null
}

export const nebulaAPI = {
  getStatus:    () => apiGet<StatusResponse>('/api/status'),
  getConfig:    () => apiGet<CamillaConfig>('/api/getconfig'),
  // El backend espera { config: <yaml-object> } en setconfig — wrappear acá
  // para que los callers no tengan que recordarlo.
  setConfig:    (c: CamillaConfig) => apiPost<void>('/api/setconfig', { config: c }),
  validateConfig: (c: CamillaConfig) =>
    apiPost<{ result: string; error?: string }>('/api/validateconfig', c),

  stop:         () => apiPost<void>('/api/stop'),

  getVolume:    () => apiGet<number>('/api/getparam/volume'),
  setVolume:    (db: number) => apiPost<void>('/api/setparam/volume', db),
  getMute:      () => apiGet<boolean>('/api/getparam/mute'),
  setMute:      (m: boolean) => apiPost<void>('/api/setparam/mute', m),

  getFaderVolume:    (i: number) => apiGet<number>(`/api/getparamindex/fadervolume/${i}`),
  setFaderVolume:    (i: number, db: number) => apiPost<void>(`/api/setparamindex/fadervolume/${i}`, db),
  getFaderMute:      (i: number) => apiGet<boolean>(`/api/getparamindex/fadermute/${i}`),
  setFaderMute:      (i: number, m: boolean) => apiPost<void>(`/api/setparamindex/fadermute/${i}`, m),
  getAllFaderVolumes: () => apiGet<number[]>('/api/getlistparam/fadervolume'),
  getAllFaderMutes:   () => apiGet<boolean[]>('/api/getlistparam/fadermute'),

  listConfigs:     () => apiGet<string[]>('/api/storedconfigs'),
  getActiveConfig: () => apiGet<string>('/api/getactiveconfigfilename'),
  setActiveConfig: (n: string) => apiPost<void>('/api/setactiveconfigfile', n),

  getBackends:        () => apiGet<[string[], string[]]>('/api/backends'),
  getCaptureDevices:  (b: string) => apiGet<[string, string][]>(`/api/capturedevices/${b}`),
  getPlaybackDevices: (b: string) => apiGet<[string, string][]>(`/api/playbackdevices/${b}`),

  getGuiConfig: () => apiGet<Record<string, unknown>>('/api/guiconfig'),

  // ── Room Correction ──────────────────────────────────────────────────────
  rcTargets:  () => apiGet<{ id: string; label: string }[]>('/api/rc/targets'),
  rcDevices:  () => apiGet<RcDevice[]>('/api/rc/devices'),

  rcMeasure:  (opts?: { output_device?: number; input_device?: number; sample_rate?: number }) =>
    apiPost<{ job_id: string }>('/api/rc/measure', opts ?? {}),

  rcJobStatus: (jobId: string) =>
    apiGet<{ status: string; progress: number; message: string; result?: string }>(
      `/api/rc/measure/${jobId}`,
    ),

  rcResult: () =>
    apiGet<{ measurement_id: string; frequencies: number[]; magnitude_db: number[]; sample_rate: number }>(
      '/api/rc/result',
    ),

  rcDesign: (opts: { mode: 'iir' | 'fir'; target: string; max_gain_db?: number; n_taps?: number }) =>
    apiPost<RcDesignResult>('/api/rc/design', opts),

  rcApply:  () => apiPost<{ ok: boolean }>('/api/rc/apply'),
  rcRemove: () => apiPost<{ ok: boolean }>('/api/rc/remove'),
  rcExport: () => '/api/rc/export',
}

export function formatDb(value: number, decimals = 1): string {
  if (typeof value !== 'number' || isNaN(value)) return '— dB'
  if (value === -Infinity || value < -150) return '-∞ dB'
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)} dB`
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

export function linearToDb(lin: number): number {
  if (lin <= 0) return -Infinity
  return 20 * Math.log10(lin)
}

export function levelColor(db: number): string {
  if (db >= -1)  return '#ef4444'
  if (db >= -6)  return '#f97316'
  if (db >= -12) return '#eab308'
  return '#22c55e'
}
