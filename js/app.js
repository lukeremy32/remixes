import * as A from './analysis.js';
import { Engine } from './engine.js';
import { Recorder } from './recorder.js';

const TRACK_URL = 'Track001_remix_130bpm_pitchup3.mp3';
const PAGE_BARS = 16;
const KEY_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const KEYMAP = KEY_ROWS.join('').split('');

const $ = (s) => document.querySelector(s);

const state = {
  ctx: null,
  buffer: null,
  mono: null,
  name: '',
  bpm: 130,
  offset: 0,
  chromas: null,
  nBeats: 0,
  trackKey: null,
  padKeys: [],
  page: 0,
  refIndex: null, // reference pad for compatibility highlighting
  highlight: true,
  engine: null,
  recorder: null,
  recStart: 0,
  recTimer: null,
  peaks: null,
  padEls: new Map(), // global pad index -> element (current page only)
};

// ---------- boot ----------

async function main() {
  wireControls();
  const AC = window.AudioContext || window.webkitAudioContext;
  state.ctx = new AC();
  const unlock = () => { if (state.ctx.state === 'suspended') state.ctx.resume(); };
  document.addEventListener('pointerdown', unlock, { capture: true });
  document.addEventListener('keydown', unlock, { capture: true });
  try {
    await loadTrack(TRACK_URL, TRACK_URL);
  } catch (e) {
    overlay(`Could not load ${TRACK_URL}: ${e.message}. Use "Load file" to pick a track.`, -1);
    console.error(e);
  }
  requestAnimationFrame(rafLoop);
}

async function loadTrack(source, name) {
  overlay('Loading track…', -1);
  let arrayBuf;
  if (source instanceof ArrayBuffer) {
    arrayBuf = source;
  } else {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    arrayBuf = await res.arrayBuffer();
  }
  overlay('Decoding audio…', -1);
  state.buffer = await state.ctx.decodeAudioData(arrayBuf);
  state.name = name;
  state.mono = A.monoMix(state.buffer);

  overlay('Detecting tempo…', -1);
  await tick();
  const sr = state.buffer.sampleRate;
  const { env, fr } = A.onsetEnvelope(state.mono, sr);
  const m = name.match(/(\d{2,3}(?:\.\d+)?)\s*bpm/i);
  state.bpm = m ? parseFloat(m[1]) : A.detectBPM(env, fr);
  state.offset = A.detectOffset(env, fr, state.bpm);
  $('#bpm').value = state.bpm;

  if (!state.engine) {
    state.engine = new Engine(state.ctx, state.buffer);
    state.engine.addEventListener('pad', (e) => onPadState(e.detail));
    state.engine.granularity = parseFloat($('#granularity').value);
    state.engine.quantize = parseQuantize($('#quantize').value);
    state.engine.mode = $('#mode').value;
    state.recorder = new Recorder(state.ctx, state.engine.master);
    await state.recorder.init();
  } else {
    state.engine.setBuffer(state.buffer);
  }

  state.peaks = null;
  state.page = 0;
  state.refIndex = null;
  await reanalyze();
}

async function reanalyze() {
  state.engine.setGrid(state.bpm, state.offset);
  overlay('Analyzing keys… 0%', 0);
  const { chromas, nBeats } = await A.computeBeatChromas(
    state.mono, state.buffer.sampleRate, state.bpm, state.offset,
    (p) => overlay(`Analyzing keys… ${Math.round(p * 100)}%`, p),
  );
  state.chromas = chromas;
  state.nBeats = nBeats;
  const all = new Float32Array(12);
  for (let b = 0; b < nBeats; b++) for (let i = 0; i < 12; i++) all[i] += chromas[b * 12 + i];
  state.trackKey = A.estimateKey(all);
  computePadKeys();
  renderInfo();
  renderPager();
  renderPads();
  drawWave();
  hideOverlay();
}

function computePadKeys() {
  const slices = state.engine.slices;
  state.padKeys = slices.map((s) =>
    state.chromas ? A.keyForRange(state.chromas, state.nBeats, s.startBeat, s.endBeat) : null,
  );
}

// ---------- controls ----------

function parseQuantize(v) { return v === 'pad' ? 'pad' : parseFloat(v); }

