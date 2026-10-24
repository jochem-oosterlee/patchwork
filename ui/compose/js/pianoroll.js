// ============================================================
// PIANO-ROLL DETAIL VIEW
// ============================================================
//
// Extracted from chord-pad.js. Loaded AFTER chord-pad.js in the HTML
// because this module accesses the SEQ global at parse time (line:
// `SEQ.focusedClip = null;` and the closing IIFE's `SEQ.prShowKeyboard
// = true;`) and SEQ is initialized by chord-pad.js.
//
// Cross-file dependencies (resolved at runtime via window scope):
//   state, SEQ, BEAT_PX, PR_BEAT_PX                    (chord-pad.js globals)
//   getAudioCtx, startAudioNote, stopAudioNote, withSynth  (audio.js)
//   sendNoteOn, sendNoteOff, midiPortById              (midi.js)
//   seqCheckpoint, seqSave, seqAutoExtendLoop          (chord-pad.js)
//   seqRenderTrack, seqResyncTrack, seqResyncTrackThrottled
//   trackById, makeClip, seqTrackInstrument
//   midiNoteLabel, midiNoteName, chordToMidiNotes
//   prCopyNotes, prCutNotes, prPasteNotes, prDuplicateNotes,
//   prDeleteNotes, prSelectAllNotes, prRollHasNoteSelection
//     (these are clip-notes clipboard ops still defined in chord-pad.js)
//   refreshLucide, syncTrackLabelHeights, escapeHtml, focusedClipObjects
//   rollSnap, rollSnapFloor, rollSnapBeat, prKbW
//
// Public surface (called from chord-pad.js and elsewhere):
//   focusedClipObjects, renderPianoRoll, refreshPianoRollTitle,
//   showPianoRoll, hidePianoRoll, togglePianoRoll, openPianoRoll,
//   closePianoRoll, prSetTool, prPreviewMidi
//
// The trailing IIFE in this file wires every pointer/drag listener for
// the roll body, ruler, keyboard sidebar, and chord-drop drop-zone, and
// finishes with an initial renderPianoRoll() so the empty roll is
// visible on load.

// ============================================================
// Piano-roll detail-view (opens at the bottom of the sequencer when a
// free track is focused — full-width note editor)
// ============================================================
SEQ.focusedClip = null; // { trackId, clipId } or null
SEQ.pianoRollOpen = true;

function focusedClipObjects() {
  if (!SEQ.focusedClip) return { track: null, clip: null };
  // Prefer direct refs (set by openPianoRoll) so duplicate clip ids
  // never cause `find()` to return the wrong clip. Only fall back to
  // id-based lookup if the refs went stale (e.g. project reload).
  const refT = SEQ.focusedClip._trackRef;
  const refC = SEQ.focusedClip._clipRef;
  if (refT && refC
      && SEQ.tracksList.indexOf(refT) >= 0
      && refT.items.indexOf(refC) >= 0) {
    return { track: refT, clip: refC };
  }
  const track = trackById(SEQ.focusedClip.trackId);
  if (!track) return { track: null, clip: null };
  const clip = track.items.find(c => c.id === SEQ.focusedClip.clipId);
  return { track, clip };
}

function showPianoRoll() {
  SEQ.pianoRollOpen = true;
  const panel = document.getElementById('seq-pianoroll');
  if (panel) panel.hidden = false;
  document.getElementById('seq-pianoroll-toggle')?.classList.add('active');
  refreshPianoRollTitle();
  renderPianoRoll();
}

function hidePianoRoll() {
  SEQ.pianoRollOpen = false;
  const panel = document.getElementById('seq-pianoroll');
  if (panel) panel.hidden = true;
  document.getElementById('seq-pianoroll-toggle')?.classList.remove('active');
  document.querySelectorAll('.seq-clip-block.focused').forEach(el => el.classList.remove('focused'));
}

function togglePianoRoll() {
  if (SEQ.pianoRollOpen) hidePianoRoll(); else showPianoRoll();
}

function openPianoRoll(track, clip) {
  if (!track || track.kind !== 'free' || !clip) return;
  // Store the direct refs alongside the ids — focusedClipObjects
  // prefers refs so duplicate clip ids don't open the wrong one.
  SEQ.focusedClip = {
    trackId: track.id, clipId: clip.id,
    _trackRef: track, _clipRef: clip,
  };
  // Re-center C4 on every open — clear the init flag so renderPianoRoll
  // re-applies the scrollTop.
  const body = document.getElementById('seq-pianoroll-body');
  if (body) delete body.dataset.initialized;
  showPianoRoll();
  refreshPianoRollTitle();
  document.querySelectorAll('.seq-clip-block.focused').forEach(el => el.classList.remove('focused'));
  // Add .focused via lane + items-index so duplicate clip ids don't
  // highlight the wrong block.
  const lane = document.querySelector(`.seq-lane[data-track-id="${track.id}"]`);
  if (lane) {
    const idx = track.items.indexOf(clip);
    if (idx >= 0) lane.querySelectorAll(':scope > .seq-clip-block')[idx]?.classList.add('focused');
  }
}

function closePianoRoll() { hidePianoRoll(); }

function refreshPianoRollTitle() {
  const titleEl = document.getElementById('seq-pianoroll-title');
  if (!titleEl) return;
  const { track, clip } = focusedClipObjects();
  if (!track || !clip) {
    titleEl.textContent = 'No clip selected';
    titleEl.classList.add('muted');
    return;
  }
  titleEl.textContent = track.name;
  titleEl.classList.remove('muted');
}

