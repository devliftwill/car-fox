/**
 * FoxLipsync — real-time viseme extraction from any WebAudio node.
 *
 * Taps an AnalyserNode and, once per animation frame, boils the spectrum down
 * to two continuous mouth parameters (the same trick wawa-lipsync uses —
 * formant-band ratios, no ML, no server):
 *
 *   open  0..1  jaw drop — driven by overall speech energy, weighted toward
 *               the F1 region (open vowels like AH have strong 300–900Hz).
 *   round 0..1  lip rounding — O/U vowels concentrate energy low (F2 drops),
 *               E/I and sibilants push it high, so the low/high tilt of the
 *               spectrum maps almost directly onto lip shape.
 *
 * The caller renders those however it likes (FoxAvatar builds a parametric
 * SVG mouth from them). Attack is fast and release slow, so the mouth snaps
 * open on plosives but doesn't flutter shut between syllables.
 */

export type FoxMouthParams = {
  open: number;
  round: number;
  /** 0..1 smoothed loudness — drives head bob / brow emphasis. */
  energy: number;
  speaking: boolean;
};

const SILENCE_DB = -62; // analyser floor treated as "no speech"
const SPEAK_HOLD_MS = 180; // keep `speaking` true across tiny gaps

export class FoxLipsync {
  readonly analyser: AnalyserNode;
  private bins: Float32Array<ArrayBuffer>;
  private binHz: number;
  private out: FoxMouthParams = { open: 0, round: 0, energy: 0, speaking: false };
  private lastVoiceAt = 0;

  constructor(ctx: AudioContext, source: AudioNode) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.45;
    source.connect(this.analyser);
    this.bins = new Float32Array(this.analyser.frequencyBinCount);
    this.binHz = ctx.sampleRate / this.analyser.fftSize;
  }

  /** Mean linear power of [lo, hi) Hz, from the dB spectrum. */
  private band(lo: number, hi: number): number {
    const a = Math.max(0, Math.floor(lo / this.binHz));
    const b = Math.min(this.bins.length - 1, Math.ceil(hi / this.binHz));
    let sum = 0;
    for (let i = a; i <= b; i++) {
      // dB → linear-ish loudness, floored. /20 (amplitude) reads better than
      // /10 (power) here: it compresses the range so consonants still register.
      sum += Math.pow(10, Math.max(this.bins[i], -90) / 20);
    }
    return sum / (b - a + 1);
  }

  /** Peak level (dB) in [lo, hi) Hz — catches formant peaks that means dilute. */
  private peakDb(lo: number, hi: number): number {
    const a = Math.max(0, Math.floor(lo / this.binHz));
    const b = Math.min(this.bins.length - 1, Math.ceil(hi / this.binHz));
    let max = -120;
    for (let i = a; i <= b; i++) if (this.bins[i] > max) max = this.bins[i];
    return max;
  }

  /** Call once per animation frame. Cheap (one FFT readback). */
  update(now = performance.now()): FoxMouthParams {
    this.analyser.getFloatFrequencyData(this.bins);

    const f1 = this.band(220, 900); // open-vowel body
    const f2lo = this.band(500, 1300); // back/rounded vowel F2
    const f2hi = this.band(1600, 3400); // front vowel F2 + consonant edge
    const sib = this.band(3600, 7500); // sibilants
    const total = f1 + f2lo + f2hi + sib;

    // Overall level in dB-ish terms for the silence gate.
    const levelDb = 20 * Math.log10(total / 4 + 1e-9);
    const voiced = levelDb > SILENCE_DB;
    if (voiced) this.lastVoiceAt = now;
    const speaking = now - this.lastVoiceAt < SPEAK_HOLD_MS;

    // Targets ---------------------------------------------------------------
    let openT = 0;
    let roundT = this.out.round; // hold shape through silence (no snap)
    let energyT = 0;
    if (voiced) {
      // Loudness → 0..1 with a soft knee; F1 dominance widens the jaw.
      const loud = Math.min(1, Math.max(0, (levelDb - SILENCE_DB) / 28));
      const f1Weight = f1 / (total / 4 + 1e-9); // ~1 = average, >1 = open vowel
      openT = Math.min(1, loud * (0.45 + 0.55 * Math.min(1.6, f1Weight)));
      // Lip rounding from the FORMANT PEAKS, not band means (means dilute a
      // narrow F2 peak across the whole band): when the strongest thing in
      // the low-F2 region towers over the high-F2 region → back/rounded
      // vowel (O/U); when the high region fights back → spread (E/I).
      const loPeak = this.peakDb(350, 1000);
      const hiPeak = this.peakDb(1100, 3400);
      roundT = Math.min(1, Math.max(0, (loPeak - hiPeak - 4) / 14));
      // Sibilants: teeth together, lips spread, jaw nearly shut.
      if (sib > 1.4 * (f1 + f2lo)) {
        openT = Math.min(openT, 0.16);
        roundT = 0;
      }
      energyT = loud;
    }

    // Smoothing: fast attack, slow release --------------------------------
    const o = this.out;
    o.open += (openT - o.open) * (openT > o.open ? 0.55 : 0.28);
    o.round += (roundT - o.round) * 0.3;
    o.energy += (energyT - o.energy) * (energyT > o.energy ? 0.4 : 0.12);
    o.speaking = speaking;
    if (!speaking && o.open < 0.02) o.open = 0;
    return o;
  }
}