function wireControls() {
  $('#granularity').addEventListener('change', (e) => {
    state.engine.setGranularity(parseFloat(e.target.value));
    state.refIndex = null;
    computePadKeys();
    state.page = Math.min(state.page, Math.max(0, pageCount() - 1));
    renderPager();
    renderPads();
  });
  $('#quantize').addEventListener('change', (e) => {
    state.engine.quantize = parseQuantize(e.target.value);
  });
  $('#mode').addEventListener('change', (e) => {
    state.engine.mode = e.target.value;
    state.engine.stopAll();
  });
  $('#bpm').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (v >= 40 && v <= 240) { state.bpm = v; debounceReanalyze(); }
  });
  $('#offMinusBeat').addEventListener('click', () => nudgeOffset(-60 / state.bpm));
  $('#offPlusBeat').addEventListener('click', () => nudgeOffset(60 / state.bpm));
  $('#offMinus').addEventListener('click', () => nudgeOffset(-0.01));
  $('#offPlus').addEventListener('click', () => nudgeOffset(0.01));
  $('#stop').addEventListener('click', () => state.engine.stopAll(true));
  $('#rec').addEventListener('click', toggleRecord);
  $('#hl').addEventListener('change', (e) => { state.highlight = e.target.checked; updateCompat(); });
  $('#file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      await loadTrack(await f.arrayBuffer(), f.name);
    } catch (err) {
      overlay(`Could not load file: ${err.message}`, -1);
      setTimeout(hideOverlay, 3000);
    }
  });
  $('#prevPage').addEventListener('click', () => gotoPage(state.page - 1));
  $('#nextPage').addEventListener('click', () => gotoPage(state.page + 1));
  $('#wave').addEventListener('click', (e) => {
    if (!state.buffer) return;
    const rect = e.target.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * state.buffer.duration;
    gotoPage(Math.floor((t - state.offset) / pageDur()));
  });
  window.addEventListener('resize', () => { drawWave(); });
  document.addEventListener('keydown', (e) => {
    if (e.repeat || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === ' ') { e.preventDefault(); state.engine.stopAll(true); return; }
    const k = KEYMAP.indexOf(e.key.toLowerCase());
    if (k >= 0) padPress(pageStartIndex() + k);
  });
  document.addEventListener('keyup', (e) => {
    const k = KEYMAP.indexOf(e.key.toLowerCase());
    if (k >= 0 && state.engine) state.engine.release(pageStartIndex() + k);
  });
}

let reanalyzeTimer = null;
function debounceReanalyze() {
  clearTimeout(reanalyzeTimer);
  reanalyzeTimer = setTimeout(() => reanalyze(), 500);
}

function nudgeOffset(d) {
  state.offset = Math.max(0, state.offset + d);
  renderInfo();
  debounceReanalyze();
}

// ---------- paging ----------

function pageDur() { return PAGE_BARS * 4 * (60 / state.bpm); }
function padsPerPage() { return Math.round((PAGE_BARS * 4) / state.engine.granularity); }
function pageCount() { return Math.max(1, Math.ceil(state.engine.slices.length / padsPerPage())); }
function pageStartIndex() { return state.page * padsPerPage(); }

function gotoPage(p) {
  const np = Math.max(0, Math.min(p, pageCount() - 1));
  if (np === state.page) return;
  state.page = np;
  renderPager();
  renderPads();
}

// ---------- rendering ----------

function renderInfo() {
  const k = state.trackKey;
  $('#trackInfo').innerHTML =
    `<b>${esc(state.name)}</b> · ${state.buffer.duration.toFixed(1)}s · ` +
    `${state.bpm} BPM · offset ${(state.offset * 1000).toFixed(0)}ms` +
    (k ? ` · key <b>${k.name}</b> (${k.camelot})` : '');
}

function renderPager() {
  const total = Math.ceil(state.engine.slices.length * state.engine.granularity / 4);
  const b0 = state.page * PAGE_BARS + 1;
  const b1 = Math.min((state.page + 1) * PAGE_BARS, total);
  $('#pageLabel').textContent = `Bars ${b0}–${b1} of ${total}`;
  $('#prevPage').disabled = state.page === 0;
  $('#nextPage').disabled = state.page >= pageCount() - 1;
}

function renderPads() {
  const grid = $('#grid');
  grid.innerHTML = '';
  state.padEls.clear();
  const start = pageStartIndex();
  const end = Math.min(start + padsPerPage(), state.engine.slices.length);
  const gran = state.engine.granularity;
  for (let i = start; i < end; i++) {
    const slice = state.engine.slices[i];
    const key = state.padKeys[i];
    const el = document.createElement('button');
    el.className = 'pad';
    el.dataset.i = i;
    const bar = Math.floor(slice.startBeat / 4) + 1;
    const beat = Math.floor(slice.startBeat % 4) + 1;
    el.innerHTML =
      `<span class="pos">${gran >= 4 ? bar : `${bar}.${beat}`}</span>` +
      `<span class="key">${key ? key.name : '–'}</span>` +
      `<span class="cam">${key ? key.camelot : ''}</span>`;
    if (key) {
      el.style.setProperty('--h', String((key.pc / 12) * 360));
      if (key.minor) el.classList.add('minor');
    }
    el.addEventListener('pointerdown', (ev) => { ev.preventDefault(); padPress(i); });
    el.addEventListener('pointerup', () => state.engine.release(i));
    el.addEventListener('pointercancel', () => state.engine.release(i));
    el.addEventListener('contextmenu', (ev) => ev.preventDefault());
    grid.appendChild(el);
    state.padEls.set(i, el);
  }
  // restore live states
  if (state.engine.current) markPad(state.engine.current.index, 'playing');
  if (state.engine.pending) markPad(state.engine.pending.index, 'queued');
  updateCompat();
}