const PR_ROW_H = 12;
// Auto-scroll a container horizontally when the pointer drags near its
// left/right edges. Returns true if scrolling happened.
function _edgeAutoScroll(container, clientX) {
  if (!container) return false;
  const rect = container.getBoundingClientRect();
  const threshold = 50;
  const maxStep = 18;
  if (clientX > rect.right - threshold) {
    const step = Math.min(maxStep, Math.ceil((clientX - (rect.right - threshold)) / 2));
    container.scrollLeft += step;
    return true;
  }
  if (clientX < rect.left + threshold) {
    const step = Math.min(maxStep, Math.ceil(((rect.left + threshold) - clientX) / 2));
    container.scrollLeft -= step;
    return true;
  }
  return false;
}
const PR_KB_W = 30;
const prKbW = () => (SEQ.prShowKeyboard ? PR_KB_W : 0);
SEQ.prTool = SEQ.prTool || 'select'; // 'select' | 'draw' | 'erase' | 'pan'
SEQ.prSelection = SEQ.prSelection || new Set();
function _prSyncSelection(body) {
  if (!body) return;
  body.querySelectorAll('.pr-note').forEach((el) => el.classList.remove('selected'));
  const { clip } = focusedClipObjects();
  if (!clip) return;
  const noteEls = body.querySelectorAll('.pr-note');
  clip.notes.forEach((n, i) => {
    if (SEQ.prSelection.has(n) && noteEls[i]) noteEls[i].classList.add('selected');
  });
  // Mirror the selection-tint + active state onto the velocity bars.
  const lane = document.getElementById('seq-pr-vel-lane');
  if (lane) {
    const bars = lane.querySelectorAll('.pr-vel-bar');
    const hasSelection = SEQ.prSelection.size > 0;
    clip.notes.forEach((n, i) => {
      if (!bars[i]) return;
      const sel = SEQ.prSelection.has(n);
      bars[i].classList.toggle('selected', sel);
      bars[i].classList.toggle('inactive', hasSelection && !sel);
    });
  }
}
function prSetTool(tool) {
  SEQ.prTool = tool;
  ['select', 'pen', 'erase', 'pan'].forEach((t) => {
    const id = t === 'pen' ? 'seq-tool-pen' : (t === 'select' ? 'seq-tool-select' : (t === 'erase' ? 'seq-tool-erase' : 'seq-tool-pan'));
    document.getElementById(id)?.classList.toggle('active', SEQ.prTool === (t === 'pen' ? 'draw' : t));
  });
  const body = document.getElementById('seq-pianoroll-body');
  if (body) {
    body.classList.remove('pr-tool-select','pr-tool-draw','pr-tool-erase','pr-tool-pan');
    body.classList.add('pr-tool-' + tool);
  }
}
function prPreviewMidi(track, midi) {
  if (!track) return;
  // No previews while playback is running — the user is listening
  // to the song, not auditioning notes.
  if (SEQ.playing) return;
  const inst = track.instrument || state.instrument;
  const play = () => {
    const node = startAudioNote(midi, state.velocity, null, null, inst);
    if (node) {
      SEQ.activeNodes.add(node);
      setTimeout(() => { try { stopAudioNote(node); } catch (_) {} SEQ.activeNodes.delete(node); }, 700);
    }
  };
  if (track.synth) withSynth(track.synth, play); else play();
}
function _prPitchRange(_notes) {
  // Full piano range A0..C8 so the keyboard is always complete and no
  // empty space appears below the visible keys.
  return { lo: 21, hi: 108 };
}

