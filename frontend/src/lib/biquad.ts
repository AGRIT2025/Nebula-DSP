// RBJ Audio EQ Cookbook biquad coefficient + magnitude-response helpers.
//
// Same math CamillaDSP uses internally (see camillalib::biquad), so what
// the GUI graph shows must match what the engine produces sample-for-sample.

export type BiquadSubtype =
  | 'Peaking' | 'Highshelf' | 'Lowshelf'
  | 'Highpass' | 'Lowpass' | 'Notch'

export interface BiquadParams {
  subtype: BiquadSubtype
  freq:    number   // Hz
  q:       number
  gain:    number   // dB (used only by Peaking/Highshelf/Lowshelf)
}

export interface BiquadCoeffs {
  b0: number; b1: number; b2: number
  a0: number; a1: number; a2: number
}

/** Compute the 6 biquad coefficients for a given sub-type. */
export function biquadCoeffs(p: BiquadParams, fs: number): BiquadCoeffs {
  const w0    = 2 * Math.PI * p.freq / fs
  const cosw0 = Math.cos(w0)
  const sinw0 = Math.sin(w0)
  const alpha = sinw0 / (2 * p.q)
  const A     = Math.pow(10, p.gain / 40)   // used by shelves/peaking

  switch (p.subtype) {
    case 'Peaking': {
      return {
        b0: 1 + alpha * A,
        b1: -2 * cosw0,
        b2: 1 - alpha * A,
        a0: 1 + alpha / A,
        a1: -2 * cosw0,
        a2: 1 - alpha / A,
      }
    }
    case 'Lowpass': {
      const k = (1 - cosw0) / 2
      return {
        b0: k, b1: 1 - cosw0, b2: k,
        a0: 1 + alpha, a1: -2 * cosw0, a2: 1 - alpha,
      }
    }
    case 'Highpass': {
      const k = (1 + cosw0) / 2
      return {
        b0: k, b1: -(1 + cosw0), b2: k,
        a0: 1 + alpha, a1: -2 * cosw0, a2: 1 - alpha,
      }
    }
    case 'Highshelf': {
      const beta = 2 * Math.sqrt(A) * alpha
      return {
        b0:  A * ((A + 1) + (A - 1) * cosw0 + beta),
        b1: -2 * A * ((A - 1) + (A + 1) * cosw0),
        b2:  A * ((A + 1) + (A - 1) * cosw0 - beta),
        a0: (A + 1) - (A - 1) * cosw0 + beta,
        a1:  2 * ((A - 1) - (A + 1) * cosw0),
        a2: (A + 1) - (A - 1) * cosw0 - beta,
      }
    }
    case 'Lowshelf': {
      const beta = 2 * Math.sqrt(A) * alpha
      return {
        b0:  A * ((A + 1) - (A - 1) * cosw0 + beta),
        b1:  2 * A * ((A - 1) - (A + 1) * cosw0),
        b2:  A * ((A + 1) - (A - 1) * cosw0 - beta),
        a0: (A + 1) + (A - 1) * cosw0 + beta,
        a1: -2 * ((A - 1) + (A + 1) * cosw0),
        a2: (A + 1) + (A - 1) * cosw0 - beta,
      }
    }
    case 'Notch': {
      return {
        b0: 1, b1: -2 * cosw0, b2: 1,
        a0: 1 + alpha, a1: -2 * cosw0, a2: 1 - alpha,
      }
    }
  }
}

/**
 * Magnitude (in dB) of the biquad transfer function at frequency `f`.
 *
 * H(z) = (b0 + b1·z⁻¹ + b2·z⁻²) / (a0 + a1·z⁻¹ + a2·z⁻²) evaluated at
 * z = e^{jω}, ω = 2π·f/fs.  Real/imag parts computed manually so we don't
 * pull a complex-number library into the bundle for ~10 lines of math.
 */
export function biquadMagnitudeDb(c: BiquadCoeffs, f: number, fs: number): number {
  const w     = 2 * Math.PI * f / fs
  const cosw  = Math.cos(w),  sinw  = Math.sin(w)
  const cos2w = Math.cos(2*w), sin2w = Math.sin(2*w)

  const numRe = c.b0 + c.b1 * cosw + c.b2 * cos2w
  const numIm = -c.b1 * sinw - c.b2 * sin2w
  const denRe = c.a0 + c.a1 * cosw + c.a2 * cos2w
  const denIm = -c.a1 * sinw - c.a2 * sin2w

  const num2 = numRe * numRe + numIm * numIm
  const den2 = denRe * denRe + denIm * denIm
  if (den2 <= 0) return 0
  return 10 * Math.log10(num2 / den2)
}

/** Sensible starting params per sub-type for the "Add" button. */
export const SUBTYPE_DEFAULTS: Record<BiquadSubtype, Omit<BiquadParams, 'subtype'>> = {
  Peaking:   { freq: 1000,  q: 1.0,    gain: 0 },
  Highshelf: { freq: 10000, q: 0.707,  gain: 0 },
  Lowshelf:  { freq: 100,   q: 0.707,  gain: 0 },
  Highpass:  { freq: 80,    q: 0.707,  gain: 0 },
  Lowpass:   { freq: 18000, q: 0.707,  gain: 0 },
  Notch:     { freq: 50,    q: 30,     gain: 0 },
}

/** True if the sub-type uses the `gain` parameter (others ignore it). */
export function usesGain(subtype: BiquadSubtype): boolean {
  return subtype === 'Peaking' || subtype === 'Highshelf' || subtype === 'Lowshelf'
}

/** All sub-types we expose in the UI, in display order. */
export const BIQUAD_SUBTYPES: BiquadSubtype[] = [
  'Peaking', 'Highshelf', 'Lowshelf', 'Highpass', 'Lowpass', 'Notch',
]

/** Color per sub-type for the response graph + filter row badge. */
export const SUBTYPE_COLOR: Record<BiquadSubtype, string> = {
  Peaking:   '#6366f1',
  Highshelf: '#a855f7',
  Lowshelf:  '#06b6d4',
  Highpass:  '#22c55e',
  Lowpass:   '#eab308',
  Notch:     '#f97316',
}
