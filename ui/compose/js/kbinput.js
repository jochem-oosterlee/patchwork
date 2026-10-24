// ============================================================
// KEYBOARD INPUT — QWERTY + VISUAL PIANO
// ============================================================
//
// Extracted from chord-pad.js. Loaded AFTER seq.js + pads.js but
// BEFORE chord-pad.js — the keydown handler registered at parse time
// reads state / SEQ / playChord / seqUndo etc., which are runtime
// lookups, so any order would work for the handler body; what matters
// is that the handler is REGISTERED before chord-pad.js's own
// listeners might rely on it.
//
// Cross-file dependencies (resolved at runtime via window scope):
//   chord-pad.js: state, TEMPLATES, V2_KEYMAPS, V2_SECTIONS, releaseAll,
//                 setKey, updateControlDisplays, flashHint, panic,
//                 hidePianoTooltip, midiNoteName
//   audio.js:     getAudioCtx, startAudioNote, stopAudioNote, withSynth
//   midi.js:      sendNoteOn, sendNoteOff
//   seq.js:       SEQ, seqPlay, seqStop, seqUndo, seqRedo,
//                 seqCopySelection / seqCutSelection / seqPasteSelection /
//                 seqDuplicateSelection / seqDeleteSelection,
//                 seqSelectAll, seqAddTouchDrag, seqAutoExtendLoop,
//                 ensureTrackOfKind, makeClip, seqRenderTrack,
//                 seqResyncTrack, REC, recCurrentBeat
//   pads.js:      playChord, releaseChord, scaleKeymap, scheduleDraw,
//                 updateNeapolitanSplit
//   pianoroll.js: prRollHasNoteSelection, prCopyNotes / prCutNotes /
//                 prPasteNotes / prDuplicateNotes, prSelectAllNotes,
//                 focusedClipObjects, renderPianoRoll
//
// Public surface (called by the rest of the app):
//   heldKeys, findChordByKey, getBaseKey,
//   kbNoteOn, kbNoteOff, kbActive,
//   buildKeyboard, addKbHandlers, initKbDragStrip,
//   KB_WHITE_PCS, KB_START, KB_END, KB_WW, KB_WH, KB_BW, KB_BH

// ============================================================
// KEYBOARD
// ============================================================
const heldKeys = new Set();

function findChordByKey(key) {
  const tpl = TEMPLATES[state.currentTemplate];
  const keymap   = V2_KEYMAPS[state.currentTemplate]  || tpl?.keymap;
  const sections = V2_SECTIONS[state.currentTemplate] || tpl?.sections;
  if (!keymap) return null;
  const mapping = keymap[key];
  if (!mapping) return null;
  const [section, idx] = mapping;
  const prefix = state.currentTemplate === 'major-harmony' ? 'major' : 'minor';
  if (section === 'neapolitan') {
    const sec = sections.find(s => s.neapolitan);
    if (!sec) return null;
    return { padId: `${prefix}-pad-neapolitan-0`, chord: sec.neapolitan };
  }
  const sec = sections.find(s => s.id === section);
  if (!sec) return null;
  const chord = sec.chords[idx];
  if (!chord) return null;
  return { padId: `${prefix}-pad-${section}-${idx}`, chord };
}

function flashHint(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('active');
  setTimeout(() => el.classList.remove('active'), 300);
}

