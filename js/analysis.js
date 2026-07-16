// Musical analysis: onset envelope, BPM + downbeat-phase detection,
// per-beat chromagrams, key estimation (Krumhansl-Schmuckler) and
// harmonic compatibility (Camelot-wheel neighbours).
import { FFT } from './fft.js';

export const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export function monoMix(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  const chans = buffer.numberOfChannels;
  for (let c = 0; c < chans; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / chans;
  }
  return out;
}

// Half-wave rectified RMS flux — cheap onset-strength envelope.
export function onsetEnvelope(mono, sr, hop = 512) {
  const n = Math.floor(mono.length / hop);
  const env = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const o = i * hop;
    for (let j = 0; j < hop; j++) { const v = mono[o + j]; sum += v * v; }
    const rms = Math.sqrt(sum / hop);
    env[i] = Math.max(0, rms - prev);
    prev = rms;
  }
  return { env, fr: sr / hop };
}

// Autocorrelation of the onset envelope over 60–180 BPM.
export function detectBPM(env, fr) {
  let bestScore = -1, bestBpm = 120;
  for (let bpm = 60; bpm <= 180; bpm += 0.25) {
    const lag = (fr * 60) / bpm;
    let score = 0, count = 0;
    for (let m = 1; m <= 4; m++) {
      const L = Math.round(lag * m);
      for (let i = 0; i + L < env.length; i += 4) { score += env[i] * env[i + L]; count++; }
    }
    if (count) score /= count;
    if (score > bestScore) { bestScore = score; bestBpm = bpm; }
  }
  return bestBpm;
}

// Pick the grid phase (offset of beat 1 in seconds) that lines up with the
// strongest onsets.
export function detectOffset(env, fr, bpm) {
  const beat = (fr * 60) / bpm;
  const nPhase = Math.max(1, Math.floor(beat));
  let best = -1, bestP = 0;
  for (let p = 0; p < nPhase; p++) {
    let s = 0;
    for (let t = p; t < env.length; t += beat) s += env[Math.round(t)] || 0;
    if (s > best) { best = s; bestP = p; }
  }
  return bestP / fr;
}

// Which of the 4 beats after `offset` is the bar downbeat: score each beat
// phase by the onset energy landing on every 4th beat and pick the strongest.
// Returns a shift in beats (0-3) to add to the offset so beat 0 is a downbeat.
export function detectDownbeatShift(env, fr, bpm, offset) {
  const beat = (fr * 60) / bpm;
  const start = offset * fr;
  let best = -1, bestK = 0;
  for (let k = 0; k < 4; k++) {
    let s = 0, n = 0;
    for (let t = start + k * beat; t < env.length; t += 4 * beat) {
      s += env[Math.round(t)] || 0;
      n++;
    }
    if (n) s /= n;
    if (s > best) { best = s; bestK = k; }
  }
  return bestK;
}

// One 12-bin chroma vector per beat of the track. Async (yields to the UI)
// because a full track is a couple thousand FFTs.
export async function computeBeatChromas(mono, sr, bpm, offset, onProgress) {
  const spb = 60 / bpm;
  const nBeats = Math.max(0, Math.floor((mono.length / sr - offset) / spb));
  const N = 4096;
  const fft = new FFT(N);
  const hann = new Float32Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const chromas = new Float32Array(nBeats * 12);
  const fMin = 55, fMax = 1760;
  const kMin = Math.max(1, Math.floor((fMin * N) / sr));
  const kMax = Math.min(N / 2 - 1, Math.ceil((fMax * N) / sr));
  // Precompute bin -> pitch-class map.
  const binPc = new Int8Array(N / 2);
  for (let k = kMin; k <= kMax; k++) {
    const f = (k * sr) / N;
    const pitch = 12 * Math.log2(f / 440) + 69;
    binPc[k] = ((Math.round(pitch) % 12) + 12) % 12;
  }
  for (let b = 0; b < nBeats; b++) {
    const beatStart = Math.floor((offset + b * spb) * sr);
    const framesPerBeat = 2;
    const c = chromas.subarray(b * 12, b * 12 + 12);
    for (let f = 0; f < framesPerBeat; f++) {
      const off = beatStart + Math.floor((f * spb * sr) / framesPerBeat);
      if (off + N > mono.length) break;
      for (let i = 0; i < N; i++) re[i] = mono[off + i] * hann[i];
      im.fill(0);
      fft.forward(re, im);
      for (let k = kMin; k <= kMax; k++) {
        c[binPc[k]] += Math.hypot(re[k], im[k]);
      }
    }
    // Normalise so every beat contributes equally regardless of loudness.
    let max = 0;
    for (let i = 0; i < 12; i++) if (c[i] > max) max = c[i];
    if (max > 0) for (let i = 0; i < 12; i++) c[i] /= max;
    if (b % 32 === 0) {
      if (onProgress) onProgress(b / nBeats);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (onProgress) onProgress(1);
  return { chromas, nBeats };
}

function pearson(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

// Best of 24 keys for a chroma vector. Returns {pc, minor, name, camelot, conf}.
export function estimateKey(chroma) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += chroma[i];
  if (sum <= 0) return null;
  let best = null, second = -2;
  for (const minor of [false, true]) {
    const profile = minor ? MINOR_PROFILE : MAJOR_PROFILE;
    for (let root = 0; root < 12; root++) {
      const rot = new Float32Array(12);
      for (let pc = 0; pc < 12; pc++) rot[pc] = profile[(pc - root + 12) % 12];
      const r = pearson(chroma, rot);
      if (!best || r > best.score) {
        if (best) second = Math.max(second, best.score);
        best = { pc: root, minor, score: r };
      } else if (r > second) {
        second = r;
      }
    }
  }
  best.name = PC_NAMES[best.pc] + (best.minor ? 'm' : '');
  best.camelot = camelot(best);
  best.conf = Math.max(0, best.score - second);
  return best;
}

// Camelot wheel code, e.g. C major -> 8B, A minor -> 8A.
export function camelot(key) {
  const relMajPc = key.minor ? (key.pc + 3) % 12 : key.pc;
  const k = (((relMajPc - 5) * 7) % 12 + 12) % 12;
  const num = ((6 + k) % 12) + 1;
  return num + (key.minor ? 'A' : 'B');
}

// Key estimate for a beat range [startBeat, endBeat) by summing beat chromas.
// Sub-beat slices fall back to the beat they live in.
export function keyForRange(chromas, nBeats, startBeat, endBeat) {
  let b0 = Math.floor(startBeat);
  let b1 = Math.ceil(endBeat);
  if (b1 <= b0) b1 = b0 + 1;
  b0 = Math.max(0, Math.min(b0, nBeats - 1));
  b1 = Math.max(b0 + 1, Math.min(b1, nBeats));
  const sum = new Float32Array(12);
  for (let b = b0; b < b1; b++) {
    for (let i = 0; i < 12; i++) sum[i] += chromas[b * 12 + i];
  }
  return estimateKey(sum);
}

// Camelot-wheel harmonic compatibility: same key, relative major/minor,
// or a perfect fifth/fourth away in the same mode.
export function compatible(a, b) {
  if (!a || !b) return false;
  if (a.minor === b.minor) {
    const d = (b.pc - a.pc + 12) % 12;
    return d === 0 || d === 5 || d === 7;
  }
  if (!a.minor && b.minor) return b.pc === (a.pc + 9) % 12;
  return b.pc === (a.pc + 3) % 12;
}