function renderPianoRoll() {
  const body  = document.getElementById('seq-pianoroll-body');
  if (!body) return;
  const wasInitialized = body.dataset.initialized === '1';
  body.innerHTML = '';
  const { track, clip } = focusedClipObjects();
  body.dataset.trackId = track ? track.id : '';
  body.dataset.clipId  = clip ? clip.id : '';
  const { lo, hi } = _prPitchRange(clip ? clip.notes : []);
  const rows = hi - lo + 1;
  const clipBeats = clip ? clip.beats : 4;
  // Extend scrollable width well past the clip so you can pan into empty
  // territory — at least 32 bars beyond the clip's last beat.
  const bpb       = state.beatsPerBar;
  // Round up to a whole-bar boundary so the bar-line gradient's rightmost
  // edge actually renders (otherwise the last partial tile clips it off and
  // you get a blank strip at the very end of the sizer).
  const rawBeats  = Math.max(clipBeats, 4) + 32 * bpb;
  const minBeats  = Math.ceil(rawBeats / bpb) * bpb;
  const contentW  = minBeats * PR_BEAT_PX + prKbW();
  const contentH  = rows * PR_ROW_H;
  body.style.minWidth  = '';
  body.style.minHeight = '';
  body.style.setProperty('--pr-octave-offset', ((((hi % 12) + 12) % 12) * PR_ROW_H + PR_ROW_H) + 'px');
  body.style.setProperty('--pr-content-left', prKbW() + 'px');
  const sizer = document.createElement('div');
  sizer.className = 'pr-sizer';
  // Sizer carries the grid background so tiles cover the full scrollable
  // area (the body itself only paints across clientWidth even with
  // background-attachment:local in some browsers).
  sizer.style.cssText = `position:absolute;top:0;left:0;width:${contentW}px;height:${contentH}px;pointer-events:none;`;
  body.appendChild(sizer);

  // Bar-numbers ruler — lives ABOVE the body and scrolls horizontally in
  // sync with it (but never vertically with the keyboard). Extends to at
  // least the visible width so bar numbers cover the whole roll.
  const prRuler = document.getElementById('seq-pianoroll-ruler');
  // Match the rulerwrap's inner width to the body's clientWidth so that 1:1
  // scrollLeft sync stays accurate end-to-end. (Body has a vertical scrollbar
  // that shaves a few px off its clientWidth, plus 1px borders both sides;
  // the wrap has neither — without this fix the bar markers drift ~5-20px
  // over the full scroll range.)
  const rulerWrap = document.getElementById('seq-pianoroll-rulerwrap');
  if (rulerWrap) rulerWrap.style.width = (body.clientWidth || 0) + 'px';
  if (prRuler) {
    const visibleW = body.clientWidth || 0;
    const rulerW   = Math.max(contentW, visibleW);
    prRuler.style.width = rulerW + 'px';
    const bpb = state.beatsPerBar;
    const totalBeats = Math.ceil((rulerW - prKbW()) / PR_BEAT_PX);
    const totalBars  = Math.ceil(totalBeats / bpb);
    let prRulerHTML = '';
    for (let bar = 0; bar < totalBars; bar++) {
      const left = bar * bpb * PR_BEAT_PX + prKbW();
      prRulerHTML += `<div class="pr-ruler-bar" style="left:${left}px"><span>${bar + 1}</span></div>`;
      for (let b = 1; b < bpb; b++) {
        prRulerHTML += `<div class="pr-ruler-beat" style="left:${left + b * PR_BEAT_PX}px"></div>`;
      }
    }
    prRuler.innerHTML = prRulerHTML;
  }
  // Sync horizontal scroll between body and ruler-wrap so bar markers
  // follow the content as the user pans / drags.
  if (!body.dataset.rulerSyncBound) {
    body.dataset.rulerSyncBound = '1';
    body.addEventListener('scroll', () => {
      const wrap = document.getElementById('seq-pianoroll-rulerwrap');
      if (wrap) {
        // wrap width is synced to body.clientWidth in renderPianoRoll, so a
        // straight 1:1 scrollLeft match keeps the bar markers aligned with
        // the grid over the entire scroll range.
        wrap.scrollLeft = body.scrollLeft;
      }
      _prUpdateOverflowEdges();
    });
  }
  // Click-to-set play cursor on the piano-roll ruler. Drag-detection so
  // scrolling/panning doesn't move the cursor.
  if (prRuler && !prRuler.dataset.clickInit) {
    prRuler.dataset.clickInit = '1';
    let dX = null, dY = null;
    prRuler.addEventListener('pointerdown', (e) => { dX = e.clientX; dY = e.clientY; });
    prRuler.addEventListener('pointerup', (e) => {
      if (dX == null) return;
      const dx = Math.abs(e.clientX - dX), dy = Math.abs(e.clientY - dY);
      dX = dY = null;
      if (dx > 3 || dy > 3) return;
      const rect = prRuler.getBoundingClientRect();
      const wrap = document.getElementById('seq-pianoroll-rulerwrap');
      const scrollL = wrap ? wrap.scrollLeft : 0;
      const clipRelBeat = Math.max(0, Math.round(((e.clientX - rect.left + scrollL - prKbW()) / PR_BEAT_PX) * 2) / 2);
      const { clip } = focusedClipObjects();
      const songBeat = (clip ? clip.start : 0) + clipRelBeat;
      SEQ.startBeat = songBeat;
      SEQ.animBeat  = songBeat;
      // Arrangement playhead = song-absolute beat.
      document.querySelectorAll('.seq-playhead-global, .seq-lane .seq-playhead').forEach(ph => {
        ph.style.display = 'block';
        ph.style.left = (songBeat * BEAT_PX) + 'px';
      });
      // Piano-roll playhead = clip-relative + keyboard offset.
      const prPh = body.querySelector('.seq-playhead');
      if (prPh) {
        prPh.style.display = 'block';
        prPh.style.left = (clipRelBeat * PR_BEAT_PX + prKbW()) + 'px';
      }
    });
  }
  body._prHi = hi;
  body._prLo = lo;

  // Piano keyboard sidebar — proper piano layout: 7 tall white keys per
  // octave with 5 shorter/narrower black keys overlaid between them.
  // Doesn't line up 1:1 with the per-semitone note grid, that's fine.
  if (SEQ.prShowKeyboard) {
    const kb = document.createElement('div');
    kb.className = 'pr-keyboard';
    const totalH = rows * PR_ROW_H;
    kb.style.height = totalH + 'px';
    const isBlack = (m) => { const s = ((m % 12) + 12) % 12; return s===1||s===3||s===6||s===8||s===10; };
    const half = PR_ROW_H / 2;
    const attachKeyClick = (row, midi) => {
      row.dataset.midi = midi;
      row.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        prPreviewMidi(track, midi);
      });
    };
    for (let m = hi; m >= lo; m--) {
      if (isBlack(m)) continue;
      const rowTop = (hi - m) * PR_ROW_H;
      const hasBlackAbove = isBlack(m + 1) && (m + 1 <= hi);
      const hasBlackBelow = isBlack(m - 1) && (m - 1 >= lo);
      const top    = rowTop - (hasBlackAbove ? half : 0);
      const bottom = rowTop + PR_ROW_H + (hasBlackBelow ? half : 0);
      const row = document.createElement('div');
      row.className = 'pr-keyboard-row';
      row.style.top    = top + 'px';
      row.style.height = (bottom - top - 1) + 'px';
      row.textContent  = (m % 12 === 0) ? midiNoteLabel(m) : '';
      attachKeyClick(row, m);
      kb.appendChild(row);
    }
    for (let m = hi; m >= lo; m--) {
      if (!isBlack(m)) continue;
      const row = document.createElement('div');
      row.className = 'pr-keyboard-row black';
      row.style.top    = ((hi - m) * PR_ROW_H) + 'px';
      row.style.height = PR_ROW_H + 'px';
      attachKeyClick(row, m);
      kb.appendChild(row);
    }
    body.appendChild(kb);
  }

  if (clip && clip.notes.length > 0) {
    for (let i = 0; i < clip.notes.length; i++) {
      const note = clip.notes[i];
      body.appendChild(_prMakeNote(track, clip, note, i, hi));
    }
  }

  _prAppendOverlays(body);
  _prRebuildOverflowEdges();
  if (!wasInitialized) {
    // Center on the clip's notes if it has any; otherwise fall back to C4.
    let centerMidi = 60;
    if (clip && clip.notes && clip.notes.length > 0) {
      const midis = clip.notes.map(n => n.midi);
      centerMidi = Math.round((Math.min(...midis) + Math.max(...midis)) / 2);
    }
    const centerTop = (hi - centerMidi) * PR_ROW_H;
    body.scrollTop = Math.max(0, centerTop - body.clientHeight / 2 + PR_ROW_H / 2);
    body.dataset.initialized = '1';
    // After auto-scrolling on first open, re-evaluate edges.
    _prUpdateOverflowEdges();
  }
  renderVelocityLane();
}

// (Re)build one off-screen edge-tick per note in the focused clip.
// Position + width are fixed once at render time; display + vertical
// position are updated on scroll by _prUpdateOverflowEdges below.
function _prRebuildOverflowEdges() {
  const body = document.getElementById('seq-pianoroll-body');
  if (!body) return;
  body.querySelectorAll('.pr-overflow-edge-tick').forEach(el => el.remove());
  if (typeof focusedClipObjects !== 'function') return;
  const { clip } = focusedClipObjects();
  if (!clip || !Array.isArray(clip.notes)) return;
  for (const n of clip.notes) {
    const el = document.createElement('div');
    el.className = 'pr-overflow-edge-tick';
    el.dataset.midi = n.midi;
    el.style.left   = (n.start * PR_BEAT_PX + prKbW()) + 'px';
    el.style.width  = (n.beats * PR_BEAT_PX) + 'px';
    el.style.display = 'none';
    body.appendChild(el);
  }
  _prUpdateOverflowEdges();
}

// Show / position each tick depending on whether its note sits above
// or below the currently visible pitch range, pinned to the top or
// bottom of the body viewport at the note's time-position.
function _prUpdateOverflowEdges() {
  const body = document.getElementById('seq-pianoroll-body');
  if (!body || body._prHi == null) return;
  const top = body.scrollTop;
  const bot = top + body.clientHeight;
  body.querySelectorAll('.pr-overflow-edge-tick').forEach(el => {
    const midi = +el.dataset.midi;
    const nTop = (body._prHi - midi) * PR_ROW_H;
    const nBot = nTop + PR_ROW_H;
    if (nBot <= top + 0.5) {
      el.style.display = 'block';
      el.style.top = top + 'px';
      el.classList.add('is-above');
      el.classList.remove('is-below');
    } else if (nTop >= bot - 0.5) {
      el.style.display = 'block';
      el.style.top = (bot - 2) + 'px';
      el.classList.add('is-below');
      el.classList.remove('is-above');
    } else {
      el.style.display = 'none';
      el.classList.remove('is-above', 'is-below');
    }
  });
}

