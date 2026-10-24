// ============================================================
// AUDIO ENGINE + SAMPLES + SOUNDFONT 2
// ============================================================
//
// Extracted from chord-pad.js as a separate script file. Loaded BEFORE
// chord-pad.js (and after midi.js) in the HTML so all the audio
// primitives are defined by the time chord-pad.js's startup block calls
// them.
//
// Cross-file dependencies (resolved at runtime via window scope):
//   state                                    (global state object)
//   INSTRUMENT_PRESETS, applySynthPreset     (defined later in chord-pad.js)
//   withSynth                                (defined later in chord-pad.js)
//   SoundFont2                               (from vendor/soundfont2.js)
//
// Public surface used by the rest of the app:
//   getAudioCtx, startAudioNote, stopAudioNote, startBassNote, midiToFreq
//   preloadSamples, preloadSamplesOnGesture, loadSf2, prewarmSf2Preset
//   instrumentDisplayName, INSTRUMENT_TO_SF2, GM_CATEGORIES, SF2_FILES
//
// Top-level side effect: schedules `loadSf2('fluid')` on the next tick so
// the soundfont starts streaming as soon as the page is ready.

// ============================================================
// WEB AUDIO ENGINE
// ============================================================
let audioCtx = null;

function _buildAudioCtx() {
  // iOS: unlock audio stack before creating context
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    const dummy = document.createElement('audio');
    dummy.src = 'data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA//////////////////////////////////////////////////////////////////8AAABhTEFNRTMuMTAwA8MAAAAAAAAAABQgJAUHQQAB9AAAAnGMHkkIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//sQxAADgnABGiAAQBCqgCRMAAgEAH///////////////7+n/9FTuQsQH//////2NG0jWUGlio5gLQTOtIoeR2WX////X4s9Atb/JRVCbBUpeRUq//////////////////9RUi0f2jn/+xDECgPCjAEQAABN4AAANIAAAAQVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==';
    dummy.play().catch(() => {});
    dummy.pause();
  }
  // latencyHint: 0 (numeric) is interpreted as "target output latency in
  // seconds" → asks for the absolute minimum. The string 'interactive' is
  // looser. sampleRate 48000 matches typical hardware in Chrome and skips
  // a resampling stage; Firefox doesn't honour custom rates so let it pick.
  const isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || '');
  const ctxOpts = { latencyHint: 0 };
  if (!isFirefox) ctxOpts.sampleRate = 48000;
  const ctx = new (window.AudioContext || window.webkitAudioContext)(ctxOpts);
  // Master gain BEFORE the compressor — keeps the summed voice signal
  // below 0 dB so transients on 4+ note chords don't overshoot the
  // compressor input and crackle. Voices connect to ctx._out (this gain).
  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.5;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -8;
  comp.ratio.value = 6;
  comp.attack.value = 0.002;
  comp.release.value = 0.20;
  masterGain.connect(comp);
  comp.connect(ctx.destination);
  ctx._out = masterGain;
  // Reverb (synthetic impulse response)
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 2.5);
  const impulse = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = impulse.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
  }
  const conv = ctx.createConvolver();
  conv.buffer = impulse;
  const reverbWet = ctx.createGain();
  reverbWet.gain.value = state.synth.reverb;
  conv.connect(reverbWet);
  reverbWet.connect(ctx._out);
  ctx._reverb    = conv;
  ctx._reverbWet = reverbWet;
  // Delay
  const delay = ctx.createDelay(2.0);
  delay.delayTime.value = state.synth.delayTime;
  const delayFb = ctx.createGain();
  delayFb.gain.value = state.synth.delayFeedback;
  const delayWet = ctx.createGain();
  delayWet.gain.value = state.synth.delayWet;
  delay.connect(delayFb); delayFb.connect(delay);
  delay.connect(delayWet); delayWet.connect(ctx._out);
  ctx._delay    = delay;
  ctx._delayFb  = delayFb;
  ctx._delayWet = delayWet;
  return ctx;
}
// Prime the audio graph + JIT-compile the per-voice code paths so the
// first real note doesn't run cold. Two stages:
//   1. Quick silent oscillator → exercises the compressor / reverb /
//      delay chain so its internal state (history buffers, etc.) is
//      no longer at zero.
//   2. A handful of silent SF2/sample voices over ~600 ms — runs the
//      real startAudioNote / startSf2Voice code path with audioVolume
//      forced to 0, letting V8 optimise the hot loops while the user
//      is still finding the Play button. Without this the first
//      seconds of playback after a refresh sound soft + glitchy
//      until the JIT catches up.
function _warmupAudioGraph(ctx) {
  const wo = ctx.createOscillator();
  const wg = ctx.createGain(); wg.gain.value = 0;
  wo.connect(wg); wg.connect(ctx._out);
  wo.start(); wo.stop(ctx.currentTime + 0.01);
  // Stage 2 — silent voice warmup. Defer one tick so the chord-pad.js
  // globals (state, startAudioNote) are available regardless of script
  // load order.
  setTimeout(() => {
    if (typeof state === 'undefined' || typeof startAudioNote !== 'function') return;
    const savedVolume = state.audioVolume;
    state.audioVolume = 0; // every voice's peak gain = 0 → completely silent
    try {
      const t0 = ctx.currentTime + 0.02;
      // Five C-major notes spread over 100 ms, each lasting ~120 ms.
      [60, 62, 64, 65, 67].forEach((m, i) => {
        try {
          const n = startAudioNote(m, 1, t0 + i * 0.02);
          setTimeout(() => { try { stopAudioNote(n); } catch (_) {} }, 150 + i * 20);
        } catch (_) {}
      });
    } finally {
      // Restore volume after the warmup voices have fired (their peak
      // captures the value at start-time, so they stay silent).
      setTimeout(() => { state.audioVolume = savedVolume; }, 50);
    }
  }, 0);
}

// Release audio device cleanly on page unload so Windows doesn't get stuck
window.addEventListener('beforeunload', () => { audioCtx?.close(); });

// Browsers refuse to start an AudioContext until the user has
// interacted with the page; calling .resume() before that point logs
// a console warning every time getAudioCtx() runs (which is dozens of
// times during SF2 prewarm). Gate the resume on a flag that flips on
// the first user gesture. After that point, getAudioCtx() resumes
// freely so auto-suspend after tab-blur still recovers on next click.
let _audioCtxUnlocked = false;
function getAudioCtx() {
  if (audioCtx?.state === 'closed') audioCtx = null;
  if (!audioCtx) audioCtx = _buildAudioCtx();
  if (_audioCtxUnlocked && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}
function _unlockAudioCtxOnGesture() {
  _audioCtxUnlocked = true;
  if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
  if (audioCtx) _warmupAudioGraph(audioCtx);
  _drainPreloadQueue();
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    window.removeEventListener(ev, _unlockAudioCtxOnGesture, true)
  );
}
['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
  window.addEventListener(ev, _unlockAudioCtxOnGesture, true)
);

