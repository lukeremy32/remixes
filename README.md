# remixes — Smart Beat Pad

A DJ-style quantized beat pad that slices a track into pads you can chop and
loop live. Runs entirely in the browser (Web Audio API), works on desktop and
mobile, no build step.

It boots with `Track001_remix_130bpm_pitchup3.mp3` from this repo (BPM is read
from the filename; otherwise it's auto-detected), and you can load any other
audio file with the **Load file** button.

## Run it

Any static file server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

For phone testing, either open your computer's LAN IP from the phone, or enable
**GitHub Pages** for this repo (Settings → Pages → deploy from branch) and open
the Pages URL on your phone.

## Features

- **Quantized launching** — pressing a pad queues it and it starts exactly on
  the next quantize boundary (like Ableton session clips), so chops always stay
  on the grid. Launch quantize is selectable (4 bars … 1/16 bar, or off).
- **Smart granularity** — choose the pad size (4 bars, 2 bars, 1 bar, 1/2,
  1/4, 1/8, 1/16 bar) and the pad grid regenerates from the beat grid.
- **Downbeat-aware chopping** — the bar downbeat is detected (strongest
  onset phase across every 4th beat) and pads clip on downbeats by default.
  The **Stagger** control intentionally shifts all pads off the bar
  (+1/16 bar … +3 beats) for off-grid chops.
- **Independent loop length** — the **Loop** control sets how much of a pad
  repeats, regardless of pad size: a 4-bar pad can roll just its first bar,
  beat, or 1/16. It applies live to the playing pad (beat-repeat style);
  re-pressing the pad re-syncs it to the grid.
- **Key detection per pad** — each pad's root key is estimated from a
  chromagram + Krumhansl-Schmuckler key profiles. Pads are colored by root
  key and labeled with the key name and Camelot code (e.g. `Am · 8A`).
- **In-key suggestions** — the last pad you hit becomes the reference: pads
  that are harmonically compatible (same key, relative major/minor, or a
  perfect fifth apart — Camelot neighbours) get a gold ring, the rest dim.
- **Play modes** — Loop (latch), One-shot, and Gate (plays while held).
- **Grid controls** — BPM is editable, and the grid offset can be nudged by
  ±10 ms or shifted a whole beat if the downbeat lands wrong.
- **Record & download** — hit **● Rec**, jam, hit stop, and the performance
  appears under Recordings as a WAV you can play back and download (works on
  mobile too — on iOS the share sheet opens so you can save to Files).
- **Keyboard play** on desktop: rows `1–0`, `q–p`, `a–l`, `z–m` trigger the
  pads on the current page; Space stops.

## Files

- `index.html`, `style.css` — UI
- `js/app.js` — app wiring, pads, waveform, paging, recordings
- `js/engine.js` — quantized Web Audio playback engine
- `js/analysis.js` — BPM/offset detection, chromagrams, key estimation,
  harmonic compatibility
- `js/fft.js` — radix-2 FFT
- `js/recorder.js`, `js/recorder-worklet.js` — WAV recorder