// Strip below the piano-roll body showing one vertical bar per note in
// the focused clip. Bar height = note.velocity / 127. Drag a bar up/down
// to change that note's velocity. Stays horizontally aligned with the
// body via the body.scroll listener at the top of renderPianoRoll.
function renderVelocityLane() {
  const lane = document.getElementById('seq-pr-vel-lane');
  if (!lane) return;
  lane.innerHTML = '';
  const body = document.getElementById('seq-pianoroll-body');
  const { track, clip } = focusedClipObjects();
  if (!clip || !body) { lane.style.display = 'none'; return; }
  lane.style.display = '';
  const kbW = prKbW();
  // Match the body's content width so bars line up under their notes.
  const sizer = body.querySelector('.pr-sizer');
  if (sizer) lane.style.setProperty('--pr-vel-content-w', sizer.style.width);
  // Inner scroll-syncs container so bars track the body's scrollLeft.
  const inner = document.createElement('div');
  inner.className = 'seq-pr-vel-inner';
  inner.style.width = sizer ? sizer.style.width : '100%';
  lane.appendChild(inner);
  // Render bars: thin vertical stick at each note's attack (note.start),
  // shifted right by the piano-keyboard width so x lines up with the
  // note in the body above. Width is fixed (DAW-style); height = velocity.
  // When a selection exists, only selected notes' bars are interactive
  // — non-selected bars dim out and ignore pointer events. Solves the
  // overlap problem when several notes in a chord share a start time.
  const BAR_W = 4;
  const hasSelection = SEQ.prSelection && SEQ.prSelection.size > 0;
  clip.notes.forEach((note, idx) => {
    const vel = (typeof note.velocity === 'number') ? note.velocity : 100;
    const isSelected = SEQ.prSelection?.has(note);
    const bar = document.createElement('div');
    bar.className = 'pr-vel-bar'
      + (isSelected ? ' selected' : '')
      + (hasSelection && !isSelected ? ' inactive' : '');
    bar.style.left = (note.start * PR_BEAT_PX + kbW) + 'px';
    bar.style.width = BAR_W + 'px';
    bar.style.height = Math.max(2, (vel / 127) * 100) + '%';
    bar.title = `${note.label || ''} · velocity ${vel}`;
    bar.dataset.noteIdx = idx;
    // Vertical drag to adjust velocity.
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      bar.setPointerCapture(e.pointerId);
      seqCheckpoint();
      const rect = lane.getBoundingClientRect();
      const apply = (clientY) => {
        const frac = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        note.velocity = Math.max(1, Math.min(127, Math.round(frac * 127)));
        bar.style.height = Math.max(2, (note.velocity / 127) * 100) + '%';
        bar.title = `${note.label || ''} · velocity ${note.velocity}`;
      };
      apply(e.clientY);
      const onMove = (ev) => apply(ev.clientY);
      const onUp = () => {
        bar.removeEventListener('pointermove', onMove);
        bar.removeEventListener('pointerup', onUp);
        if (track) { invalidateFreeTrackFlat(track); seqResyncTrackThrottled(track); }
        seqSave();
      };
      bar.addEventListener('pointermove', onMove);
      bar.addEventListener('pointerup', onUp);
    });
    inner.appendChild(bar);
  });
  // Keep horizontal scroll in sync with the body.
  if (!lane.dataset.scrollSyncBound) {
    lane.dataset.scrollSyncBound = '1';
    body.addEventListener('scroll', () => { lane.scrollLeft = body.scrollLeft; });
  }
  lane.scrollLeft = body.scrollLeft || 0;
}

// White-key height in the piano-roll sidebar (px). Black keys derive from
// this. Keyboard total height won't match the body grid exactly — accepted
// trade-off for a real piano look.
const PR_KB_WHITE_H = 16;
const PR_KB_BLACK_H = 11;
const PR_KB_WIDTH    = 56;
const PR_KB_BLACK_W  = 36;

function _prBuildPianoKeyboard(lo, hi) {
  const kb = document.createElement('div');
  kb.className = 'pr-keyboard';
  kb.style.width = PR_KB_WIDTH + 'px';

  // Pass 1 (top → bottom): position each white key
  let whiteIdx = 0;
  const whiteTop = {}; // midi → y of top edge
  for (let m = hi; m >= lo; m--) {
    if (!midiIsBlack(m)) {
      whiteTop[m] = whiteIdx * PR_KB_WHITE_H;
      whiteIdx++;
    }
  }
  const totalH = whiteIdx * PR_KB_WHITE_H;
  kb.style.height = totalH + 'px';

  // White keys
  for (const m of Object.keys(whiteTop).map(Number)) {
    const w = document.createElement('div');
    w.className = 'pr-kb-white' + (m % 12 === 0 ? ' octave' : '');
    w.style.top    = whiteTop[m] + 'px';
    w.style.height = (PR_KB_WHITE_H - 1) + 'px';
    if (m % 12 === 0) {
      const lbl = document.createElement('span');
      lbl.className = 'pr-kb-label';
      lbl.textContent = midiNoteLabel(m);
      w.appendChild(lbl);
    }
    kb.appendChild(w);
  }
  // Black keys — centred on the boundary between the white above (m+1) and
  // the white below (m-1).
  for (let m = hi; m >= lo; m--) {
    if (!midiIsBlack(m)) continue;
    const above = whiteTop[m + 1];
    const below = whiteTop[m - 1];
    if (above === undefined || below === undefined) continue;
    const boundary = above + PR_KB_WHITE_H; // = below
    const top = boundary - PR_KB_BLACK_H / 2;
    const b = document.createElement('div');
    b.className = 'pr-kb-black';
    b.style.top    = top + 'px';
    b.style.height = PR_KB_BLACK_H + 'px';
    kb.appendChild(b);
  }
  return kb;
}

