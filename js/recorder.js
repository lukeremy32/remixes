// Records the master output to a 16-bit WAV blob. Uses an AudioWorklet when
// available, falling back to ScriptProcessorNode (older mobile Safari).
export class Recorder {
  constructor(ctx, sourceNode) {
    this.ctx = ctx;
    this.source = sourceNode;
    this.chunksL = [];
    this.chunksR = [];
    this.recording = false;
    this.node = null;
    this.fallback = false;
  }

  async init() {
    try {
      await this.ctx.audioWorklet.addModule('js/recorder-worklet.js');
      this.node = new AudioWorkletNode(this.ctx, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this.node.port.onmessage = (e) => {
        if (!this.recording) return;
        this.chunksL.push(new Float32Array(e.data.l));
        this.chunksR.push(new Float32Array(e.data.r));
      };
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(mute);
      mute.connect(this.ctx.destination);
    } catch (e) {
      this.fallback = true;
      const sp = this.ctx.createScriptProcessor(4096, 2, 2);
      sp.onaudioprocess = (ev) => {
        if (!this.recording) return;
        this.chunksL.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
        this.chunksR.push(new Float32Array(ev.inputBuffer.getChannelData(1)));
      };
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.source.connect(sp);
      sp.connect(mute);
      mute.connect(this.ctx.destination);
      this.node = sp;
    }
  }

  start() {
    this.chunksL = [];
    this.chunksR = [];
    this.recording = true;
    if (!this.fallback) this.node.port.postMessage('start');
  }

  async stop() {
    if (!this.fallback) this.node.port.postMessage('stop');
    // Let in-flight worklet messages drain.
    await new Promise((r) => setTimeout(r, 120));
    this.recording = false;
    const left = concat(this.chunksL);
    const right = concat(this.chunksR);
    this.chunksL = [];
    this.chunksR = [];
    return encodeWav(left, right, this.ctx.sampleRate);
  }
}

function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function encodeWav(left, right, sampleRate) {
  const numFrames = left.length;
  const bytesPerSample = 2;
  const numChannels = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < numFrames; i++) {
    let l = Math.max(-1, Math.min(1, left[i]));
    let r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(o, l < 0 ? l * 0x8000 : l * 0x7fff, true); o += 2;
    view.setInt16(o, r < 0 ? r * 0x8000 : r * 0x7fff, true); o += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}
