// Quantized pad playback engine. Slices the loaded track on a beat grid and
// launches/loops slices on quantize boundaries, Ableton-session style.
const LOOKAHEAD = 0.15; // seconds
const TICK_MS = 25;

export class Engine extends EventTarget {
  constructor(ctx, buffer) {
    super();
    this.ctx = ctx;
    this.buffer = buffer;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.bpm = 120;
    this.offset = 0;
    this.granularity = 4; // pad size in beats
    this.quantize = 'pad'; // 'pad' | number of beats | 0 (off)
    this.mode = 'loop'; // 'loop' | 'oneshot' | 'gate'
    this.slices = [];
    this.current = null;
    this.pending = null;
    this.clockStart = null; // ctx time of grid phase 0
    this._timer = setInterval(() => this._tick(), TICK_MS);
  }

  get spb() { return 60 / this.bpm; }

  setBuffer(buffer) {
    this.stopAll(true);
    this.buffer = buffer;
    this._reslice();
  }

  setGrid(bpm, offset) {
    this.stopAll(true);
    this.bpm = bpm;
    this.offset = offset;
    this._reslice();
  }

  setGranularity(beats) {
    this.stopAll(true);
    this.granularity = beats;
    this._reslice();
  }

  _reslice() {
    const dur = this.buffer.duration;
    const sliceLen = this.granularity * this.spb;
    this.slices = [];
    let i = 0;
    for (let t = this.offset; t + sliceLen * 0.5 <= dur; t += sliceLen, i++) {
      this.slices.push({
        index: i,
        start: t,
        dur: Math.min(sliceLen, dur - t),
        startBeat: this.granularity * i,
        endBeat: this.granularity * (i + 1),
      });
    }
    this.dispatchEvent(new CustomEvent('slices'));
  }

  _quantizeSec() {
    const q = this.quantize === 'pad' ? this.granularity : this.quantize;
    return q * this.spb;
  }

  trigger(i) {
    if (!this.slices[i]) return;
    const now = this.ctx.currentTime;
    const qs = this._quantizeSec();
    let when;
    if (this.clockStart == null) {
      when = now + 0.06;
      this.clockStart = when;
    } else if (qs <= 0) {
      when = now + 0.02;
    } else {
      const n = Math.max(0, Math.ceil((now + 0.05 - this.clockStart) / qs));
      when = this.clockStart + n * qs;
    }
    if (this.pending && !this.pending.scheduled && this.pending.index !== i) {
      this._setState(this.pending.index, 'idle');
    }
    this.pending = { index: i, when, scheduled: false };
    this._setState(i, 'queued');
  }

  release(i) {
    if (this.mode !== 'gate') return;
    if (this.pending && this.pending.index === i && !this.pending.scheduled) {
      this.pending = null;
      this._setState(i, 'idle');
      return;
    }
    if (this.current && this.current.index === i) {
      this._stopCurrent(this.ctx.currentTime + 0.01);
    }
  }

  stopAll(resetClock = false) {
    if (this.pending) {
      const idx = this.pending.index;
      this.pending = null;
      this._setState(idx, 'idle');
    }
    if (this.current) this._stopCurrent(this.ctx.currentTime + 0.01);
    if (resetClock) this.clockStart = null;
  }

  _tick() {
    const p = this.pending;
    if (!p || p.scheduled) return;
    const now = this.ctx.currentTime;
    if (p.when - now >= LOOKAHEAD) return;
    p.scheduled = true;
    const slice = this.slices[p.index];
    if (!slice) { this.pending = null; return; }
    const when = Math.max(p.when, now + 0.005);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    const gain = this.ctx.createGain();
    src.connect(gain);
    gain.connect(this.master);
    if (this.mode === 'oneshot') {
      src.start(when, slice.start, slice.dur + 0.01);
      gain.gain.setValueAtTime(1, when);
      gain.gain.setValueAtTime(1, when + Math.max(0.005, slice.dur - 0.005));
      gain.gain.linearRampToValueAtTime(0, when + slice.dur + 0.005);
    } else {
      src.loop = true;
      src.loopStart = slice.start;
      src.loopEnd = slice.start + slice.dur;
      src.start(when, slice.start);
    }
    if (this.current) this._stopCurrent(when);
    const cur = { index: p.index, src, gain, startTime: when, slice };
    src.onended = () => {
      if (this.current === cur) {
        this.current = null;
        this._setState(cur.index, 'idle');
      }
    };
    this.current = cur;
    this.pending = null;
    const delay = Math.max(0, (when - now) * 1000);
    setTimeout(() => {
      if (this.current === cur) this._setState(cur.index, 'playing');
    }, delay);
  }

  _stopCurrent(when) {
    const c = this.current;
    if (!c) return;
    this.current = null;
    const now = this.ctx.currentTime;
    try {
      c.gain.gain.setValueAtTime(1, Math.max(when - 0.004, now));
      c.gain.gain.linearRampToValueAtTime(0, when + 0.004);
      c.src.onended = null;
      c.src.stop(when + 0.01);
    } catch (e) { /* already stopped */ }
    setTimeout(() => this._setState(c.index, 'idle'), Math.max(0, (when - now) * 1000));
  }

  // Track-time of the playhead, or null when nothing is playing.
  position() {
    const c = this.current;
    if (!c) return null;
    const now = this.ctx.currentTime;
    if (now < c.startTime) return c.slice.start;
    const el = now - c.startTime;
    if (c.src.loop) return c.slice.start + (el % c.slice.dur);
    return Math.min(c.slice.start + el, c.slice.start + c.slice.dur);
  }

  _setState(index, state) {
    this.dispatchEvent(new CustomEvent('pad', { detail: { index, state } }));
  }
}