function midiToFreq(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

// ============================================================
// SAMPLE INSTRUMENTS
// ============================================================
// All 88 semitones A0–C8
const SAMPLE_MIDIS = Array.from({length: 88}, (_, i) => i + 21);
const SOUNDFONT_BASE = 'https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/FluidR3_GM/';
const SAMPLE_DEFS = {
  piano:   { dir: 'acoustic_grand_piano-mp3', decay: true },
  epiano:  { dir: 'electric_piano_1-mp3',     decay: true },
  epiano2: { dir: 'electric_piano_2-mp3',     decay: true },
  organ:   { dir: 'drawbar_organ-mp3' },
  strings: { dir: 'string_ensemble_1-mp3' },
  choir:   { dir: 'choir_aahs-mp3' },
  vibes:   { dir: 'vibraphone-mp3',           decay: true },
  pad:     { dir: 'pad_2_warm-mp3' },
};
const sampleCache = Object.fromEntries(Object.keys(SAMPLE_DEFS).map(k => [k, {}]));

function midiToSampleName(midi) {
  const names = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
  return names[midi % 12] + (Math.floor(midi / 12) - 1);
}

function nearestSampleMidi(instrument, midiNote) {
  return SAMPLE_MIDIS.reduce((best, m) => Math.abs(m - midiNote) < Math.abs(best - midiNote) ? m : best, SAMPLE_MIDIS[0]);
}

function fetchSample(instrument, midiNote) {
  if (!sampleCache[instrument]) return Promise.resolve(null);
  const cached = sampleCache[instrument][midiNote];
  if (cached instanceof AudioBuffer) return Promise.resolve(cached);
  if (cached instanceof Promise) return cached;
  const url = SOUNDFONT_BASE + SAMPLE_DEFS[instrument].dir + '/' + midiToSampleName(midiNote) + '.mp3';
  const p = new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 0) {
        getAudioCtx().decodeAudioData(xhr.response,
          decoded => { sampleCache[instrument][midiNote] = decoded; resolve(decoded); },
          err     => { console.error('decode failed', url, err); sampleCache[instrument][midiNote] = null; resolve(null); }
        );
      } else {
        console.error('load failed', url, xhr.status);
        sampleCache[instrument][midiNote] = null;
        resolve(null);
      }
    };
    xhr.onerror = () => { console.error('xhr error', url); sampleCache[instrument][midiNote] = null; resolve(null); };
    xhr.send();
  });
  sampleCache[instrument][midiNote] = p;
  return p;
}

// Queue instrument preloads until the first user gesture unlocks the
// AudioContext. Without this, fetchSample's XHR onload calls
// decodeAudioData → getAudioCtx → new AudioContext() before any user
// interaction and Chrome logs the autoplay-blocked warning. After the
// first gesture, the queue drains and subsequent calls hit
// preloadSamples directly.
const _preloadQueue = new Set();
function preloadSamplesOnGesture(instrument) {
  if (_audioCtxUnlocked) return preloadSamples(instrument);
  _preloadQueue.add(instrument);
}
function _drainPreloadQueue() {
  const insts = [..._preloadQueue];
  _preloadQueue.clear();
  for (const i of insts) preloadSamples(i);
}
// Kick off the (large) SF2 download right away — fetch alone doesn't
// touch the AudioContext; decoding happens lazily per-note when the
// user actually plays something.
setTimeout(() => loadSf2('fluid'), 0);

async function preloadSamples(instrument) {
  const el = document.getElementById('synth-loading');
  el.style.color = 'var(--accent)';
  el.style.display = '';
  const midis = SAMPLE_MIDIS;
  let done = 0;
  el.textContent = `loading 0/${midis.length}…`;
  await Promise.all(midis.map(m => fetchSample(instrument, m).then(r => {
    done++;
    el.textContent = `loading ${done}/${midis.length}…`;
    return r;
  })));
  const failed = midis.filter(m => !sampleCache[instrument][m]);
  if (failed.length) {
    el.style.color = '#f55'; el.textContent = `${failed.length} samples failed (check console)`;
  } else {
    el.style.display = 'none';
  }
}

function startSampleNote(midiNote, velocity, at = null, autoRelease = null, instrumentOverride = null) {
  const instrument = instrumentOverride ?? state.instrument;
  const ctx = getAudioCtx();
  const t = at ?? ctx.currentTime;
  const s = state.synth;
  const sampleMidi = nearestSampleMidi(instrument, midiNote);
  const buffer = sampleCache[instrument][sampleMidi];
  if (!(buffer instanceof AudioBuffer)) return null;

  const playbackRate = Math.pow(2, (midiNote - sampleMidi) / 12);
  const peak = (velocity / 127) * state.audioVolume * 6;

  const sampleDuration = buffer.duration / playbackRate;
  const sustainStart   = t + s.attack + s.decay;
  const naturalEnd     = t + sampleDuration;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + s.attack);
  env.gain.exponentialRampToValueAtTime(Math.max(peak * s.sustain, 0.0001), sustainStart);
  env.gain.setValueAtTime(peak * s.sustain, sustainStart);
  // Sample has a finite duration: fade the envelope so the buffer ending
  // doesn't sound like an abrupt cutoff.
  if (naturalEnd > sustainStart) {
    if (SAMPLE_DEFS[instrument].decay) {
      // Decay instruments (piano, e-piano, vibes): one long linear taper —
      // matches the sample's own decay shape.
      env.gain.linearRampToValueAtTime(0.0001, naturalEnd);
    } else {
      // Sustained instruments (organ, strings, choir, pad): hold the
      // sustain plateau, then fade out over the final ~0.4 s of the sample.
      const fadeDur   = 0.4;
      const fadeStart = Math.max(sustainStart + 0.05, naturalEnd - fadeDur);
      env.gain.setValueAtTime(peak * s.sustain, fadeStart);
      env.gain.linearRampToValueAtTime(0.0001, naturalEnd);
    }
  }
  env.connect(ctx._out);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = s.filterFreq; lp.Q.value = s.filterQ;
  const tremGain = ctx.createGain(); tremGain.gain.value = 1;
  lp.connect(tremGain); tremGain.connect(env);

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = playbackRate;
  src.loop = false;
  src.connect(lp);

  if (ctx._reverb) {
    ctx._reverbWet.gain.value = s.reverb;
    const rs = ctx.createGain(); rs.gain.value = 0.5;
    env.connect(rs); rs.connect(ctx._reverb);
  }
  if (ctx._delay) {
    ctx._delay.delayTime.value = s.delayTime;
    ctx._delayFb.gain.value = s.delayFeedback;
    ctx._delayWet.gain.value = s.delayWet;
    env.connect(ctx._delay);
  }

  const oscs = [src];
  if (s.tremoloDepth > 0) {
    tremGain.gain.value = 1 - s.tremoloDepth * 0.5;
    const tLfo = ctx.createOscillator(); tLfo.frequency.value = s.tremoloRate;
    const tg = ctx.createGain(); tg.gain.value = s.tremoloDepth * 0.5;
    tLfo.connect(tg); tg.connect(tremGain.gain); tLfo.start(t); oscs.push(tLfo);
  }
  if (s.filterLfoDepth > 0) {
    const fLfo = ctx.createOscillator(); fLfo.frequency.value = 1.0;
    const fg = ctx.createGain(); fg.gain.value = s.filterLfoDepth;
    fLfo.connect(fg); fg.connect(lp.frequency); fLfo.start(t); oscs.push(fLfo);
  }

  if (state.pitchBendCents) src.detune.value = state.pitchBendCents;
  src.start(t);
  const sampleNode = { oscs, env, startTime: t, peak };
  if (autoRelease !== null) {
    const rel = t + autoRelease;
    const relDur = 0.05;
    sampleNode.env.gain.setValueAtTime(peak * s.sustain, rel);
    sampleNode.env.gain.exponentialRampToValueAtTime(0.0001, rel + relDur);
    src.stop(rel + relDur + 0.005);
  }
  return sampleNode;
}

