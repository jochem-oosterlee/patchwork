// Engine link — couples the compose view to the Patchwork engine over its
// WebSocket. Loaded last, so it can wrap the functions the other modules
// defined. While the engine is reachable:
//
//   - transport (play/stop/seek) and the sequencer run in the engine; the
//     flattened song (tracks → notes in absolute quarter-note beats + target
//     instrument) is pushed on every change and the playhead follows the
//     engine's transport events;
//   - live notes (pads, keyboard, previews, strums, arps) go to the engine as
//     `note` commands instead of Web Audio voices;
//   - the metronome clicks in the engine; the project autosaves to the
//     engine (compose.json) and comes back on connect.
//
// Without an engine everything falls through to chord-pad's own paths.

const LINK = {
  url: 'ws://127.0.0.1:7681',
  ws: null,
  active: false,                 // handshake done, engine drives
  presets: [],                   // Patchwork presets of the current set: [{id, name, loaded}]
  padTarget: '',                 // instrument for live notes + tracks without their own ('' = rack routing)
  engine: { playing: false, beat: 0, bpm: 120, loop: false, loopStart: 0, loopEnd: 4, latencyBeats: 0, at: 0 },
  _modelTimer: null,
  _saveTimer: null,
  _suppressSaveUntil: 0,
  _retry: null,
};

try { LINK.padTarget = localStorage.getItem('patchwork-link-pad-target') || ''; } catch (_) {}

// ---------- connection ----------

function linkConnect() {
  let ws;
  try { ws = new WebSocket(LINK.url); } catch (_) { return linkRetry(); }
  LINK.ws = ws;
  ws.onopen = () => linkSend({ cmd: 'hello', role: 'chordpad', version: 2 });
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
    linkOnEvent(msg);
  };
  ws.onclose = () => { linkDeactivate(); linkRetry(); };
  ws.onerror = () => {};
}
function linkRetry() {
  if (LINK._retry) return;
  LINK._retry = setTimeout(() => { LINK._retry = null; linkConnect(); }, 2000);
}
function linkSend(obj) {
  if (LINK.ws && LINK.ws.readyState === 1) LINK.ws.send(JSON.stringify(obj));
}
function linkDeactivate() {
  if (!LINK.active) return;
  LINK.active = false;
  if (SEQ.playing) linkEnterStopped();
  linkRenderBadge();
}

function linkOnEvent(m) {
  switch (m.event) {
    case 'chordpad_ack':
      LINK.active = true;
      linkRenderBadge();
      linkPushModel(true);
      break;
    case 'state':
      LINK.presets = Array.isArray(m.presets) ? m.presets.map(p => ({ id: p.id, name: p.name, loaded: !!p.loaded })) : [];
      linkRenderBadge();
      break;
    case 'transport':
      linkOnTransport(m);
      break;
    case 'load_project':
      if (m.data && typeof m.data === 'object') {
        LINK._suppressSaveUntil = performance.now() + 1500;   // don't echo the project straight back
        seqImportProject(m.data);
        linkPushModel(true);
      }
      break;
    default: break;
  }
}

// ---------- beats ----------

// UI beats are quarter notes except in 6/8, where chord-pad counts eighths.
// The engine always counts quarter notes: uiBeat * scale = engineBeat.
function linkBeatScale() { return seqBeatDur() * state.tempo / 60; }

// Current UI-beat position derived from the last transport message. `visual`
// rewinds by the output latency so the cursor sits where the listener is.
function linkCurrentBeat(visual) {
  const e = LINK.engine;
  const scale = linkBeatScale();
  if (!e.playing) return e.beat / scale;
  let b = e.beat + (performance.now() - e.at) / 1000 * (e.bpm / 60);
  if (visual) b -= e.latencyBeats + (SEQ.visualLatencyMs || 0) / 1000 * (e.bpm / 60);
  if (e.loop && e.loopEnd > e.loopStart) {
    const L = e.loopEnd - e.loopStart;
    b = e.loopStart + (((b - e.loopStart) % L) + L) % L;
  }
  return b / scale;
}