function getBaseKey(e) {
  if (e.code.startsWith('Digit')) return e.code.replace('Digit', '');
  if (e.code.startsWith('Key'))   return e.code.replace('Key', '').toLowerCase();
  return e.key.toLowerCase();
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const key = getBaseKey(e);

  // Sequencer shortcuts: undo/redo, copy/cut/paste, delete selection
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); seqUndo(); return; }
    if (key === 'z' && e.shiftKey)  { e.preventDefault(); seqRedo(); return; }
    if (key === 'y' && !e.shiftKey) { e.preventDefault(); seqRedo(); return; }
    // Prefer note-level ops when the piano-roll has a note selection (or a
    // note clipboard for paste). Falls back to clip-level ops otherwise.
    const noteCtx = prRollHasNoteSelection();
    if (key === 'c' && !e.shiftKey) { e.preventDefault(); noteCtx ? prCopyNotes()      : seqCopySelection();      return; }
    if (key === 'x' && !e.shiftKey) { e.preventDefault(); noteCtx ? prCutNotes()       : seqCutSelection();       return; }
    if (key === 'v' && !e.shiftKey) { e.preventDefault(); (SEQ.pianoRollOpen && SEQ.prClipboard) ? prPasteNotes() : seqPasteSelection(); return; }
    if (key === 'd' && !e.shiftKey) { e.preventDefault(); noteCtx ? prDuplicateNotes() : seqDuplicateSelection(); return; }
    if (key === 'a' && !e.shiftKey) {
      e.preventDefault();
      // Pick context from the most recently-interacted zone. Falls back to
      // the arrangement when no zone has been touched yet.
      if (SEQ._lastZone === 'roll' && SEQ.pianoRollOpen) prSelectAllNotes();
      else seqSelectAll();
      return;
    }
  }
  if (key === 'delete' || key === 'backspace') {
    if (SEQ.prSelection && SEQ.prSelection.size > 0 && SEQ.pianoRollOpen) {
      e.preventDefault();
      const { track, clip } = focusedClipObjects();
      if (clip) {
        seqCheckpoint();
        clip.notes = clip.notes.filter(n => !SEQ.prSelection.has(n));
        SEQ.prSelection.clear();
        renderPianoRoll();
        if (track) { seqRenderTrack(track); seqResyncTrack(track); }
        seqSave();
      }
      return;
    }
    if (SEQ.selection.length > 0) { e.preventDefault(); seqDeleteSelection(); return; }
  }

  if (key === ' ' && !e.shiftKey) {
    e.preventDefault();
    if (!heldKeys.has(key)) {
      heldKeys.add(key);
      const prBody = document.getElementById('seq-pianoroll-body');
      const wrap   = document.getElementById('seq-lane-wrap');
      if (prBody) { SEQ._prSpaceHeld = true; prBody.classList.add('pr-pan-mode'); }
      if (wrap)   { SEQ._arrSpaceHeld = true; wrap.classList.add('arr-pan-mode'); }
    }
    return;
  }
  if (heldKeys.has(key)) return;
  heldKeys.add(key);
  if (key === ' ' && e.shiftKey) { e.preventDefault(); flashHint('hint-space'); if (SEQ.playing) seqStop(); else seqPlay(); return; }
  if (key === 'p') { e.preventDefault(); flashHint('hint-panic'); panic(); return; }
  if (key === 'arrowleft')  { e.preventDefault(); flashHint('hint-lr'); setKey(state.currentTemplate, (state.keys[state.currentTemplate] + 11) % 12); return; }
  if (key === 'arrowright') { e.preventDefault(); flashHint('hint-lr'); setKey(state.currentTemplate, (state.keys[state.currentTemplate] + 1)  % 12); return; }
  if (key === 'arrowdown')  { e.preventDefault(); flashHint('hint-ud'); state.octave = Math.max(0, state.octave - 1); updateControlDisplays(); rebuildBoard(); return; }
  if (key === 'arrowup')    { e.preventDefault(); flashHint('hint-ud'); state.octave = Math.min(8, state.octave + 1); updateControlDisplays(); rebuildBoard(); return; }
  // Disable pad shortcuts when the Chord Pad section is hidden — no
  // visible pads to trigger.
  if (document.body.classList.contains('hide-chord-pad')) return;
  if (state.currentTemplate === 'scale-chords') {
    const sc = scaleKeymap[key];
    if (sc) { e.preventDefault(); playChord(sc.padId, sc.interval, sc.q); }
    return;
  }
  const found = findChordByKey(key);
  if (found) {
    e.preventDefault();
    if (e.shiftKey && found.chord.ext) {
      const extQ = extQuality(found.chord.q, found.chord.ext);
      if (extQ) { playChord(found.padId, found.chord.interval, extQ); return; }
    }
    playChord(found.padId, found.chord.interval, found.chord.q);
  }
});

document.addEventListener('keyup', (e) => {
  const key = getBaseKey(e);
  heldKeys.delete(key);
  if (key === ' ' && SEQ._prSpaceHeld) {
    SEQ._prSpaceHeld = false;
    document.getElementById('seq-pianoroll-body')?.classList.remove('pr-pan-mode');
  }
  if (key === ' ' && SEQ._arrSpaceHeld) {
    SEQ._arrSpaceHeld = false;
    document.getElementById('seq-lane-wrap')?.classList.remove('arr-pan-mode');
  }
  if (state.currentTemplate === 'scale-chords') {
    const sc = scaleKeymap[key];
    if (sc) releaseChord(sc.padId);
    return;
  }
  const found = findChordByKey(key);
  if (found) releaseChord(found.padId);
});