function startAudioNote(midiNote, velocity, at = null, autoRelease = null, instrumentOverride = null) {
  const instrument = instrumentOverride ?? state.instrument;
  // Try the SF2 path for instruments we have a GM mapping for. If the SF2
  // isn't loaded yet, kick off the load and fall back to the MP3 sampler
  // until it arrives.
  const sf2Preset = INSTRUMENT_TO_SF2[instrument];
  if (sf2Preset != null) {
    const entry = SF2_FILES.fluid;
    if (entry.sf2) {
      const n = startSf2Voice(midiNote, velocity, at, autoRelease, entry.sf2, sf2Preset);
      if (n) return n;
    } else {
      loadSf2('fluid');
    }
  }
  if (instrument !== 'synth') return startSampleNote(midiNote, velocity, at, autoRelease, instrument);
  const ctx = getAudioCtx();
  const t   = at ?? ctx.currentTime;
  const s   = state.synth;
  const freq = midiToFreq(midiNote);
  const peak = (velocity / 127) * state.audioVolume * 0.6;

  // Envelope
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + s.attack);
  env.gain.exponentialRampToValueAtTime(Math.max(peak * s.sustain, 0.0001), t + s.attack + s.decay);
  env.gain.setValueAtTime(peak * s.sustain, t + s.attack + s.decay);
  env.connect(ctx._out);

  // Filter
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = s.filterFreq;
  lp.Q.value = s.filterQ;

  // Tremolo gain sits between filter and env (gain=1 = no effect)
  const tremGain = ctx.createGain();
  tremGain.gain.value = 1;
  lp.connect(tremGain);
  tremGain.connect(env);

  // Pre-filter mix gain keeps summed oscillators below 1.0
  const mix = ctx.createGain();
  mix.gain.value = 0.42;
  mix.connect(lp);

  // Oscillators
  const osc1 = ctx.createOscillator();
  osc1.type = s.waveform;
  osc1.frequency.value = freq;
  osc1.connect(mix);

  const osc2 = ctx.createOscillator();
  osc2.type = 'triangle';
  osc2.frequency.value = freq * 2;
  const g2 = ctx.createGain(); g2.gain.value = s.overtones * 0.65;
  osc2.connect(g2); g2.connect(mix);

  const osc3 = ctx.createOscillator();
  osc3.type = 'sine';
  osc3.frequency.value = freq * 3;
  const g3 = ctx.createGain(); g3.gain.value = s.overtones * 0.22;
  osc3.connect(g3); g3.connect(mix);

  // Reverb send
  if (ctx._reverb) {
    ctx._reverbWet.gain.value = s.reverb;
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.5;
    env.connect(reverbSend);
    reverbSend.connect(ctx._reverb);
  }

  // Delay send
  if (ctx._delay) {
    ctx._delay.delayTime.value = s.delayTime;
    ctx._delayFb.gain.value    = s.delayFeedback;
    ctx._delayWet.gain.value   = s.delayWet;
    env.connect(ctx._delay);
  }

  // Collect pitch oscs for vibrato targeting
  const oscs = [osc1, osc2, osc3];

  // Detuned pair for chorus/pad width
  if (s.detune > 0) {
    const oscA = ctx.createOscillator(); oscA.type = 'sine';
    oscA.frequency.value = freq; oscA.detune.value = s.detune;
    const oscB = ctx.createOscillator(); oscB.type = 'sine';
    oscB.frequency.value = freq; oscB.detune.value = -s.detune;
    const dg = ctx.createGain(); dg.gain.value = 0.45;
    oscA.connect(dg); oscB.connect(dg); dg.connect(mix);
    oscA.start(t); oscB.start(t);
    oscs.push(oscA, oscB);
  }

  // Vibrato LFO → all pitch osc detune params
  if (s.vibratoDepth > 0) {
    const vLfo = ctx.createOscillator();
    vLfo.frequency.value = s.vibratoRate;
    const vGain = ctx.createGain();
    vGain.gain.value = s.vibratoDepth;
    vLfo.connect(vGain);
    oscs.forEach(o => vGain.connect(o.detune));
    vLfo.start(t);
    oscs.push(vLfo);
  }

  // Tremolo LFO → tremGain.gain
  if (s.tremoloDepth > 0) {
    tremGain.gain.value = 1 - s.tremoloDepth * 0.5;
    const tLfo = ctx.createOscillator();
    tLfo.frequency.value = s.tremoloRate;
    const tLfoGain = ctx.createGain();
    tLfoGain.gain.value = s.tremoloDepth * 0.5;
    tLfo.connect(tLfoGain);
    tLfoGain.connect(tremGain.gain);
    tLfo.start(t);
    oscs.push(tLfo);
  }

  // Filter LFO
  if (s.filterLfoDepth > 0) {
    const fLfo = ctx.createOscillator();
    fLfo.frequency.value = 1.0;
    const fLfoGain = ctx.createGain();
    fLfoGain.gain.value = s.filterLfoDepth;
    fLfo.connect(fLfoGain);
    fLfoGain.connect(lp.frequency);
    fLfo.start(t);
    oscs.push(fLfo);
  }

  osc1.start(t); osc2.start(t); osc3.start(t);
  const synthNode = { oscs, env, startTime: t, peak };
  if (autoRelease !== null) {
    const rel = t + autoRelease;
    const relDur = Math.min(s.release * 0.4, 0.06);
    synthNode.env.gain.setValueAtTime(synthNode.peak * s.sustain, rel);
    synthNode.env.gain.exponentialRampToValueAtTime(0.0001, rel + relDur);
    synthNode.oscs.forEach(o => { try { o.stop(rel + relDur + 0.005); } catch(e) {} });
  }
  return synthNode;
}