function linkOnTransport(m) {
  const e = LINK.engine;
  e.playing = !!m.playing; e.beat = +m.beat || 0; e.bpm = +m.bpm || e.bpm;
  e.loop = !!m.loop; e.loopStart = +m.loopStart || 0; e.loopEnd = +m.loopEnd || 4;
  e.latencyBeats = +m.latencyBeats || 0;
  e.at = performance.now();
  if (typeof m.bpm === 'number' && m.bpm > 0 && Math.abs(m.bpm - state.tempo) > 0.001) {
    state.tempo = m.bpm;
    const a = document.getElementById('seq-tempo-val'); if (a) a.value = Math.round(m.bpm * 10) / 10;
    const b = document.getElementById('ctrl-tempo');    if (b) b.value = Math.round(m.bpm * 10) / 10;
  }
  // Time signature follows the engine (the shell's 4/4 widget sets it): the
  // grid's bar lines and the loop default come from state.beatsPerBar.
  if (EMBED && typeof m.tsNum === 'number' && m.tsNum >= 1 && m.tsNum !== state.beatsPerBar) {
    const sel = document.getElementById('seq-timesig');
    if (sel) {
      sel.value = String(m.tsNum);
      if (sel.value === String(m.tsNum)) sel.dispatchEvent(new Event('change'));   // one of ours: full re-render
      else { state.beatsPerBar = m.tsNum; if (typeof seqUpdateBarLine === 'function') seqUpdateBarLine(); }
    }
  }
  if (!LINK.active) return;
  if (e.playing && !SEQ.playing) linkEnterPlaying();
  else if (!e.playing && SEQ.playing) linkEnterStopped();
}

function linkEnterPlaying() {
  SEQ.playing = true;
  SEQ.animLoopLen   = SEQ.loopEnd - SEQ.loopStart;
  SEQ.animLoopStart = SEQ.loopStart;
  SEQ.animBeat      = linkCurrentBeat(true);
  document.querySelectorAll('.seq-playhead').forEach(ph => {
    if (!ph.closest('#seq-pianoroll-body')) ph.style.display = 'block';
  });
  if (METRO.enabled && !EMBED) linkSend({ cmd: 'metronome', on: true });
  if (!SEQ.rafId) seqAnimatePlayhead();
}

function linkEnterStopped() {
  SEQ.startBeat = linkCurrentBeat(true);
  if (REC.active) recStop();
  _linkOrig.seqStop();           // chord-pad's own stop: clears timers, parks the playheads
}

// ---------- song model → engine ----------

function linkPushModel(immediate) {
  if (!LINK.active) return;
  if (LINK._modelTimer) { clearTimeout(LINK._modelTimer); LINK._modelTimer = null; }
  const send = () => linkSend({ cmd: 'seq_model', model: linkBuildModel() });
  if (immediate) send();
  else LINK._modelTimer = setTimeout(() => { LINK._modelTimer = null; send(); }, 60);
}

function linkTrackTarget(t) {
  if (t.output === 'midi') return '';                 // external MIDI stays with Web MIDI (silent while linked)
  if (t.output === 'engine') return t.engineTarget || LINK.padTarget;
  return LINK.padTarget;                              // 'instrument' tracks play the pad instrument
}

function linkBuildModel() {
  const scale = linkBeatScale();
  const clampMidi = n => Math.max(0, Math.min(127, n));
  const tracks = [];
  for (const t of SEQ.tracksList) {
    const notes = [];
    if (t.kind === 'chord') {
      const vel = seqTrackVel(t, state.velocity);
      for (const item of t.items) {
        const kr      = item.keyRoot !== undefined ? item.keyRoot : state.keys[state.currentTemplate];
        const itemOct = item.octave  !== undefined ? item.octave  : state.octave;
        const shift   = item.semitoneShift || 0;
        const ns = chordToMidiNotes(kr, itemOct, item.interval, item.q, item.voicing).map(n => clampMidi(n + shift));
        const bassInt     = item.bassInterval !== undefined ? item.bassInterval : item.interval;
        const bassEnabled = item.bassEnabled ?? state.bassEnabled;
        const bassOct     = item.bassOctave  ?? state.bassOctave;
        if (bassEnabled) ns.push(clampMidi((bassOct + 1) * 12 + (kr + bassInt) % 12));
        for (const m of ns) notes.push({ start: item.start * scale, beats: item.beats * scale, midi: m, vel });
      }
    } else {
      invalidateFreeTrackFlat(t);
      for (const n of freeTrackFlatNotes(t)) {
        const baseVel = (typeof n.velocity === 'number') ? n.velocity : state.velocity;
        notes.push({ start: n.start * scale, beats: n.beats * scale, midi: n.midi, vel: seqTrackVel(t, baseVel) });
      }
    }
    tracks.push({ id: t.id, target: linkTrackTarget(t), channel: ((t.channel | 0) + 1), audible: seqTrackAudible(t), notes });
  }
  return { loop: !!SEQ.loop, loopStart: SEQ.loopStart * scale, loopEnd: SEQ.loopEnd * scale, tracks };
}

