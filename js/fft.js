// Minimal iterative radix-2 FFT (in-place, forward transform).
export class FFT {
  constructor(n) {
    this.n = n;
    this.levels = Math.log2(n) | 0;
    if (1 << this.levels !== n) throw new Error('FFT size must be a power of 2');
    this.cosT = new Float32Array(n / 2);
    this.sinT = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cosT[i] = Math.cos((2 * Math.PI * i) / n);
      this.sinT[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let j = 0; j < this.levels; j++) r = (r << 1) | ((i >>> j) & 1);
      this.rev[i] = r;
    }
  }

  forward(re, im) {
    const { n, rev, cosT, sinT } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = cosT[k], s = sinT[k];
          const tre = re[l] * c + im[l] * s;
          const tim = im[l] * c - re[l] * s;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }
}