// ============================================================
// SoundFont 2 (FluidR3_GM) playback path
// ============================================================
//
// We re-use the existing 8 instrument labels (piano / epiano / .../ pad),
// but route them through the SF2 voice so notes can actually sustain via
// the SF2's embedded sample loops, with proper per-preset filter, pan,
// envelope and tuning settings — i.e. how the soundfont author intended.

// FluidR3 is too big (148MB) for GitHub Pages to serve directly (it returns
// the Git-LFS pointer instead of the binary), and GitHub Release assets are
// CORS-blocked for cross-origin fetch. So the canonical copy lives in a
// public GCS bucket with CORS enabled. Local file:// / dev-server installs
// still have the LFS-pulled binary at sf2/FluidR3_GM.sf2 as a fallback.
const SF2_FILES = {
  fluid: {
    url: 'https://storage.googleapis.com/chord-pad-assets-2026/FluidR3_GM.sf2',
    fallbackUrl: 'sf2/FluidR3_GM.sf2',
    sf2: null, loading: null, total: 0, loaded: 0,
  },
};
const SF2_BUFFER_CACHE = new Map(); // sample object → AudioBuffer

// Map our instrument labels → GM program numbers in FluidR3_GM (bank 0)
const INSTRUMENT_TO_SF2 = {
  piano:   0,   // Yamaha Grand Piano
  epiano:  4,   // Rhodes EP
  epiano2: 5,   // Legend EP 2
  vibes:   11,  // Vibraphone
  organ:   16,  // Drawbar Organ
  strings: 48,  // Strings
  choir:   52,  // Ahh Choir
  pad:     89,  // Warm Pad
};