function linkScheduleSave() {
  if (!LINK.active) return;
  if (LINK._saveTimer) clearTimeout(LINK._saveTimer);
  LINK._saveTimer = setTimeout(() => {
    LINK._saveTimer = null;
    if (performance.now() < LINK._suppressSaveUntil) return;
    linkSend({ cmd: 'compose_save', data: seqProjectSnapshot() });
  }, 400);
}

// ---------- live notes ----------

function linkNoteOn(midi, vel, target) {
  linkSend({ cmd: 'note', on: true, note: midi, vel: Math.max(1, Math.min(127, Math.round(vel || 100))), ch: 1, target: target || '' });
}
function linkNoteOff(token) {
  if (!token || token.off) return;
  token.off = true;
  if (token.timer) { clearTimeout(token.timer); token.timer = null; }
  if (!token.fired) return;      // cancelled before its scheduled attack
  linkSend({ cmd: 'note', on: false, note: token.midi, vel: 0, ch: 1, target: token.target });
}

// ---------- record count-in ----------

function linkPrecountThenPlay(startBeat) {
  const bdMs = seqBeatDur() * 1000;
  const n    = Math.max(1, state.beatsPerBar || 4);
  const span = document.getElementById('seq-rec-beat');
  let i = 0;
  const tick = () => {
    if (!REC.armed) { if (span) span.textContent = ''; return; }   // disarmed during the count
    if (i >= n) {
      if (span) span.textContent = '';
      linkSend({ cmd: 'transport_play', beat: startBeat * linkBeatScale() });
      recActivate(0);
      return;
    }
    linkSend({ cmd: 'click', accent: i === 0 });
    if (span) span.textContent = n - i;
    i++;
    setTimeout(tick, bdMs);
  };
  tick();
}

// ---------- shell bridge (embedded in Patchwork's page) ----------
// The shell owns the chrome; this frame answers to it over postMessage.

const EMBED = document.documentElement.classList.contains('embed');

function linkPostToShell(msg) {
  if (!EMBED || window.parent === window) return;
  try { window.parent.postMessage(Object.assign({ type: 'compose' }, msg), '*'); } catch (_) {}
}
function linkSectionStates() {
  const out = {};
  document.querySelectorAll('.header-section-toggle[data-section]').forEach(b => {
    out[b.dataset.section] = b.classList.contains('active');
  });
  return out;
}
function linkPostSections() { linkPostToShell({ event: 'sections', active: linkSectionStates() }); }
function linkPostPadTarget() { linkPostToShell({ event: 'padTarget', id: LINK.padTarget }); }

if (EMBED) {
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type !== 'patchwork') return;
    switch (m.action) {
      case 'toggleSection':
        document.querySelector(`.header-section-toggle[data-section="${m.arg}"]`)?.click();
        break;
      case 'setPadTarget':
        LINK.padTarget = m.arg || '';
        try { localStorage.setItem('patchwork-link-pad-target', LINK.padTarget); } catch (_) {}
        linkPushModel();
        linkPostPadTarget();
        break;
      case 'undo': seqUndo(); break;
      case 'redo': seqRedo(); break;
      case 'toggleLoop': document.getElementById('seq-loop-btn')?.click(); break;
      case 'toggleRec':  document.getElementById('seq-rec-btn')?.click();  break;
      case 'nav':        document.getElementById('seq-nav-' + m.arg)?.click(); break;
      case 'click':      document.querySelector(m.arg)?.click(); break;   // dev/test helper
      case 'scrollTo': window.scrollTo(0, +m.arg || 0); break;
      case 'query': linkPostSections(); linkPostPadTarget(); break;
      default: break;
    }
  });
  // Mirror the section toggles' state to the shell whenever it changes.
  const obs = new MutationObserver(linkPostSections);
  document.querySelectorAll('.header-section-toggle[data-section]').forEach(b =>
    obs.observe(b, { attributes: true, attributeFilter: ['class'] }));
  // Likewise the record button's armed/active state and the count-in beat.
  const recBtn = document.getElementById('seq-rec-btn');
  const recBeat = document.getElementById('seq-rec-beat');
  const postRec = () => linkPostToShell({
    event: 'rec',
    armed:  !!recBtn?.classList.contains('armed'),
    active: !!recBtn?.classList.contains('active'),
    beat:   (recBeat?.textContent || '').trim(),
  });
  if (recBtn)  new MutationObserver(postRec).observe(recBtn,  { attributes: true, attributeFilter: ['class'] });
  if (recBeat) new MutationObserver(postRec).observe(recBeat, { childList: true, characterData: true, subtree: true });
  postRec();
  // View switch shortcuts work with focus inside the frame too.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === '1' || e.key === '2')) {
      e.preventDefault();
      linkPostToShell({ event: 'switchView', view: e.key === '1' ? 'rack' : 'compose' });
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      linkPostToShell({ event: 'save', as: e.shiftKey });
    }
  });
  linkPostToShell({ event: 'ready' });
  linkPostSections();
  linkPostPadTarget();
}