window.addEventListener('blur', () => { releaseAll(); heldKeys.clear(); });
document.addEventListener('pointerup', () => {
  const el = document.activeElement;
  if (el && el.tagName === 'INPUT' && el.type === 'range') el.blur();
});
document.addEventListener('change', (e) => {
  if (e.target.tagName === 'SELECT') e.target.blur();
});
window.addEventListener('resize', () => { scheduleDraw(); updateNeapolitanSplit(); });
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(scheduleDraw);
}

// ============================================================
// KEYBOARD
// ============================================================
const KB_WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);
const KB_START     = 21;  // A0
const KB_END       = 108; // C8
const KB_WW        = 28;  // white key width px (fixed, keyboard scrolls)
const KB_WH        = 72;
const KB_BW        = 17;
const KB_BH        = 44;

const kbActive = new Map(); // midi → audioNode

function kbNoteOn(midi, sendMidi = true) {
  if (kbActive.has(midi)) return;
  // Route through the keyboard's own synth + instrument (set via the
  // keyboard panel's settings cog). Falls back to the chord-pad voice
  // if the virtual keyboard track isn't initialised yet.
  let node = null;
  const kbTrack = state.keyboardTrack;
  if (kbTrack && kbTrack.synth && typeof withSynth === 'function') {
    withSynth(kbTrack.synth, () => {
      node = startAudioNote(midi, state.velocity, null, null, kbTrack.instrument);
    });
  } else {
    node = startAudioNote(midi, state.velocity);
  }
  if (sendMidi) sendNoteOn(midi, state.velocity);
  kbActive.set(midi, node);
  document.querySelector(`.kb-key[data-midi="${midi}"]`)?.classList.add('active');
  if (typeof updateChordAnalyzer === 'function') updateChordAnalyzer();
  if (REC.active) {
    const rawBeat = Math.round(recCurrentBeat() * 2) / 2;
    const startBeat = SEQ.loop ? rawBeat % SEQ.loopEnd : rawBeat;
    if (sendMidi) {
      REC.pendingNotes.set(midi, { label: midiNoteLabel(midi), startBeat });
    } else {
      const rawBeatMidi = recCurrentBeat();
      const startBeatMidi = SEQ.loop ? rawBeatMidi % SEQ.loopEnd : rawBeatMidi;
      REC.pendingMidi.set(midi, { label: midiNoteLabel(midi), startBeat: startBeatMidi });
    }
  }
}

function kbNoteOff(midi, sendMidi = true) {
  if (!kbActive.has(midi)) return;
  const node = kbActive.get(midi);
  // Audio node may be null (engine off, SF2 not loaded yet, …) but
  // we must still drop the entry, otherwise the analyzer sees ghost
  // notes that the user never thinks they're holding.
  if (node) stopAudioNote(node);
  if (sendMidi) sendNoteOff(midi);
  kbActive.delete(midi);
  document.querySelector(`.kb-key[data-midi="${midi}"]`)?.classList.remove('active');
  if (typeof updateChordAnalyzer === 'function') updateChordAnalyzer();
  if (REC.active && REC.pendingNotes.has(midi)) {
    const p = REC.pendingNotes.get(midi);
    const beats = Math.max(0.5, Math.round(recCurrentBeat() * 2) / 2 - p.startBeat) || 0.5;
    const trk = ensureTrackOfKind('free');
    trk.items.push(makeClip({
      start: p.startBeat, beats, label: p.label,
      notes: [{ midi, label: p.label, start: 0, beats }],
    }));
    trk.items.sort((a, b) => a.start - b.start);
    seqAutoExtendLoop(p.startBeat + beats);
    seqRenderTrack(trk);
    seqResyncTrack(trk);
    REC.pendingNotes.delete(midi);
  }
  if (REC.active && REC.pendingMidi.has(midi)) {
    const p = REC.pendingMidi.get(midi);
    const beats = Math.max(0.1, recCurrentBeat() - p.startBeat);
    const trk = ensureTrackOfKind('free');
    trk.items.push(makeClip({
      start: p.startBeat, beats, label: p.label,
      notes: [{ midi, label: p.label, start: 0, beats }],
    }));
    trk.items.sort((a, b) => a.start - b.start);
    seqAutoExtendLoop(p.startBeat + beats);
    seqRenderTrack(trk);
    seqResyncTrack(trk);
    REC.pendingMidi.delete(midi);
  }
}