// Full General MIDI bank, grouped by category. Used to populate the
// per-track instrument picker. Each entry has the GM preset number and a
// display name; lookup IDs default to `gm<N>` unless a friendlier short
// name already exists in INSTRUMENT_TO_SF2 above.
const GM_CATEGORIES = [
  { name: 'Piano',       presets: [
    { n: 0, name: 'Acoustic Grand' }, { n: 1, name: 'Bright Acoustic' },
    { n: 2, name: 'Electric Grand' }, { n: 3, name: 'Honky-tonk' },
    { n: 4, name: 'Rhodes' }, { n: 5, name: 'Chorused EP' },
    { n: 6, name: 'Harpsichord' }, { n: 7, name: 'Clavinet' },
  ]},
  { name: 'Mallets',     presets: [
    { n: 8, name: 'Celesta' }, { n: 9, name: 'Glockenspiel' },
    { n: 10, name: 'Music Box' }, { n: 11, name: 'Vibraphone' },
    { n: 12, name: 'Marimba' }, { n: 13, name: 'Xylophone' },
    { n: 14, name: 'Tubular Bells' }, { n: 15, name: 'Dulcimer' },
  ]},
  { name: 'Organ',       presets: [
    { n: 16, name: 'Drawbar' }, { n: 17, name: 'Percussive' },
    { n: 18, name: 'Rock' }, { n: 19, name: 'Church' },
    { n: 20, name: 'Reed' }, { n: 21, name: 'Accordion' },
    { n: 22, name: 'Harmonica' }, { n: 23, name: 'Tango Accordion' },
  ]},
  { name: 'Guitar',      presets: [
    { n: 24, name: 'Nylon' }, { n: 25, name: 'Steel' },
    { n: 26, name: 'Jazz' }, { n: 27, name: 'Clean Electric' },
    { n: 28, name: 'Muted' }, { n: 29, name: 'Overdrive' },
    { n: 30, name: 'Distortion' }, { n: 31, name: 'Harmonics' },
  ]},
  { name: 'Bass',        presets: [
    { n: 32, name: 'Acoustic' }, { n: 33, name: 'Fingered' },
    { n: 34, name: 'Picked' }, { n: 35, name: 'Fretless' },
    { n: 36, name: 'Slap 1' }, { n: 37, name: 'Slap 2' },
    { n: 38, name: 'Synth Bass 1' }, { n: 39, name: 'Synth Bass 2' },
  ]},
  { name: 'Strings',     presets: [
    { n: 40, name: 'Violin' }, { n: 41, name: 'Viola' },
    { n: 42, name: 'Cello' }, { n: 43, name: 'Contrabass' },
    { n: 44, name: 'Tremolo Strings' }, { n: 45, name: 'Pizzicato' },
    { n: 46, name: 'Harp' }, { n: 47, name: 'Timpani' },
  ]},
  { name: 'Ensemble',    presets: [
    { n: 48, name: 'String Ens 1' }, { n: 49, name: 'String Ens 2' },
    { n: 50, name: 'Synth Strings 1' }, { n: 51, name: 'Synth Strings 2' },
    { n: 52, name: 'Choir Aahs' }, { n: 53, name: 'Voice Oohs' },
    { n: 54, name: 'Synth Voice' }, { n: 55, name: 'Orchestra Hit' },
  ]},
  { name: 'Brass',       presets: [
    { n: 56, name: 'Trumpet' }, { n: 57, name: 'Trombone' },
    { n: 58, name: 'Tuba' }, { n: 59, name: 'Muted Trumpet' },
    { n: 60, name: 'French Horn' }, { n: 61, name: 'Brass Section' },
    { n: 62, name: 'Synth Brass 1' }, { n: 63, name: 'Synth Brass 2' },
  ]},
  { name: 'Reed',        presets: [
    { n: 64, name: 'Soprano Sax' }, { n: 65, name: 'Alto Sax' },
    { n: 66, name: 'Tenor Sax' }, { n: 67, name: 'Baritone Sax' },
    { n: 68, name: 'Oboe' }, { n: 69, name: 'English Horn' },
    { n: 70, name: 'Bassoon' }, { n: 71, name: 'Clarinet' },
  ]},
  { name: 'Flute / Pipe',presets: [
    { n: 72, name: 'Piccolo' }, { n: 73, name: 'Flute' },
    { n: 74, name: 'Recorder' }, { n: 75, name: 'Pan Flute' },
    { n: 76, name: 'Blown Bottle' }, { n: 77, name: 'Shakuhachi' },
    { n: 78, name: 'Whistle' }, { n: 79, name: 'Ocarina' },
  ]},
  { name: 'Synth Lead',  presets: [
    { n: 80, name: 'Square' }, { n: 81, name: 'Sawtooth' },
    { n: 82, name: 'Calliope' }, { n: 83, name: 'Chiff' },
    { n: 84, name: 'Charang' }, { n: 85, name: 'Voice' },
    { n: 86, name: 'Fifths' }, { n: 87, name: 'Bass + Lead' },
  ]},
  { name: 'Synth Pad',   presets: [
    { n: 88, name: 'New Age' }, { n: 89, name: 'Warm Pad' },
    { n: 90, name: 'Polysynth' }, { n: 91, name: 'Choir Pad' },
    { n: 92, name: 'Bowed' }, { n: 93, name: 'Metallic' },
    { n: 94, name: 'Halo' }, { n: 95, name: 'Sweep' },
  ]},
  { name: 'Synth FX',    presets: [
    { n: 96, name: 'Rain' }, { n: 97, name: 'Soundtrack' },
    { n: 98, name: 'Crystal' }, { n: 99, name: 'Atmosphere' },
    { n: 100, name: 'Brightness' }, { n: 101, name: 'Goblins' },
    { n: 102, name: 'Echoes' }, { n: 103, name: 'Sci-Fi' },
  ]},
  { name: 'Ethnic',      presets: [
    { n: 104, name: 'Sitar' }, { n: 105, name: 'Banjo' },
    { n: 106, name: 'Shamisen' }, { n: 107, name: 'Koto' },
    { n: 108, name: 'Kalimba' }, { n: 109, name: 'Bagpipe' },
    { n: 110, name: 'Fiddle' }, { n: 111, name: 'Shanai' },
  ]},
  { name: 'Percussive',  presets: [
    { n: 112, name: 'Tinkle Bell' }, { n: 113, name: 'Agogo' },
    { n: 114, name: 'Steel Drums' }, { n: 115, name: 'Woodblock' },
    { n: 116, name: 'Taiko' }, { n: 117, name: 'Melodic Tom' },
    { n: 118, name: 'Synth Drum' }, { n: 119, name: 'Reverse Cymbal' },
  ]},
  { name: 'SFX',         presets: [
    { n: 120, name: 'Fret Noise' }, { n: 121, name: 'Breath' },
    { n: 122, name: 'Seashore' }, { n: 123, name: 'Bird Tweet' },
    { n: 124, name: 'Telephone' }, { n: 125, name: 'Helicopter' },
    { n: 126, name: 'Applause' }, { n: 127, name: 'Gunshot' },
  ]},
];
// Build a reverse map: preset N → friendly short key (if any).
const SF2_PRESET_TO_SHORT = {};
for (const [shortKey, n] of Object.entries(INSTRUMENT_TO_SF2)) SF2_PRESET_TO_SHORT[n] = shortKey;
// Register every GM preset under a `gm<N>` ID so playback can resolve it.
for (const cat of GM_CATEGORIES) {
  for (const p of cat.presets) {
    if (SF2_PRESET_TO_SHORT[p.n]) continue; // already has a friendlier key
    INSTRUMENT_TO_SF2['gm' + p.n] = p.n;
  }
}
// GM-category makeup gain in dB — compensates for the wildly different
// recorded loudness of FluidR3 presets. Values are deliberately gentle;
// the user can still fine-tune with per-track volume sliders. Toggle the
// whole thing off via state.volumeBalance.
const GM_CATEGORY_GAIN_DB = {
  Piano:           0,
  Mallets:        -1,
  Organ:          -3,
  Guitar:         -1,
  Bass:           +6,
  Strings:        +2,
  Ensemble:       -1,
  Brass:          -2,
  Reed:           +1,
  'Flute / Pipe': +1,
  'Synth Lead':   -2,
  'Synth Pad':    +2,
  'Synth FX':      0,
  Ethnic:          0,
  Percussive:     -2,
  'Sound Effects': 0,
};
// Build preset-number → linear-gain lookup so the lookup is O(1) per voice.
const SF2_PRESET_GAIN = (() => {
  const map = new Object();
  for (const cat of GM_CATEGORIES) {
    const db = GM_CATEGORY_GAIN_DB[cat.name] ?? 0;
    const lin = Math.pow(10, db / 20);
    for (const p of cat.presets) map[p.n] = lin;
  }
  return map;
})();
function sf2CategoryGain(presetN) {
  if (!state.volumeBalance) return 1;
  return SF2_PRESET_GAIN[presetN] ?? 1;
}
// Resolve an instrument ID to its display name.
function instrumentDisplayName(id) {
  if (!id) return 'Instrument';
  if (id === 'synth') return 'Synth';
  for (const cat of GM_CATEGORIES) {
    for (const p of cat.presets) {
      const presetId = SF2_PRESET_TO_SHORT[p.n] || ('gm' + p.n);
      if (presetId === id) return p.name;
    }
  }
  return id;
}

function sf2ProgressEl() { return document.getElementById('sf2-progress'); }
function sf2UpdateProgress(text) {
  const el = sf2ProgressEl();
  if (!el) return;
  if (!text) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.textContent = text;
}