// ---------- badge: link status + pad instrument (standalone only) ----------

function linkRenderBadge() {
  if (EMBED) { linkPostPadTarget(); return; }   // the shell shows the picker
  let el = document.getElementById('link-badge');
  if (!el) {
    el = document.createElement('div');
    el.id = 'link-badge';
    el.style.cssText = 'position:fixed; right:10px; bottom:10px; z-index:9000; display:flex; align-items:center; gap:8px;'
      + 'padding:5px 9px; border:1px solid var(--panel-edge,#25282e); border-radius:6px; background:var(--panel,#16181c);'
      + 'font:11px/1.2 "JetBrains Mono",monospace; color:var(--text-dim,#8a8780);';
    el.innerHTML = '<span class="link-dot" style="width:7px;height:7px;border-radius:50%;background:#555"></span>'
      + '<span class="link-label">engine</span>'
      + '<select class="link-target" style="font:inherit;background:rgba(0,0,0,.4);color:var(--text,#e8e6df);border:1px solid var(--panel-edge,#25282e);border-radius:4px;padding:2px 4px;max-width:180px"></select>';
    document.body.appendChild(el);
    el.querySelector('.link-target').addEventListener('change', (e) => {
      LINK.padTarget = e.target.value;
      try { localStorage.setItem('patchwork-link-pad-target', LINK.padTarget); } catch (_) {}
      linkPushModel();
    });
  }
  el.querySelector('.link-dot').style.background = LINK.active ? 'var(--accent,#ffaa33)' : '#555';
  el.querySelector('.link-label').textContent = LINK.active ? 'engine' : 'engine offline';
  const sel = el.querySelector('.link-target');
  sel.style.display = LINK.active ? '' : 'none';
  const opts = ['<option value="">— rack routing —</option>']
    .concat(LINK.presets.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`));
  sel.innerHTML = opts.join('');
  sel.value = LINK.presets.some(p => p.id === LINK.padTarget) ? LINK.padTarget : '';
}

// ---------- wrappers around chord-pad's own functions ----------

const _linkOrig = {
  makeTrack,
  seqPlay, seqStop, seqJumpToBeat, seqSave, seqTick, seqAnimatePlayhead,
  seqLoopBaseChangedResync, seqResyncTrack, seqResyncTrackThrottled, seqResyncAllThrottled,
  startAudioNote, stopAudioNote, startBassNote,
  metroRun, metroRunSynced, metroHalt, applyTempoChange, recCurrentBeat,
};

// Embedded, the 148 MB GM soundfont is never needed (no in-app voice) — stop
// audio.js from fetching it on startup. Its callers cope with a null result.
if (EMBED) loadSf2 = function () { return Promise.resolve(null); };

// Embedded there is no in-app voice: a track either plays a Patchwork
// instrument ('engine') or external MIDI. Old projects' 'instrument' tracks
// become engine tracks on the pad instrument.
makeTrack = function (opts) {
  const t = _linkOrig.makeTrack(opts);
  if (EMBED && t.output === 'instrument') t.output = 'engine';
  return t;
};

seqPlay = function (leadSec) {
  if (!LINK.active) return _linkOrig.seqPlay(leadSec);
  const want = (typeof SEQ.startBeat === 'number')
    ? Math.max(SEQ.loopStart, Math.min(SEQ.loopEnd - 0.001, SEQ.startBeat))
    : SEQ.loopStart;
  linkPushModel(true);                     // the engine plays what's on screen right now
  if (REC.armed && PRECOUNT.enabled) return linkPrecountThenPlay(want);
  linkSend({ cmd: 'transport_play', beat: want * linkBeatScale() });
  if (REC.armed) recActivate(0);
};

seqStop = function () {
  if (!LINK.active) return _linkOrig.seqStop();
  linkSend({ cmd: 'transport_stop' });     // the engine's transport event completes the stop
};

// Cursor moves always reach the engine, also while stopped, so Play from the
// shell starts where the compose cursor stands.
seqJumpToBeat = function (beat) {
  const r = _linkOrig.seqJumpToBeat(beat);
  if (LINK.active) linkSend({ cmd: 'transport_seek', beat: Math.max(0, beat) * linkBeatScale() });
  return r;
};

seqSave = function () {
  if (EMBED) uiPrefsSave();          // the song itself lives in the engine, not in localStorage
  else _linkOrig.seqSave();
  if (LINK.active) { linkPushModel(); linkScheduleSave(); }
};

// The JS scheduler and its resync machinery are idle while the engine plays.
seqTick                  = function ()       { if (!LINK.active) return _linkOrig.seqTick(); };
seqLoopBaseChangedResync = function (o)      { if (!LINK.active) return _linkOrig.seqLoopBaseChangedResync(o); };
seqResyncTrack           = function (t, o)   { if (!LINK.active) return _linkOrig.seqResyncTrack(t, o); };
seqResyncTrackThrottled  = function (t, o)   { if (!LINK.active) return _linkOrig.seqResyncTrackThrottled(t, o); };
seqResyncAllThrottled    = function ()       { if (!LINK.active) return _linkOrig.seqResyncAllThrottled(); };

// Playhead: feed the engine's position in, let chord-pad do the drawing.
seqAnimatePlayhead = function () {
  if (LINK.active) {
    if (!SEQ.playing) { SEQ.rafId = null; return; }
    const ctx = getAudioCtx();
    const lat = (ctx.outputLatency ?? ctx.baseLatency ?? 0) + (SEQ.visualLatencyMs || 0) / 1000;
    SEQ.animLastTime  = ctx.currentTime - lat;     // dt = 0 → no integration, our beat stands
    SEQ.animBeat      = linkCurrentBeat(true);
    SEQ.animLoopLen   = SEQ.loopEnd - SEQ.loopStart;
    SEQ.animLoopStart = SEQ.loopStart;
  }
  return _linkOrig.seqAnimatePlayhead();
};

// Live voices become engine notes. The returned token stands in for the
// audio node so release paths (stopAudioNote, kbActive, activeChords) work.
startAudioNote = function (midiNote, velocity, at = null, autoRelease = null, instrumentOverride = null) {
  if (!LINK.active) return _linkOrig.startAudioNote(midiNote, velocity, at, autoRelease, instrumentOverride);
  const token = { link: true, midi: midiNote, target: LINK.padTarget, fired: false, off: false, timer: null, oscs: [] };
  const ctx = getAudioCtx();
  const delayMs = (at != null) ? Math.max(0, (at - ctx.currentTime) * 1000) : 0;
  const fire = () => {
    token.timer = null;
    if (token.off) return;
    token.fired = true;
    linkNoteOn(midiNote, velocity, token.target);
    if (autoRelease != null) token.timer = setTimeout(() => linkNoteOff(token), Math.max(10, autoRelease * 1000));
  };
  if (delayMs > 1) token.timer = setTimeout(fire, delayMs); else fire();
  return token;
};
stopAudioNote = function (node) {
  if (node && node.link) return linkNoteOff(node);
  return _linkOrig.stopAudioNote(node);
};
startBassNote = function (midiNote, at = null, autoRelease = null, instrumentOverride = null) {
  if (!LINK.active) return _linkOrig.startBassNote(midiNote, at, autoRelease, instrumentOverride);
  return startAudioNote(midiNote, Math.round(state.velocity * 0.9), at, autoRelease, instrumentOverride);
};

// Metronome clicks in the engine, out the same interface as the plugins.
// Embedded, the shell's status-bar button owns the engine metronome and we
// leave it alone; standalone-linked, our own button drives it.
metroRun       = function (t, b) { if (!LINK.active) return _linkOrig.metroRun(t, b);  if (!EMBED) linkSend({ cmd: 'metronome', on: !!METRO.enabled }); };
metroRunSynced = function ()     { if (!LINK.active) return _linkOrig.metroRunSynced(); if (!EMBED) linkSend({ cmd: 'metronome', on: !!METRO.enabled }); };
metroHalt      = function ()     { if (!LINK.active) return _linkOrig.metroHalt();      if (!EMBED) linkSend({ cmd: 'metronome', on: false }); };

applyTempoChange = function () {
  _linkOrig.applyTempoChange();
  if (LINK.active) linkSend({ cmd: 'set_bpm', bpm: state.tempo });
};

recCurrentBeat = function () {
  if (!LINK.active) return _linkOrig.recCurrentBeat();
  return linkCurrentBeat(true);
};

linkRenderBadge();
linkConnect();