function padPress(i) {
  if (!state.engine || !state.engine.slices[i]) return;
  if (state.ctx.state === 'suspended') state.ctx.resume();
  state.engine.trigger(i);
  state.refIndex = i;
  updateCompat();
}

function onPadState({ index, state: st }) {
  markPad(index, st);
}

function markPad(index, st) {
  const el = state.padEls.get(index);
  if (!el) return;
  el.classList.toggle('playing', st === 'playing');
  el.classList.toggle('queued', st === 'queued');
}

function updateCompat() {
  const ref = state.refIndex != null ? state.padKeys[state.refIndex] : null;
  const active = state.highlight && ref;
  for (const [i, el] of state.padEls) {
    const k = state.padKeys[i];
    const isRef = i === state.refIndex;
    const comp = active && !isRef && A.compatible(ref, k);
    el.classList.toggle('ref', Boolean(active && isRef));
    el.classList.toggle('comp', Boolean(comp));
    el.classList.toggle('dim', Boolean(active && !isRef && !comp));
  }
}

// ---------- waveform ----------

function drawWave() {
  const canvas = $('#wave');
  if (!state.buffer) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  if (!state.peaks || state.peaks.length !== w * 2) {
    const mono = state.mono;
    const peaks = new Float32Array(w * 2);
    const spp = mono.length / w;
    for (let x = 0; x < w; x++) {
      let mn = 0, mx = 0;
      const s0 = Math.floor(x * spp);
      const s1 = Math.min(mono.length, Math.floor((x + 1) * spp));
      for (let s = s0; s < s1; s += 8) {
        const v = mono[s];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      peaks[x * 2] = mn;
      peaks[x * 2 + 1] = mx;
    }
    state.peaks = peaks;
  }
  // page window
  const dur = state.buffer.duration;
  const p0 = ((state.offset + state.page * pageDur()) / dur) * w;
  const p1 = ((state.offset + (state.page + 1) * pageDur()) / dur) * w;
  g.fillStyle = 'rgba(120,180,255,0.15)';
  g.fillRect(p0, 0, Math.min(p1, w) - p0, h);
  g.fillStyle = '#5b8fd6';
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const mn = state.peaks[x * 2] * mid;
    const mx = state.peaks[x * 2 + 1] * mid;
    g.fillRect(x, mid - mx, 1, Math.max(1, mx - mn));
  }
}

function rafLoop() {
  const canvas = $('#playheadLayer');
  if (state.buffer && state.engine) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const pos = state.engine.position();
    if (pos != null) {
      const x = (pos / state.buffer.duration) * w;
      g.fillStyle = '#ffd45e';
      g.fillRect(x - 1, 0, 2, h);
    }
  }
  requestAnimationFrame(rafLoop);
}

// ---------- recording ----------

async function toggleRecord() {
  const btn = $('#rec');
  if (!state.recorder) return;
  if (!state.recorder.recording) {
    if (state.ctx.state === 'suspended') await state.ctx.resume();
    state.recorder.start();
    state.recStart = performance.now();
    btn.classList.add('recording');
    state.recTimer = setInterval(() => {
      const s = (performance.now() - state.recStart) / 1000;
      btn.textContent = `■ ${s.toFixed(0)}s`;
    }, 250);
    btn.textContent = '■ 0s';
  } else {
    clearInterval(state.recTimer);
    btn.classList.remove('recording');
    btn.textContent = '● Rec';
    const blob = await state.recorder.stop();
    addRecording(blob);
  }
}

function addRecording(blob) {
  const d = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const name = `beatpad-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.wav`;
  const url = URL.createObjectURL(blob);
  const li = document.createElement('li');
  const sizeMb = (blob.size / 1048576).toFixed(1);
  li.innerHTML =
    `<span class="recName">${name} <small>(${sizeMb} MB)</small></span>` +
    `<audio controls src="${url}"></audio>` +
    `<a class="btn dl" href="${url}" download="${name}">Download</a>` +
    `<button class="btn del">✕</button>`;
  li.querySelector('.del').addEventListener('click', () => {
    URL.revokeObjectURL(url);
    li.remove();
  });
  $('#recList').prepend(li);
  $('#recordings').classList.remove('empty');
}

// ---------- misc ----------

function overlay(msg, progress) {
  const ov = $('#overlay');
  ov.classList.remove('hidden');
  $('#overlayMsg').textContent = msg;
  const bar = $('#overlayBar');
  bar.style.display = progress >= 0 ? 'block' : 'none';
  if (progress >= 0) $('#overlayFill').style.width = `${Math.round(progress * 100)}%`;
}

function hideOverlay() { $('#overlay').classList.add('hidden'); }

function tick() { return new Promise((r) => setTimeout(r, 0)); }

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

main();