function loadSf2(fileKey) {
  const entry = SF2_FILES[fileKey];
  if (!entry) return Promise.resolve(null);
  if (entry.sf2)     return Promise.resolve(entry.sf2);
  if (entry.loading) return entry.loading;
  const ns = window.SoundFont2;
  const Ctor = typeof ns === 'function' ? ns : (ns && ns.SoundFont2);
  if (typeof Ctor !== 'function') return Promise.resolve(null);
  sf2UpdateProgress('Downloading instruments…');
  entry.loading = (async () => {
    const tryUrl = async (url) => {
      const resp = await fetch(url);
      if (!resp.ok || !resp.body) throw new Error('http ' + resp.status);
      // Tiny responses are almost certainly Git-LFS pointer files served by
      // GitHub Pages — reject so we fall through to the next URL.
      const cl = parseInt(resp.headers.get('Content-Length') || '0', 10);
      if (cl > 0 && cl < 4096) throw new Error('lfs-pointer (' + cl + ' bytes)');
      return resp;
    };
    try {
      let resp;
      try { resp = await tryUrl(entry.url); }
      catch (e1) {
        if (!entry.fallbackUrl) throw e1;
        console.warn('SF2 primary url failed', entry.url, e1, '→ falling back to', entry.fallbackUrl);
        resp = await tryUrl(entry.fallbackUrl);
      }
      if (!resp.ok || !resp.body) throw new Error('http ' + resp.status);
      const total = parseInt(resp.headers.get('Content-Length') || '0', 10);
      entry.total = total;
      const reader = resp.body.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        entry.loaded += value.length;
        if (total > 0) {
          const pct = Math.round(entry.loaded / total * 100);
          sf2UpdateProgress(`Downloading instruments… ${pct}%`);
        }
      }
      const buf = await new Blob(chunks).arrayBuffer();
      sf2UpdateProgress('Parsing instruments…');
      // Yield briefly so the UI can paint before the synchronous parse
      await new Promise(r => setTimeout(r, 16));
      entry.sf2 = new Ctor(new Uint8Array(buf));
      sf2UpdateProgress('');
      return entry.sf2;
    } catch (err) {
      console.error('SF2 load failed', entry.url, err);
      sf2UpdateProgress('Instrument download failed');
      setTimeout(() => sf2UpdateProgress(''), 4000);
      return null;
    }
  })();
  return entry.loading;
}

function sf2BufferFromSample(ctx, sample) {
  let buf = SF2_BUFFER_CACHE.get(sample);
  if (buf) return buf;
  const data = sample.data;
  const sr = sample.header.sampleRate || 44100;
  buf = ctx.createBuffer(1, data.length, sr);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) ch[i] = data[i] / 32768;
  SF2_BUFFER_CACHE.set(sample, buf);
  return buf;
}

// Eagerly decode every sample referenced by `presetNumber` in `sf2`, in
// small chunks so the UI doesn't stutter. Without this, the first note of
// a preset incurs a 5-50 ms decode + cache fill, making playback feel
// late after an external Start (MIDI Clock) command.
const _sf2Prewarmed = new Set(); // key: `${sf2-something}:${presetNumber}`
function prewarmSf2Preset(sf2, presetNumber) {
  if (!sf2 || presetNumber == null) return;
  const key = (sf2._cpId || (sf2._cpId = Math.random())) + ':' + presetNumber;
  if (_sf2Prewarmed.has(key)) return;
  _sf2Prewarmed.add(key);
  const ctx = getAudioCtx();
  let midi = 21;
  const tick = () => {
    let count = 0;
    while (midi <= 108 && count < 22) {
      try {
        const kd = sf2.getKeyData(midi, 0, presetNumber);
        if (kd?.sample) sf2BufferFromSample(ctx, kd.sample);
      } catch (_) {}
      midi += 1;
      count += 1;
    }
    if (midi <= 108) setTimeout(tick, 0);
  };
  tick();
}

// Generator-id constants (SF2 spec 2.04)
const SF2G = {
  ModLFOToPitch: 5, VibLFOToPitch: 6, ModEnvToPitch: 7,
  InitialFilterFc: 8, InitialFilterQ: 9,
  ModLFOToFilterFc: 10, ModEnvToFilterFc: 11,
  ModLFOToVolume: 13,
  Pan: 17,
  DelayModLFO: 21, FreqModLFO: 22, DelayVibLFO: 23, FreqVibLFO: 24,
  DelayModEnv: 25, AttackModEnv: 26, HoldModEnv: 27, DecayModEnv: 28,
  SustainModEnv: 29, ReleaseModEnv: 30,
  DelayVolEnv: 33, AttackVolEnv: 34, HoldVolEnv: 35, DecayVolEnv: 36,
  SustainVolEnv: 37, ReleaseVolEnv: 38,
  InitialAttenuation: 48,
  CoarseTune: 51, FineTune: 52,
  SampleModes: 54, ScaleTuning: 56, OverridingRootKey: 58,
};

function sf2Gen(keyData, id) {
  const g = keyData.generators?.[id];
  if (g == null) return undefined;
  return typeof g === 'object' ? g.value : g;
}

// Read the SF2 preset's volume envelope + filter generators for a
// representative MIDI note and return them as plain linear values
// (seconds / Hz / 0..1) — same units as the synth preset object so
// applySynthPreset / track FX sliders can show them directly.
// Returns null when the preset has no key data we can read.
function readSf2Defaults(sf2, presetNumber) {
  if (!sf2 || presetNumber == null) return null;
  let keyData = null;
  for (const m of [60, 72, 48, 84, 36]) {
    try { keyData = sf2.getKeyData(m, 0, presetNumber); } catch (_) {}
    if (keyData) break;
  }
  if (!keyData) return null;
  const g = (id) => sf2Gen(keyData, id);
  const out = {};
  const att = g(SF2G.AttackVolEnv);
  if (att  != null) out.attack  = Math.min(timecentsToSec(att), 4);
  const dec = g(SF2G.DecayVolEnv);
  if (dec  != null) out.decay   = Math.min(timecentsToSec(dec), 8);
  const sus = g(SF2G.SustainVolEnv);
  // SF2 sustain is in centibels of attenuation (0 = full, 1000 = -100dB).
  if (sus  != null) out.sustain = Math.max(0, 1 - Math.min(sus, 1000) / 1000);
  const rel = g(SF2G.ReleaseVolEnv);
  if (rel  != null) out.release = Math.min(timecentsToSec(rel), 6);
  const fc  = g(SF2G.InitialFilterFc);
  if (fc   != null) out.filterFreq = Math.min(20000, Math.max(20, absoluteCentsToHz(fc)));
  const fq  = g(SF2G.InitialFilterQ);
  // Centibels → linear Q.
  if (fq   != null) out.filterQ = Math.max(0.001, Math.pow(10, fq / 200));
  return out;
}

// SF2 absolute-cents → Hz: f = 8.176 * 2^(cents/1200)
function absoluteCentsToHz(cents) { return 8.176 * Math.pow(2, cents / 1200); }
// Timecents → seconds, clamped to a sane minimum
function timecentsToSec(tc) { return Math.max(0.001, Math.pow(2, tc / 1200)); }

