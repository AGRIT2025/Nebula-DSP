import { useEffect, useState, useRef } from 'react'
import { ShieldCheck, AlertTriangle, RotateCcw, Save, Power } from 'lucide-react'
import { nebulaAPI, type LimiterStatus } from '@/lib/nebulaAPI'
import { Card, Badge } from '@/components/ui/Card'

const LOOKAHEAD_OPTIONS = [1, 3, 5] as const

function fmtDb(v: number | undefined, digits = 1): string {
  if (v === undefined || isNaN(v)) return '—'
  const sign = v >= 0 ? '+' : ''
  return `${sign}${v.toFixed(digits)} dB`
}

function GainReductionBar({ grDb }: { grDb: number }) {
  // GR meter from 0 to -24 dB.  Right-anchored bar growing leftward.
  const pct = Math.min(100, Math.max(0, (Math.abs(grDb) / 24) * 100))
  const color = pct < 25 ? '#22c55e' : pct < 50 ? '#eab308' : pct < 75 ? '#f97316' : '#ef4444'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-[#505070]">Gain Reduction</span>
        <span className="text-sm font-mono font-bold" style={{ color }}>
          {grDb > -0.05 ? '0.0' : grDb.toFixed(1)} dB
        </span>
      </div>
      <div className="relative h-5 bg-[#0a0a14] rounded-md overflow-hidden border border-[#1a1a2e]">
        {[25, 50, 75].map(p => (
          <div key={p} className="absolute top-0 bottom-0 w-px opacity-25" style={{ left: `${p}%`, background: '#505070' }} />
        ))}
        <div
          className="absolute top-0 right-0 bottom-0 transition-none"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(to left, ${color}, ${color}77)`,
            boxShadow: pct > 5 ? `0 0 10px ${color}55` : 'none',
          }}
        />
        <div className="absolute top-0 bottom-0 right-0 w-0.5 bg-[#505070] opacity-60" />
      </div>
      <div className="flex justify-between text-[9px] font-mono text-[#505070]">
        <span>-24</span><span>-18</span><span>-12</span><span>-6</span><span>-3</span><span>0 dB</span>
      </div>
    </div>
  )
}

export function Limiter() {
  const [status,  setStatus]  = useState<LimiterStatus | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [busy,    setBusy]    = useState(false)
  const [dirty,   setDirty]   = useState(false)
  // Local sliders mirror the sidecar's params; "Apply" pushes them.
  const [ceilingDb,   setCeiling]   = useState(-1.0)
  const [lookaheadMs, setLookahead] = useState(3)
  const [releaseMs,   setRelease]   = useState(50)
  const [truePeak,    setTruePeak]  = useState(true)
  const initialised = useRef(false)

  const poll = async () => {
    try {
      const s = await nebulaAPI.limiterStatus()
      setStatus(s)
      setError(null)
      if (!initialised.current && s.online && s.ceiling_db !== undefined) {
        setCeiling(s.ceiling_db)
        setLookahead(s.lookahead_ms ?? 3)
        setRelease(s.release_ms ?? 50)
        setTruePeak(s.true_peak ?? true)
        initialised.current = true
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  useEffect(() => {
    poll()
    const id = setInterval(poll, 500)
    return () => clearInterval(id)
  }, [])

  const apply = async () => {
    setBusy(true); setError(null)
    try {
      const s = await nebulaAPI.limiterSetParams({
        ceiling_db:   ceilingDb,
        lookahead_ms: lookaheadMs,
        release_ms:   releaseMs,
        true_peak:    truePeak,
      })
      setStatus(s)
      setDirty(false)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally { setBusy(false) }
  }

  const reset = async () => {
    setBusy(true); setError(null)
    try {
      const s = await nebulaAPI.limiterReset()
      setStatus(s)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally { setBusy(false) }
  }

  // Helper to mark dirty when any control changes so "Apply" lights up.
  const onChange = (fn: () => void) => { fn(); setDirty(true) }

  const state = status
  const online = !!state?.online
  const grDb   = state?.gr_db ?? 0
  const isps   = state?.isp_hits ?? 0
  const clips  = state?.samples_clipped ?? 0
  const procd  = state?.samples_processed ?? 0
  const sr     = state?.sample_rate ?? 48000
  const latMs  = lookaheadMs   // algorithmic; ALSA buffer adds more, shown below

  return (
    <div className="flex flex-col gap-5">

      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-lg font-bold text-[#e8e8ff] tracking-tight">Brickwall Limiter</h1>
        <span className="text-[11px] text-[#f97316] bg-[#f9731615] border border-[#f9731630] rounded-md px-2 py-0.5">
          Lookahead · True-Peak
        </span>
        <Badge label={online ? 'Online' : 'Offline'} color={online ? 'green' : 'red'} dot pulse={online} />
        {dirty && <Badge label="Unsaved" color="yellow" />}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={reset}
            disabled={busy || !online}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#252540] text-xs text-[#9090bb] hover:border-[#505070] disabled:opacity-50 transition-all"
          >
            <RotateCcw size={12} />
            Reset stats
          </button>
          <button
            onClick={apply}
            disabled={busy || !online || !dirty}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#f97316] text-xs font-semibold text-white hover:bg-[#fb923c] disabled:opacity-50 transition-all"
          >
            <Save size={12} />
            Apply
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-[#ef444450] bg-[#ef444410] text-[#ef4444] text-xs">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {!online && (
        <div className="flex items-start gap-2 px-3 py-3 rounded-lg border border-[#252540] bg-[#12121f] text-[#9090bb] text-xs">
          <Power size={14} className="flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold mb-1">El servicio nebula-limiter no está corriendo.</div>
            <div className="text-[#505070]">
              Verificá con <code className="text-[#a855f7]">systemctl status nebula-limiter</code> y los logs en
              <code className="text-[#a855f7]"> journalctl -u nebula-limiter</code>.
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        <Card title="Parameters" accent="#f97316" className="lg:col-span-1">
          <div className="flex flex-col gap-4">

            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between">
                <span className="text-[11px] text-[#9090bb]">Ceiling</span>
                <span className="text-[11px] font-mono font-semibold text-[#f97316]">{ceilingDb.toFixed(1)} dBFS</span>
              </div>
              <input
                type="range" min={-6} max={0} step={0.1} value={ceilingDb}
                disabled={!online}
                onChange={e => onChange(() => setCeiling(Number(e.target.value)))}
                className="w-full h-1 rounded-full appearance-none accent-[#f97316] disabled:opacity-50"
                style={{ background: `linear-gradient(to right, #f97316 0%, #f97316 ${((ceilingDb + 6) / 6) * 100}%, #12121f ${((ceilingDb + 6) / 6) * 100}%, #12121f 100%)` }}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-[#9090bb]">Lookahead</span>
              <div className="flex gap-2">
                {LOOKAHEAD_OPTIONS.map(ms => (
                  <button
                    key={ms}
                    disabled={!online}
                    onClick={() => onChange(() => setLookahead(ms))}
                    className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-all disabled:opacity-50 ${
                      lookaheadMs === ms
                        ? 'bg-[#f9731620] text-[#f97316] border-[#f9731650]'
                        : 'bg-[#12121f] text-[#505070] border-[#252540] hover:border-[#505070]'
                    }`}
                  >
                    {ms} ms
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between">
                <span className="text-[11px] text-[#9090bb]">Release</span>
                <span className="text-[11px] font-mono font-semibold text-[#a855f7]">{releaseMs.toFixed(0)} ms</span>
              </div>
              <input
                type="range" min={10} max={500} step={5} value={releaseMs}
                disabled={!online}
                onChange={e => onChange(() => setRelease(Number(e.target.value)))}
                className="w-full h-1 rounded-full appearance-none accent-[#a855f7] disabled:opacity-50"
                style={{ background: `linear-gradient(to right, #a855f7 0%, #a855f7 ${((releaseMs - 10) / 490) * 100}%, #12121f ${((releaseMs - 10) / 490) * 100}%, #12121f 100%)` }}
              />
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox" checked={truePeak} disabled={!online}
                onChange={e => onChange(() => setTruePeak(e.target.checked))}
                className="accent-[#06b6d4]"
              />
              <span className="text-[11px] text-[#9090bb]">2× true-peak detection (catches inter-sample peaks)</span>
            </label>

            <div className="text-[10px] text-[#505070] leading-relaxed border-t border-[#1a1a2e] pt-3">
              Algoritmo: sliding-min sobre L+1 ganancias + one-pole release.
              Salida ≤ ceiling por construcción (los tests unitarios lo verifican).
              Latencia algorítmica = lookahead; total con ALSA agrega ~{(256 * 4 / sr * 1000).toFixed(1)} ms de buffer.
            </div>
          </div>
        </Card>

        <Card title="Live" accent="#22c55e" className="lg:col-span-2">
          <div className="flex flex-col gap-5">
            <GainReductionBar grDb={grDb} />

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-widest text-[#505070]">ISPs caught</span>
                <span className="text-base font-mono font-bold text-[#22c55e]">{isps.toLocaleString()}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-widest text-[#505070]">Samples clipped</span>
                <span className={`text-base font-mono font-bold ${clips > 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>{clips.toLocaleString()}</span>
                {clips > 0 && <span className="text-[9px] text-[#ef4444]">↑ algorithm bug — file an issue</span>}
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-widest text-[#505070]">Samples processed</span>
                <span className="text-base font-mono font-bold text-[#9090bb]">{procd.toLocaleString()}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-widest text-[#505070]">Algo latency</span>
                <span className="text-base font-mono font-bold text-[#06b6d4]">{latMs.toFixed(1)} ms</span>
              </div>
            </div>

            <div className="border-t border-[#1a1a2e] pt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11px]">
              <div>
                <div className="text-[#505070]">Sample rate</div>
                <div className="font-mono text-[#e8e8ff]">{sr.toLocaleString()} Hz</div>
              </div>
              <div>
                <div className="text-[#505070]">Channels</div>
                <div className="font-mono text-[#e8e8ff]">{state?.channels ?? '—'}</div>
              </div>
              <div>
                <div className="text-[#505070]">Active ceiling</div>
                <div className="font-mono text-[#e8e8ff]">{fmtDb(state?.ceiling_db)}</div>
              </div>
              <div>
                <div className="text-[#505070]">True-peak</div>
                <div className="font-mono text-[#e8e8ff]">{state?.true_peak ? 'enabled' : 'disabled'}</div>
              </div>
            </div>

            <div className="border-t border-[#1a1a2e] pt-4 flex items-center gap-2 text-[10px] text-[#505070]">
              <ShieldCheck size={12} className="text-[#22c55e]" />
              Brickwall garantizado por algoritmo: la salida no puede exceder el ceiling. Si "Samples clipped" sube, es un bug y debe reportarse.
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