function initKbDragStrip() {
  const nav   = document.getElementById('kb-scroll-nav');
  const thumb = document.getElementById('kb-drag-thumb');
  const track = nav?.querySelector('.kb-scroll-track');
  const wrap  = nav?.closest('.keyboard-panel')?.querySelector('.kb-wrap');
  if (!nav || !wrap) return;

  function updateThumb() {
    if (!thumb || !track) return;
    // Hide the whole scroll-nav strip when the keyboard isn't scrollable.
    const scrollable = wrap.scrollWidth > wrap.clientWidth + 1;
    nav.style.display = scrollable ? '' : 'none';
    if (!scrollable) return;
    const ratio      = wrap.clientWidth / wrap.scrollWidth;
    const thumbW     = Math.max(20, track.clientWidth * ratio);
    const maxLeft    = track.clientWidth - thumbW;
    const scrollFrac = wrap.scrollLeft / (wrap.scrollWidth - wrap.clientWidth || 1);
    thumb.style.width = thumbW + 'px';
    thumb.style.left  = (scrollFrac * maxLeft) + 'px';
  }
  wrap.addEventListener('scroll', updateThumb);
  requestAnimationFrame(updateThumb);
  // Re-check on resize — keyboard might become scrollable / not.
  window.addEventListener('resize', updateThumb);

  // Drag on the track scrolls proportionally
  function startTrackDrag(clientX) {
    const startX      = clientX;
    const startScroll = wrap.scrollLeft;
    const scale       = (wrap.scrollWidth - wrap.clientWidth) / (track.clientWidth - (thumb?.clientWidth ?? 0) || 1);
    return (x) => { wrap.scrollLeft = startScroll + (x - startX) * scale; };
  }

  if (track) {
    track.addEventListener('touchstart', (e) => {
      const move = startTrackDrag(e.touches[0].clientX);
      const onMove = (ev) => move(ev.touches[0].clientX);
      const onEnd  = () => { track.removeEventListener('touchmove', onMove); track.removeEventListener('touchend', onEnd); };
      track.addEventListener('touchmove',   onMove, { passive: true });
      track.addEventListener('touchend',    onEnd);
      track.addEventListener('touchcancel', onEnd);
    }, { passive: true });

    track.addEventListener('mousedown', (e) => {
      const move = startTrackDrag(e.clientX);
      const onMove = (ev) => move(ev.clientX);
      const onUp   = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  // Arrow buttons — continuous RAF scroll while held, pointer capture prevents mouseleave jank
  function holdScroll(btn, dir) {
    let rafId = null;
    const tick  = () => { wrap.scrollLeft += dir * 4; rafId = requestAnimationFrame(tick); };
    const start = (e) => { e.preventDefault(); btn.setPointerCapture(e.pointerId); if (!rafId) rafId = requestAnimationFrame(tick); };
    const stop  = () => { cancelAnimationFrame(rafId); rafId = null; };
    btn.addEventListener('pointerdown',  start);
    btn.addEventListener('pointerup',    stop);
    btn.addEventListener('pointercancel', stop);
  }

  holdScroll(document.getElementById('kb-scroll-left'),  -1);
  holdScroll(document.getElementById('kb-scroll-right'),  1);
}

function initTouchGlide() {
  // Keyboard glide
  const kbWrap = document.getElementById('kb-container')?.parentElement;
  if (kbWrap) {
    let glideMidi = null;
    kbWrap.addEventListener('touchmove', (e) => {
      const t   = e.touches[0];
      const el  = document.elementFromPoint(t.clientX, t.clientY);
      const key = el?.closest('.kb-key');
      const midi = key ? +key.dataset.midi : null;
      if (midi === glideMidi) return;
      if (glideMidi !== null) kbNoteOff(glideMidi);
      glideMidi = midi;
      if (midi !== null && !kbActive.has(midi)) kbNoteOn(midi);
    }, { passive: true });
    const kbGlideEnd = () => { if (glideMidi !== null) { kbNoteOff(glideMidi); glideMidi = null; } };
    kbWrap.addEventListener('touchend',    kbGlideEnd);
    kbWrap.addEventListener('touchcancel', kbGlideEnd);
  }

  // Chord pad glide — attach to app root so bubbling from any page works
  const app = document.querySelector('.app');
  if (!app) return;
  let glidePadId = null;
  app.addEventListener('touchmove', (e) => {
    const t   = e.touches[0];
    const el  = document.elementFromPoint(t.clientX, t.clientY);
    const pad = el?.closest('.pad[data-interval]');
    const padId = pad?.id ?? null;
    if (padId === glidePadId) return;
    if (glidePadId !== null) releaseChord(glidePadId);
    glidePadId = padId;
    if (pad && !state.activeChords.has(padId)) {
      const interval     = +pad.dataset.interval;
      const q            = pad.dataset.q;
      const bassInterval = pad.dataset.bassInterval !== '' ? +pad.dataset.bassInterval : undefined;
      playChord(padId, interval, q, bassInterval);
    }
  }, { passive: true });
  const padGlideEnd = () => { if (glidePadId !== null) { releaseChord(glidePadId); glidePadId = null; } };
  app.addEventListener('touchend',    padGlideEnd);
  app.addEventListener('touchcancel', padGlideEnd);
}

function buildKeyboard() {
  const container = document.getElementById('kb-container');
  if (!container) return;
  if (document.getElementById('keyboard-panel').classList.contains('collapsed')) return;

  container.innerHTML = '';
  container.style.height = KB_WH + 'px';

  let whiteIdx = 0;
  // First pass: count total whites to set container width
  let totalWhites = 0;
  for (let m = KB_START; m <= KB_END; m++) if (KB_WHITE_PCS.has(m % 12)) totalWhites++;
  container.style.width = (totalWhites * KB_WW) + 'px';

  for (let midi = KB_START; midi <= KB_END; midi++) {
    const pc      = midi % 12;
    const isWhite = KB_WHITE_PCS.has(pc);
    const octave  = Math.floor(midi / 12) - 1;
    const key     = document.createElement('div');
    key.dataset.midi = midi;

    if (isWhite) {
      key.className  = 'kb-key kb-white';
      key.style.left   = (whiteIdx * KB_WW) + 'px';
      key.style.width  = (KB_WW - 1) + 'px';
      key.style.height = KB_WH + 'px';
      if (pc === 0) {
        const lbl = document.createElement('span');
        lbl.className   = 'kb-note-label';
        lbl.textContent = `C${octave}`;
        key.appendChild(lbl);
      }
      whiteIdx++;
    } else {
      key.className  = 'kb-key kb-black';
      key.style.left   = Math.round(whiteIdx * KB_WW - KB_BW / 2) + 'px';
      key.style.width  = KB_BW + 'px';
      key.style.height = KB_BH + 'px';
    }

    addKbHandlers(key, midi);
    container.appendChild(key);
  }

  // Scroll so C4 (MIDI 60) is centred. White-key index of C4 = 23
  // counting from A0=0 (A0 B0 C1 D1 … B3 = 22 whites before C4).
  const c4WhiteIdx = 23;
  const wrap = container.parentElement;
  wrap.scrollLeft = Math.max(0, c4WhiteIdx * KB_WW + KB_WW / 2 - wrap.clientWidth / 2);
}

function addKbHandlers(key, midi) {
  key.draggable = true;
  key.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    if (!seqIsOpen()) { e.preventDefault(); return; }
    const label = midiNoteName(midi);
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/x-note', JSON.stringify({ midi, label }));
    SEQ._dragLabel = label;
    const ghost = document.createElement('div');
    ghost.textContent = label;
    ghost.style.cssText = 'position:fixed;top:-999px;padding:3px 7px;background:#1a1b1e;border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#fff;font-family:monospace;font-size:11px;white-space:nowrap';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    setTimeout(() => ghost.remove(), 0);
    document.body.classList.add('seq-dragging-note');
    setTimeout(() => document.querySelector('#seq-note-lane .seq-drop-hint')?.style.setProperty('color', 'var(--accent)'), 0);
  });
  key.addEventListener('dragend', () => {
    document.body.classList.remove('seq-dragging-note');
    document.querySelector('#seq-note-lane .seq-drop-hint')?.style.removeProperty('color');
  });
  key.addEventListener('pointerdown',  () => kbNoteOn(midi));
  key.addEventListener('pointerup',    () => kbNoteOff(midi));
  key.addEventListener('pointerleave', () => kbNoteOff(midi));
  key.addEventListener('pointercancel',() => kbNoteOff(midi));
  key.addEventListener('pointerenter', (e) => { if (e.buttons > 0) kbNoteOn(midi); });
  seqAddTouchDrag(key, 'seq-note-lane', () => ({ midi, label: midiNoteName(midi) }), () => kbNoteOff(midi));
}