function startSf2Voice(midiNote, velocity, at, autoRelease, sf2, presetNumber) {
  const keyData = sf2.getKeyData(midiNote, 0, presetNumber);
  if (!keyData || !keyData.sample) return null;
  const ctx = getAudioCtx();
  const t   = at ?? ctx.currentTime;
  const s   = state.synth;
  const sample = keyData.sample;
  const sr     = sample.header.sampleRate || 44100;
  const buffer = sf2BufferFromSample(ctx, sample);
  const g = (id) => sf2Gen(keyData, id);

  // --- Pitch ---------------------------------------------------------
  const overridingRoot = g(SF2G.OverridingRootKey);
  const rootPitch  = (overridingRoot != null && overridingRoot >= 0) ? overridingRoot : sample.header.originalPitch;
  const coarseTune = g(SF2G.CoarseTune) ?? 0;
  const fineTune   = (g(SF2G.FineTune) ?? 0) + (sample.header.pitchCorrection || 0);
  const scaleTune  = g(SF2G.ScaleTuning) ?? 100; // cents per semitone (100 = ET)
  const semitones  = ((midiNote - rootPitch) * scaleTune) / 100 + coarseTune + fineTune / 100;

  // --- Filter --------------------------------------------------------
  // Override only fires when the user explicitly touched the slider on
  // this synth (s._override[key] = true). Otherwise honour the SF2
  // generator so the preset sounds as designed.
  let filterFreq, filterQ;
  if (s._override?.filterFreq) {
    filterFreq = Math.min(20000, Math.max(20, s.filterFreq));
  } else {
    const filterCents = g(SF2G.InitialFilterFc) ?? 13500;
    filterFreq = Math.min(20000, Math.max(20, absoluteCentsToHz(filterCents)));
  }
  if (s._override?.filterQ) {
    filterQ = s.filterQ;
  } else {
    const filterQCB = g(SF2G.InitialFilterQ) ?? 0;
    filterQ = Math.max(0.001, Math.pow(10, filterQCB / 200));
  }

  // --- Output level (attenuation) -----------------------------------
  // Ignore SF2's InitialAttenuation so every preset plays at the same
  // baseline volume — the user adjusts per-track volume sliders for any
  // balance they want, rather than fighting preset-specific attenuation.
  // Optional category-based makeup gain compensates for the fact that
  // some GM categories (bass especially) are recorded much softer.
  const peak = (velocity / 127) * state.audioVolume * sf2CategoryGain(presetNumber);

  // --- Volume envelope: ADSR slider overrides the SF2 generator only
  // when the user explicitly touched it (s._override[key] = true).
  // Otherwise fall back to SF2 generators with caps so per-zone variation
  // is preserved.
  const aT = s._override?.attack  ? Math.min(s.attack,  4)
           : Math.min(g(SF2G.AttackVolEnv)  != null ? timecentsToSec(g(SF2G.AttackVolEnv))  : s.attack,  4);
  const dT = s._override?.decay   ? Math.min(s.decay,   8)
           : Math.min(g(SF2G.DecayVolEnv)   != null ? timecentsToSec(g(SF2G.DecayVolEnv))   : s.decay,   8);
  const sL = s._override?.sustain ? s.sustain
           : (g(SF2G.SustainVolEnv) != null
                ? Math.max(0, 1 - Math.min(g(SF2G.SustainVolEnv), 1000) / 1000)
                : s.sustain);
  const rT = s._override?.release ? Math.min(s.release, 6)
           : Math.min(g(SF2G.ReleaseVolEnv) != null ? timecentsToSec(g(SF2G.ReleaseVolEnv)) : s.release, 6);

  // --- Build graph ---------------------------------------------------
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + aT);
  env.gain.exponentialRampToValueAtTime(Math.max(peak * sL, 0.0001), t + aT + dT);
  env.gain.setValueAtTime(peak * sL, t + aT + dT);
  env.connect(ctx._out);

  // Tremolo: two LFOs can modulate the voice gain — the SF2's own
  // ModLFOToVolume (for presets like Rhodes that ship with a wobble) and
  // our user slider on top. They sum, so the slider is purely additive.
  const tremGain = ctx.createGain();
  tremGain.gain.value = 1;
  tremGain.connect(env);
  const lfoNodes = [];
  // SF2 native tremolo (centibels of volume modulation).
  const modLfoToVol = g(SF2G.ModLFOToVolume);
  if (modLfoToVol && Math.abs(modLfoToVol) > 0.01) {
    const lfoFreq  = absoluteCentsToHz(g(SF2G.FreqModLFO) ?? -4500);
    const lfoDelay = timecentsToSec(g(SF2G.DelayModLFO) ?? -7200);
    // Centibels → gain depth (~0.115/100cB ≈ dB/8.686). Cap at 0.5 so it
    // doesn't go negative when summed with the slider.
    const depth = Math.min(0.5, Math.abs(modLfoToVol) / 200);
    const sf2Lfo = ctx.createOscillator(); sf2Lfo.frequency.value = lfoFreq;
    const sf2Amp = ctx.createGain(); sf2Amp.gain.value = 0;
    sf2Lfo.connect(sf2Amp); sf2Amp.connect(tremGain.gain);
    sf2Amp.gain.setValueAtTime(0, t);
    sf2Amp.gain.setValueAtTime(0, t + lfoDelay);
    sf2Amp.gain.linearRampToValueAtTime(depth, t + lfoDelay + 0.05);
    sf2Lfo.start(t);
    lfoNodes.push(sf2Lfo);
    tremGain.gain.value = 1 - depth;
  }
  // User slider tremolo — adds on top of whatever the SF2 already does.
  let tLfo = null;
  if (s.tremoloDepth > 0) {
    tremGain.gain.value -= s.tremoloDepth * 0.5;
    tLfo = ctx.createOscillator();
    tLfo.frequency.value = s.tremoloRate;
    const tLfoGain = ctx.createGain();
    tLfoGain.gain.value = s.tremoloDepth * 0.5;
    tLfo.connect(tLfoGain);
    tLfoGain.connect(tremGain.gain);
    tLfo.start(t);
  }

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = filterFreq;
  filter.Q.value = filterQ;
  filter.connect(tremGain);

  const sampleModes = g(SF2G.SampleModes) ?? 0;
  const wantLoop = sampleModes === 1 || sampleModes === 3;

  // Every SF2 voice plays centered. The SF2 Pan generator in FluidR3 is set
  // for hard-stereo pairs (left/right halves) per preset — honouring it on
  // a mono buffer makes presets like Strings end up only in one speaker.
  // The audio context automatically upmixes mono to stereo at the output.
  const sources = [(() => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Math.pow(2, semitones / 12);
    if (wantLoop) {
      const lS = sample.header.startLoop, lE = sample.header.endLoop;
      if (lE > lS && lE <= buffer.length) {
        src.loop = true;
        src.loopStart = lS / sr;
        src.loopEnd   = lE / sr;
      }
    }
    src.connect(filter);
    return src;
  })()];

  // --- Vibrato LFOs → pitch -----------------------------------------
  // SF2 native vibrato runs always (presets like solo violin ship with
  // their own). User slider adds an extra LFO on top — pure additive.
  let vibLfo = null;
  const vibLfoToPitch = g(SF2G.VibLFOToPitch);
  if (vibLfoToPitch && Math.abs(vibLfoToPitch) > 0.01) {
    const lfoFreq  = absoluteCentsToHz(g(SF2G.FreqVibLFO) ?? -2400);
    const lfoDelay = timecentsToSec(g(SF2G.DelayVibLFO) ?? -7200);
    vibLfo = ctx.createOscillator(); vibLfo.frequency.value = lfoFreq;
    const gAmp = ctx.createGain(); gAmp.gain.value = 0;
    vibLfo.connect(gAmp);
    sources.forEach(src => gAmp.connect(src.detune));
    gAmp.gain.setValueAtTime(0, t);
    gAmp.gain.setValueAtTime(0, t + lfoDelay);
    gAmp.gain.linearRampToValueAtTime(vibLfoToPitch, t + lfoDelay + 0.05);
    vibLfo.start(t);
    lfoNodes.push(vibLfo);
  }
  let userVibLfo = null;
  if (s.vibratoDepth > 0) {
    userVibLfo = ctx.createOscillator();
    userVibLfo.frequency.value = s.vibratoRate;
    const gAmp = ctx.createGain();
    gAmp.gain.value = s.vibratoDepth;
    userVibLfo.connect(gAmp);
    sources.forEach(src => gAmp.connect(src.detune));
    userVibLfo.start(t);
  }

  // --- Reverb / delay sends (use the global FX bus) ------------------
  if (ctx._reverb) {
    ctx._reverbWet.gain.value = s.reverb;
    const rs = ctx.createGain(); rs.gain.value = 0.5;
    env.connect(rs); rs.connect(ctx._reverb);
  }
  if (ctx._delay) {
    ctx._delay.delayTime.value = s.delayTime;
    ctx._delayFb.gain.value = s.delayFeedback;
    ctx._delayWet.gain.value = s.delayWet;
    env.connect(ctx._delay);
  }

  if (state.pitchBendCents) {
    sources.forEach(src => { src.detune.value = (src.detune.value || 0) + state.pitchBendCents; });
  }
  sources.forEach(src => src.start(t));

  const oscs = [...sources, ...lfoNodes];
  if (userVibLfo) oscs.push(userVibLfo);
  if (tLfo)       oscs.push(tLfo);
  const node = { oscs, env, startTime: t, peak };
  node.sustainLevel = sL;
  node.releaseTime  = rT;
  if (autoRelease !== null) {
    const rel = t + autoRelease;
    node.env.gain.setValueAtTime(peak * sL, rel);
    node.env.gain.exponentialRampToValueAtTime(0.0001, rel + rT);
    sources.forEach(src => src.stop(rel + rT + 0.01));
  }
  return node;
}