function _prAppendOverlays(body) {
  // Only a playhead inside the piano-roll — loop tags/lines stay on the
  // arrangement-view tracks where they belong.
  const ph = document.createElement('div');
  ph.className = 'seq-playhead';
  ph.style.display = 'none'; // shown by seqAnimatePlayhead only while inside the clip
  body.appendChild(ph);
  // Vertical line marking the end of the current clip — anything to the
  // right is "outside" the clip and won't sound at playback.
  const { clip } = focusedClipObjects();
  if (clip) {
    const endLine = document.createElement('div');
    endLine.className = 'pr-clip-end-line';
    endLine.style.left   = (clip.beats * PR_BEAT_PX + prKbW()) + 'px';
    // Span the full sizer height so the line reaches A0 (not just the
    // visible body viewport). PR_ROW_H × rows = pixel height of the grid.
    endLine.style.top    = '0';
    endLine.style.bottom = 'auto';
    endLine.style.height = ((body._prHi - body._prLo + 1) * PR_ROW_H) + 'px';
    body.appendChild(endLine);
  }
}

function _prMakeNote(track, clip, note, idx, hi) {
  const el = document.createElement('div');
  el.className = 'pr-note';
  const lbl = document.createElement('span');
  lbl.className = 'pr-note-text';
  lbl.textContent = note.label || midiNoteLabel(note.midi);
  el.appendChild(lbl);
  el.style.left   = (note.start * PR_BEAT_PX + prKbW()) + 'px';
  el.style.width  = (note.beats * PR_BEAT_PX) + 'px';
  el.style.top    = ((hi - note.midi) * PR_ROW_H) + 'px';
  el.style.height = (PR_ROW_H - 2) + 'px';
  // Mark notes that extend past the clip end so the visual makes it obvious
  // that part of the note won't play (clip-end truncates MIDI like Ableton/
  // Logic/Cubase do). --note-clip-frac is the fraction of the note that's
  // still inside the clip; CSS turns the rest into a muted gradient.
  if (note.start + note.beats > clip.beats) {
    const insideBeats = Math.max(0, clip.beats - note.start);
    const frac = note.beats > 0 ? Math.max(0, Math.min(1, insideBeats / note.beats)) : 0;
    el.classList.add('pr-note-overflow');
    el.style.setProperty('--note-clip-frac', String(frac));
  }
  if (SEQ.prSelection.has(note)) el.classList.add('selected');
  // Left/right resize handles
  const resizeL = document.createElement('div');
  resizeL.className = 'pr-note-resize pr-note-resize-left';
  const resizeR = document.createElement('div');
  resizeR.className = 'pr-note-resize pr-note-resize-right';
  el.appendChild(resizeL);
  el.appendChild(resizeR);
  const bindResize = (handle, side) => {
    handle.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      handle.setPointerCapture(ev.pointerId);
      seqCheckpoint();
      const startX = ev.clientX;
      const origStart = note.start, origBeats = note.beats;
      const snap = SEQ.rollSnap ? SEQ.rollSnapVal : 0.25;
      const useGhost = !!SEQ.rollSnap;
      let ghost = null;
      if (useGhost) {
        ghost = document.createElement('div');
        ghost.className = 'pr-note pr-resize-ghost';
        ghost.style.top    = el.style.top;
        ghost.style.height = el.style.height;
        el.parentElement?.appendChild(ghost);
      }
      const onMove = (e2) => {
        const dxBeats = (e2.clientX - startX) / PR_BEAT_PX;
        if (side === 'right') {
          note.beats = Math.max(0.25, origBeats + dxBeats);
        } else {
          const maxDelta = origBeats - 0.25;
          const delta = Math.max(-origStart, Math.min(maxDelta, dxBeats));
          note.start = origStart + delta;
          note.beats = origBeats - delta;
          el.style.left = (note.start * PR_BEAT_PX + prKbW()) + 'px';
        }
        el.style.width = (note.beats * PR_BEAT_PX) + 'px';
        if (ghost) {
          let gStart = note.start, gBeats = note.beats;
          gBeats = Math.max(snap, Math.round(gBeats / snap) * snap);
          if (side === 'left') gStart = Math.max(0, Math.round(gStart / snap) * snap);
          ghost.style.left  = (gStart * PR_BEAT_PX + prKbW()) + 'px';
          ghost.style.width = (gBeats * PR_BEAT_PX) + 'px';
        }
        seqResyncTrackThrottled(track);
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        if (ghost) ghost.remove();
        note.beats = Math.max(snap, Math.round(note.beats / snap) * snap);
        if (side === 'left') note.start = Math.max(0, Math.round(note.start / snap) * snap);
        if (note.start + note.beats > clip.beats) clip.beats = note.start + note.beats;
        seqAutoExtendLoop(clip.start + clip.beats);
        renderPianoRoll();
        seqRenderTrack(track);
        seqResyncTrack(track);
        seqSave();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  };
  bindResize(resizeL, 'left');
  bindResize(resizeR, 'right');
  el.addEventListener('pointerdown', (e) => {
    SEQ._lastZone = 'roll';
    if (e.target === resizeL || e.target === resizeR) return;
    if (SEQ._prSpaceHeld || SEQ.prTool === 'pan') return; // let body handle pan
    e.preventDefault();
    e.stopPropagation();
    if (SEQ.prTool === 'erase') {
      seqCheckpoint();
      const i = clip.notes.indexOf(note);
      if (i >= 0) clip.notes.splice(i, 1);
      renderPianoRoll();
      seqRenderTrack(track);
      seqResyncTrack(track);
      seqSave();
      return;
    }
    if (SEQ.prTool === 'select') {
      if (e.shiftKey) {
        if (SEQ.prSelection.has(note)) SEQ.prSelection.delete(note); else SEQ.prSelection.add(note);
      } else if (!SEQ.prSelection.has(note)) {
        SEQ.prSelection.clear();
        SEQ.prSelection.add(note);
      }
      _prSyncSelection(el.parentElement);
      // fall through to allow drag on the (newly) selected note
    }
    el.setPointerCapture(e.pointerId);
    seqCheckpoint();
    // Audible preview while the note is held — routes through the same
    // path as playback (in-app instrument or external MIDI) so you hear
    // exactly what this note will sound like at playback time. Skipped
    // during playback (you're listening to the song, not the note).
    if (track && !SEQ.playing) {
      if (track.output === 'midi') {
        const port = midiPortById(track.midiPortId);
        const vel  = seqTrackVel(track, state.velocity);
        sendNoteOn(note.midi, vel, track.channel, port);
        const stop = () => sendNoteOff(note.midi, track.channel, port);
        el.addEventListener('pointerup',     stop, { once: true });
        el.addEventListener('pointercancel', stop, { once: true });
      } else if (state.audioEnabled) {
        const inst = seqTrackInstrument(track);
        let previewNode;
        withSynth(track.synth, () => { previewNode = startAudioNote(note.midi, state.velocity, null, null, inst); });
        const stop = () => { if (previewNode) stopAudioNote(previewNode); };
        el.addEventListener('pointerup',     stop, { once: true });
        el.addEventListener('pointercancel', stop, { once: true });
      }
    }
    const body = el.parentElement;
    const startX = e.clientX, startY = e.clientY;
    // Build the move group: every note in the prSelection that belongs to
    // this clip — falling back to just `note` if it isn't part of a multi-
    // selection. Capture each note's element + original start/midi.
    const inSel = SEQ.prSelection.has(note);
    const groupNotes = (inSel && SEQ.prSelection.size > 1)
      ? clip.notes.filter(n => SEQ.prSelection.has(n))
      : [note];
    const noteEls = body.querySelectorAll('.pr-note');
    let group = groupNotes.map(n => {
      const idx = clip.notes.indexOf(n);
      return { n, el: noteEls[idx] || null, origStart: n.start, origMidi: n.midi };
    });
    // Alt-drag duplicates: clone every group note, leave originals in place,
    // and drag the clones instead. We perform the clone lazily on the first
    // real movement, so the user can press Alt *during* the initial nudge
    // (matches DAW behavior). `anchor` tracks the note whose post-snap
    // position drives the group's snap delta on release.
    let anchor = note;
    let altDup = false;
    SEQ._prAltDragClones = null;
    const performAltClone = () => {
      // Snapshot how far the drag has moved so far so the clones jump to
      // the current cursor position (smooth continuation, no rubber-banding).
      const dShiftBeat = group[0] ? (group[0].n.start - group[0].origStart) : 0;
      const dShiftRow  = group[0] ? (group[0].origMidi - group[0].n.midi)  : 0;
      // First, snap the ORIGINALS back to their starting position — the
      // user wants the originals to stay put while a ghost follows.
      for (const g of group) {
        g.n.start = g.origStart;
        g.n.midi  = g.origMidi;
        if (g.el) {
          g.el.style.left = (g.n.start * PR_BEAT_PX + prKbW()) + 'px';
          g.el.style.top  = ((body._prHi - g.n.midi) * PR_ROW_H) + 'px';
        }
      }
      // Now clone & make ghosts that follow the cursor.
      const clones = group.map(g => ({ ...g.n }));
      clones.forEach(c => clip.notes.push(c));
      const cloneEls = clones.map((c, i) => {
        const src = group[i].el;
        const cel = src ? src.cloneNode(true) : document.createElement('div');
        cel.classList.remove('selected');
        cel.classList.add('pr-alt-ghost');
        cel.style.left = ((c.start + dShiftBeat) * PR_BEAT_PX + prKbW()) + 'px';
        cel.style.top  = ((body._prHi - (c.midi - dShiftRow)) * PR_ROW_H) + 'px';
        cel.style.pointerEvents = 'none';
        body.appendChild(cel);
        return cel;
      });
      const anchorIdx = group.findIndex(g => g.n === note);
      if (anchorIdx >= 0) anchor = clones[anchorIdx];
      group = clones.map((c, i) => ({ n: c, el: cloneEls[i], origStart: c.start, origMidi: c.midi }));
      SEQ._prAltDragClones = clones;
      altDup = true;
    };
    let moved = false;
    const onMove = (ev) => {
      _edgeAutoScroll(body, ev.clientX);
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      // If Alt is held at this move (or was at mousedown) and we haven't
      // cloned yet, switch into duplicate mode. Works on first move AND any
      // later move — so the user can also press Alt mid-drag.
      if (!altDup && (ev.altKey || e.altKey)) performAltClone();
      moved = true;
      // Shift constrains the drag to its dominant axis (horizontal-only =
      // pure time shift, vertical-only = pure pitch shift). Combines with
      // alt-drag for ghost-duplicate along one axis.
      let effDx = dx, effDy = dy;
      if (ev.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) effDy = 0;
        else effDx = 0;
      }
      const dBeat = effDx / PR_BEAT_PX;
      // Ctrl/Cmd has two modes:
      //  - Single pitch in selection → snap vertical to whole octaves.
      //  - Multiple distinct pitches → cycle chord inversions. Each
      //    octave-step up moves the lowest remaining note up by one
      //    octave, so a CEG selection becomes EGC, then GCE, then a
      //    full octave up. Going down rotates the highest note down.
      const octaveSnap = ev.ctrlKey || ev.metaKey;
      const distinctMidiCount = (() => {
        const s = new Set();
        for (const g of group) s.add(g.origMidi);
        return s.size;
      })();
      const invMode = octaveSnap && distinctMidiCount >= 2;
      // Up on the mouse (effDy < 0) = up in pitch = positive step.
      const invStep = invMode ? -Math.round(effDy / PR_ROW_H / 12) : 0;
      const dRow = invMode
        ? 0
        : (octaveSnap
            ? Math.round(effDy / PR_ROW_H / 12) * 12
            : Math.round(effDy / PR_ROW_H));
      let beatShift = dBeat;
      let rowShift = dRow;
      for (const g of group) {
        beatShift = Math.max(beatShift, -g.origStart);
        if (!invMode) {
          rowShift  = Math.min(rowShift, g.origMidi - 0);
          rowShift  = Math.max(rowShift, g.origMidi - 127);
        }
      }
      // For inversion mode pre-sort by origMidi so each note's shift
      // depends on its rank in the chord.
      let sortedRank = null;
      if (invMode) {
        const sorted = [...group].sort((a, b) => a.origMidi - b.origMidi);
        sortedRank = new Map();
        sorted.forEach((g, i) => sortedRank.set(g, i));
      }
      const N = group.length;
      for (const g of group) {
        let perNote = -rowShift;
        if (invMode) {
          const i = sortedRank.get(g);
          // shift_i(K) = floor((K + N - 1 - i) / N) * 12
          perNote = Math.floor((invStep + N - 1 - i) / N) * 12;
        }
        g.n.start = g.origStart + beatShift;
        g.n.midi  = Math.max(0, Math.min(127, g.origMidi + perNote));
        if (g.el) {
          g.el.style.left = (g.n.start * PR_BEAT_PX + prKbW()) + 'px';
          g.el.style.top  = ((body._prHi - g.n.midi) * PR_ROW_H) + 'px';
          // Keep the pitch label in sync as we move.
          const lblEl = g.el.querySelector('.pr-note-text');
          if (lblEl) lblEl.textContent = midiNoteLabel(g.n.midi);
        }
      }
      seqResyncTrackThrottled(track);
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      if (moved) {
        // Snap by the dragged anchor's delta so the group stays rigid.
        // Uses the global roll snap setting (SEQ.rollSnap / rollSnapVal).
        const snapped = Math.max(0, rollSnapBeat(anchor.start));
        const snapShift = snapped - anchor.start;
        for (const g of group) {
          g.n.start = Math.max(0, g.n.start + snapShift);
          g.n.label = midiNoteLabel(g.n.midi);
        }
        clip.notes.sort((a, b) => a.start - b.start);
        // If we alt-dragged, replace selection with the new clones.
        if (SEQ._prAltDragClones) {
          SEQ.prSelection.clear();
          SEQ._prAltDragClones.forEach(c => SEQ.prSelection.add(c));
          SEQ._prAltDragClones = null;
        }
        renderPianoRoll();
        seqRenderTrack(track);
        seqResyncTrack(track);
        seqSave();
      }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  });
  return el;
}

// Click-and-drag on empty area = draw new note. Drop a chord-pad to add
// chord notes (all at the click x position, pitch from the chord).
(function _initPianoRollListeners() {
  const body = document.getElementById('seq-pianoroll-body');
  if (!body) return;
  // Track last-interacted zone for keyboard-shortcut dispatch (Ctrl+A etc).
  document.addEventListener('pointerdown', (ev) => {
    const inRoll = ev.target.closest && ev.target.closest('#seq-pianoroll');
    const inArr  = ev.target.closest && ev.target.closest('#seq-lane-wrap');
    if (inRoll) SEQ._lastZone = 'roll';
    else if (inArr) SEQ._lastZone = 'arrangement';
  }, true);
  body.addEventListener('pointerdown', (e) => {
    SEQ._lastZone = 'roll';
    // Pan: spacebar held OR hand-tool active
    if (SEQ._prSpaceHeld || SEQ.prTool === 'pan') {
      e.preventDefault();
      body.setPointerCapture(e.pointerId);
      const startX = e.clientX, startY = e.clientY;
      const startSL = body.scrollLeft, startST = body.scrollTop;
      body.classList.add('pr-panning');
      const onMove = (ev) => {
        body.scrollLeft = startSL - (ev.clientX - startX);
        body.scrollTop  = startST - (ev.clientY - startY);
      };
      const onUp = () => {
        body.removeEventListener('pointermove', onMove);
        body.removeEventListener('pointerup', onUp);
        body.classList.remove('pr-panning');
      };
      body.addEventListener('pointermove', onMove);
      body.addEventListener('pointerup', onUp);
      return;
    }
    if (e.target !== body) return;
    const rect = body.getBoundingClientRect();
    if (e.clientX - rect.left < prKbW()) return; // click in keyboard area — ignore
    const { track, clip } = focusedClipObjects();
    if (!track || !clip) return;
    // Clicking empty roll area clears any note-selection (unless shift held
    // for additive marquee). The marquee path below also clears, but doing
    // it here covers other tools (draw/erase/none) as well.
    if (!e.shiftKey && SEQ.prSelection.size > 0) {
      SEQ.prSelection.clear();
      _prSyncSelection(body);
    }
    // Select tool: rectangle marquee
    if (SEQ.prTool === 'select') {
      e.preventDefault();
      body.setPointerCapture(e.pointerId);
      // Snapshot so shift-marquee adds to existing selection; without
      // shift we start fresh. Each move rebuilds from the snapshot so
      // notes that leave the rect become unselected again.
      const baseSel = e.shiftKey ? new Set(SEQ.prSelection) : new Set();
      if (!e.shiftKey) SEQ.prSelection.clear();
      const startX = e.clientX, startY = e.clientY;
      const startSL = body.scrollLeft, startST = body.scrollTop;
      const marquee = document.createElement('div');
      marquee.className = 'pr-marquee';
      body.appendChild(marquee);
      const updateMarquee = (ev) => {
        const x0 = startX - rect.left + startSL;
        const y0 = startY - rect.top + startST;
        const x1 = ev.clientX - rect.left + body.scrollLeft;
        const y1 = ev.clientY - rect.top + body.scrollTop;
        const left = Math.min(x0, x1), top = Math.min(y0, y1);
        const right = Math.max(x0, x1), bottom = Math.max(y0, y1);
        marquee.style.left = left + 'px';
        marquee.style.top  = top + 'px';
        marquee.style.width  = (right - left) + 'px';
        marquee.style.height = (bottom - top) + 'px';
        SEQ.prSelection.clear();
        baseSel.forEach(n => SEQ.prSelection.add(n));
        clip.notes.forEach((n) => {
          const nLeft = n.start * PR_BEAT_PX + prKbW();
          const nRight = nLeft + n.beats * PR_BEAT_PX;
          const nTop  = (body._prHi - n.midi) * PR_ROW_H;
          const nBot  = nTop + PR_ROW_H;
          if (nRight >= left && nLeft <= right && nBot >= top && nTop <= bottom) {
            SEQ.prSelection.add(n);
          }
        });
        _prSyncSelection(body);
      };
      const onUp = () => {
        body.removeEventListener('pointermove', updateMarquee);
        body.removeEventListener('pointerup', onUp);
        marquee.remove();
      };
      body.addEventListener('pointermove', updateMarquee);
      body.addEventListener('pointerup', onUp);
      return;
    }
    // Draw tool only past this point
    if (SEQ.prTool !== 'draw') return;
    e.preventDefault();
    body.setPointerCapture(e.pointerId);
    const beat0 = Math.max(0, ((e.clientX - rect.left + body.scrollLeft - prKbW()) / PR_BEAT_PX));
    const startBeat = rollSnap(beat0);
    const midi = Math.max(0, Math.min(127, body._prHi - Math.floor((e.clientY - rect.top + body.scrollTop) / PR_ROW_H)));
    seqCheckpoint();
    const newNote = { midi, label: midiNoteLabel(midi), beats: 1, start: startBeat };
    clip.notes.push(newNote);
    clip.notes.sort((a, b) => a.start - b.start);
    // Make the new note audible immediately if playback is running.
    seqResyncTrackThrottled(track);
    const ghost = document.createElement('div');
    ghost.className = 'pr-note';
    ghost.style.left   = (startBeat * PR_BEAT_PX + prKbW()) + 'px';
    ghost.style.width  = PR_BEAT_PX + 'px';
    ghost.style.top    = ((body._prHi - midi) * PR_ROW_H) + 'px';
    ghost.style.height = (PR_ROW_H - 2) + 'px';
    ghost.textContent  = midiNoteLabel(midi);
    body.appendChild(ghost);
    const onMove = (ev) => {
      const beat = Math.max(startBeat + 0.25, (ev.clientX - rect.left + body.scrollLeft - prKbW()) / PR_BEAT_PX);
      newNote.beats = Math.max(0.25, beat - startBeat);
      ghost.style.width = (newNote.beats * PR_BEAT_PX) + 'px';
      // Note duration changed → reschedule release if currently sounding.
      seqResyncTrackThrottled(track);
    };
    const onUp = () => {
      body.removeEventListener('pointermove', onMove);
      body.removeEventListener('pointerup', onUp);
      newNote.beats = Math.max(0.25, Math.round(newNote.beats * 2) / 2);
      // Extend clip length if note runs past its right edge
      if (newNote.start + newNote.beats > clip.beats) clip.beats = newNote.start + newNote.beats;
      seqAutoExtendLoop(clip.start + clip.beats);
      renderPianoRoll();
      seqRenderTrack(track);
      seqResyncTrack(track);
      seqSave();
    };
    body.addEventListener('pointermove', onMove);
    body.addEventListener('pointerup', onUp);
  });

  // Chord-pad drop inside the piano-roll → adds the chord's notes to the
  // focused clip at the drop position. Show note-ghosts during dragover
  // that reflect both the time slot AND the octave under the cursor.
  let _prGhostNotes = [];
  const _clearPrGhost = () => {
    _prGhostNotes.forEach(g => g.remove());
    _prGhostNotes = [];
  };
  const _prDragNotes = (e) => {
    const raw = e.dataTransfer.types.includes('application/x-chord');
    if (!raw) return null;
    const data = JSON.parse(_prDragData || 'null');
    if (!data) return null;
    const rect = body.getBoundingClientRect();
    const beat = Math.max(0, rollSnap((e.clientX - rect.left + body.scrollLeft - prKbW()) / PR_BEAT_PX));
    const cursorMidi = Math.max(0, Math.min(127, body._prHi - Math.floor((e.clientY - rect.top + body.scrollTop) / PR_ROW_H)));
    const baseNotes = chordToMidiNotes(state.keys[state.currentTemplate], state.octave, data.interval, data.q);
    if (baseNotes.length === 0) return null;
    const root = baseNotes[0];
    const shift = Math.round((cursorMidi - root) / 12) * 12;
    return { beat, notes: baseNotes.map(m => m + shift) };
  };
  let _prDragData = null;
  body.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('application/x-chord')) return;
    // dataTransfer.getData only works on drop, so cache from chord-pad ondragstart
    // via a separate mechanism: store payload in SEQ._prDragPayload set elsewhere.
    _prDragData = SEQ._prDragPayload || null;
  });
  body.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-chord')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const info = _prDragNotes(e);
    if (!info) return;
    // Resize / create ghost-notes to match
    if (_prGhostNotes.length !== info.notes.length) {
      _clearPrGhost();
      info.notes.forEach(() => {
        const g = document.createElement('div');
        g.className = 'pr-note pr-ghost-note';
        body.appendChild(g);
        _prGhostNotes.push(g);
      });
    }
    info.notes.forEach((midi, i) => {
      const g = _prGhostNotes[i];
      g.style.left   = (info.beat * PR_BEAT_PX + prKbW()) + 'px';
      g.style.width  = (chordDropLen() * PR_BEAT_PX) + 'px';
      g.style.top    = ((body._prHi - midi) * PR_ROW_H) + 'px';
      g.style.height = (PR_ROW_H - 2) + 'px';
      g.textContent  = midiNoteLabel(midi);
    });
  });
  body.addEventListener('dragleave', (e) => {
    if (!body.contains(e.relatedTarget)) _clearPrGhost();
  });
  body.addEventListener('drop', (e) => {
    _clearPrGhost();
    const raw = e.dataTransfer.getData('application/x-chord');
    if (!raw) return;
    e.preventDefault();
    const { track, clip } = focusedClipObjects();
    if (!track || !clip) return;
    _prDragData = raw;
    const info = _prDragNotes(e);
    if (!info) return;
    // info.notes[0] is the (already octave-shifted) chord root; pass it as
    // the anchorMidi so addChordToClip's own shift math becomes a no-op.
    addChordToClip(track, clip, info.beat, JSON.parse(raw), info.notes[0]);
  });
  // Resize handle: drag up to make the roll taller, down to shrink. Stored
  // on body.style.height so it survives re-renders. Persisted to SEQ so it
  // sticks across sessions via seqSave().
  const resizeHandle = document.getElementById('seq-pianoroll-resize');
  const prBody = document.getElementById('seq-pianoroll-body');
  if (resizeHandle && prBody) {
    if (typeof SEQ.prBodyHeight === 'number') {
      prBody.style.height = SEQ.prBodyHeight + 'px';
      prBody.style.maxHeight = 'none';
    }
    resizeHandle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      resizeHandle.setPointerCapture(e.pointerId);
      resizeHandle.classList.add('dragging');
      const startY = e.clientY;
      const startH = prBody.getBoundingClientRect().height;
      const startScrollTop = prBody.scrollTop;
      // Note range visible at drag start — used to keep the same upper-pitch
      // row pinned to the top of the viewport (so growth/shrink happens at
      // the bottom of the visible roll). Falls back to scrollTop preservation
      // when we're scrolled against the bottom of the content (A0 territory).
      const onMove = (ev) => {
        // Handle sits below the body now: drag down → roll grows taller.
        const dy = ev.clientY - startY;
        const next = Math.max(120, Math.min(window.innerHeight - 160, startH + dy));
        prBody.style.height = next + 'px';
        prBody.style.maxHeight = 'none';
        // Anchor the TOP visible row in place: keep scrollTop fixed, unless
        // that would over-scroll past the bottom of the content (we're at
        // A0). In that case clamp scrollTop down so the bottom row stays put
        // and the extra height reveals notes above.
        const contentH = prBody.scrollHeight;
        const maxScroll = Math.max(0, contentH - next);
        prBody.scrollTop = Math.min(startScrollTop, maxScroll);
      };
      const onUp = () => {
        resizeHandle.removeEventListener('pointermove', onMove);
        resizeHandle.removeEventListener('pointerup', onUp);
        resizeHandle.classList.remove('dragging');
        SEQ.prBodyHeight = parseInt(prBody.style.height, 10) || null;
        seqSave();
      };
      resizeHandle.addEventListener('pointermove', onMove);
      resizeHandle.addEventListener('pointerup', onUp);
    });
  }
  document.getElementById('seq-pianoroll-close')?.addEventListener('click', hidePianoRoll);
  document.getElementById('seq-pianoroll-toggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePianoRoll();
  });
  SEQ.prShowKeyboard = true;
  prSetTool(SEQ.prTool || 'select');
  renderPianoRoll();
  refreshPianoRollTitle();
})();
