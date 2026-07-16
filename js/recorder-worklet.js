// AudioWorklet processor that captures raw PCM from its input while armed.
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rec = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') this.rec = true;
      else if (e.data === 'stop') this.rec = false;
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (this.rec && input && input.length) {
      const l = input[0].slice(0);
      const r = (input[1] || input[0]).slice(0);
      this.port.postMessage({ l: l.buffer, r: r.buffer }, [l.buffer, r.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-capture', PCMCapture);