function stopAudioNote(node) {
  if (!node) return;
  const ctx = getAudioCtx();
  const s   = state.synth;
  const now = ctx.currentTime;
  const releaseT = node.releaseTime ?? s.release;
  const releaseAt = Math.max(now, (node.startTime || 0) + s.attack + 0.02);
  node.env.gain.cancelScheduledValues(releaseAt);
  const gainAtRelease = releaseAt > now ? node.peak : node.env.gain.value;
  if (!isFinite(gainAtRelease) || gainAtRelease <= 0) {
    node.oscs.forEach(o => { try { o.stop(now); } catch(e) {} });
    return;
  }
  node.env.gain.setValueAtTime(gainAtRelease, releaseAt);
  node.env.gain.exponentialRampToValueAtTime(0.0001, releaseAt + releaseT);
  node.oscs.forEach(o => o.stop(releaseAt + releaseT));
}

function startBassNote(midiNote, at = null, autoRelease = null, instrumentOverride = null) {
  const effInstrument = instrumentOverride ?? state.instrument;
  // SF2 path for mapped instruments
  const sf2Preset = INSTRUMENT_TO_SF2[effInstrument];
  if (sf2Preset != null && SF2_FILES.fluid.sf2) {
    return startSf2Voice(midiNote, Math.round(state.velocity * 0.9), at, autoRelease, SF2_FILES.fluid.sf2, sf2Preset);
  }
  if (effInstrument !== 'synth') {
    const instrument = effInstrument;
    const ctx = getAudioCtx();
    const t = at ?? ctx.currentTime;
    const sampleMidi = nearestSampleMidi(instrument, midiNote);
    const buffer = sampleCache[instrument][sampleMidi];
    if (!(buffer instanceof AudioBuffer)) return null;
    const peak = state.audioVolume * 3.5;
    const atk = Math.min(state.synth.attack, 0.01);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + atk);
    env.gain.exponentialRampToValueAtTime(peak * 0.55, t + atk + 0.12);
    env.gain.setValueAtTime(peak * 0.55, t + atk + 0.12);
    env.connect(ctx._out);
    if (ctx._reverb) {
      const rs = ctx.createGain(); rs.gain.value = 0.3;
      env.connect(rs); rs.connect(ctx._reverb);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Math.pow(2, (midiNote - sampleMidi) / 12);
    src.connect(env);
    src.start(t);
    return { oscs: [src], env, peak, startTime: t };
  }

  const ctx  = getAudioCtx();
  const t    = at ?? ctx.currentTime;
  const freq = midiToFreq(midiNote);
  const peak = state.audioVolume * 0.7;
  const atk  = Math.min(state.synth.attack, 0.025);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + atk);
  env.gain.exponentialRampToValueAtTime(peak * 0.55, t + atk + 0.12);
  env.gain.setValueAtTime(peak * 0.55, t + atk + 0.12);
  env.connect(ctx._out);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freq;
  osc.connect(env);

  const osc2 = ctx.createOscillator();
  osc2.type = 'triangle';
  osc2.frequency.value = freq * 2;
  const g2 = ctx.createGain(); g2.gain.value = 0.12;
  osc2.connect(g2); g2.connect(env);

  if (state.pitchBendCents) { osc.detune.value = state.pitchBendCents; osc2.detune.value = state.pitchBendCents; }
  osc.start(t); osc2.start(t);
  return { oscs: [osc, osc2], env, peak, startTime: t };
}

