// ============================================================
// CHORD SEQUENCER
// ============================================================
//
// Extracted from chord-pad.js. Loaded AFTER audio.js + midi.js, but
// BEFORE chord-pad.js — chord-pad.js's startup block at the bottom of
// that file calls seqLoad() / seqInitTrackSynths() / dropChord(), so
// those functions need to be defined when chord-pad.js parses.
//
// Parse-time code in this file:
//   - SEQ object initialization
//   - _bindArrAlias / _bindFieldAlias property aliases on SEQ
//   - No external globals read at parse time (only inside function
//     bodies that fire at runtime, after every script has loaded).
//
// Cross-file dependencies (resolved at runtime via window scope):
//   audio.js:     getAudioCtx, startAudioNote, stopAudioNote,
//                 startBassNote, withSynth, midiToFreq
//   midi.js:      sendNoteOn, sendNoteOff, midiPortById,
//                 audioTimeToMidiTs, panic, sendTrackChannelVolume
//   pianoroll.js: renderPianoRoll, focusedClipObjects,
//                 refreshPianoRollTitle, openPianoRoll, hidePianoRoll,
//                 prSetTool (note: pianoroll.js loads AFTER this file
//                 and chord-pad.js — calls land at runtime)
//   chord-pad.js: state, chordToMidiNotes, chordDisplayName,
//                 midiNoteLabel, midiNoteName, INSTRUMENT_PRESETS,
//                 refreshLucide, syncTrackLabelHeights, escapeHtml,
//                 rebuildTracksUI, kbActive, flashHint, ... and the
//                 piano-roll clipboard ops still living there:
//                 prCopyNotes / prCutNotes / prPasteNotes /
//                 prDuplicateNotes / prDeleteNotes / prSelectAllNotes /
//                 prRollHasNoteSelection
//
// Public surface (called by the rest of the app):
//   Data model:   SEQ, makeTrack, makeClip, newTrackId, newClipId,
//                 trackById, firstTrackOfKind, tracksOfKind, addTrack,
//                 removeTrackById, ensureTrackOfKind, BEAT_PX, PR_BEAT_PX
//   Drop helpers: dropChord, dropNote, addChordToClip
//   Undo/Redo:    seqCheckpoint, seqSnapshot, seqUndo, seqRedo
//   Selection:    seqSelectAll, seqClearSelection, seqDeleteSelection,
//                 seqCopySelection, seqCutSelection, seqPasteSelection,
//                 seqDuplicateSelection
//   Scheduler:    seqTick, seqTickChordTrack, seqTickFreeTrack,
//                 seqResyncTrack, seqResyncAll, seqResyncTrackThrottled,
//                 seqResyncAllThrottled, seqReanchorPlayStart,
//                 seqLoopBaseChangedResync, freeTrackFlatNotes,
//                 invalidateFreeTrackFlat
//   Transport:    seqPlay, seqStop, seqInitPlay, startPrecount,
//                 applyTempoChange, seqIsOpen
//   Render:       seqRenderTrack, seqMakeBlock, seqMakeRollNote,
//                 seqRenderRuler, seqHighlight, seqHighlightNote
//   Loop/ruler:   seqUpdateLoopVisible, seqUpdateLoopStart,
//                 seqUpdateLoopEnd, seqAutoExtendLoop, seqLaneWidth,
//                 seqBeatDur, seqLoopOffset, seqTotalDur,
//                 seqFindNextInRange, seqItemInRange
//   Track helpers: seqTrackInstrument, seqTrackSynth, seqTrackAudible,
//                  seqTrackVel
//   Persistence:  seqSave, seqLoad, seqInitTrackSynths
//   UI helpers:   seqUpdateNowPlaying, seqAnimatePlayhead,
//                 seqUpdateHints, seqUpdateBarLine, seqIsSelected,
//                 seqSelectionToggle, seqRefreshSelectionVisuals
//   Touch drag:   seqStartTouchDrag, seqAddTouchDrag
//   Ghost prev.:  seqSetGhost, seqClearGhost, seqSetRollGhost,
//                 seqClearRollGhost, chordNotesAtY, seqChordDragImage
//   Roll helpers: ROLL_ROW_H, ROLL_TOP_MIDI, ROLL_BOT_MIDI, ROLL_H,
//                 ROLL_VIEW_H, rollScrollForMidi, rollBuildGrid,
//                 rollBuildKeyboard, updateKeyboardPosition,
//                 updateRollOverflow, midiIsBlack, seqRollAddLines,
//                 seqApplyZoom, prApplyZoom, prUpdateGridVars
//   Init wiring:  initSeqPinchZoom, initSeqLanePan, initMidiLaneResize,
//                 initSeqLoopEnd, initSeqLoopStart

// ============================================================
// CHORD SEQUENCER
// ============================================================
let BEAT_PX = 30; // pixels per beat (arrangement)
let PR_BEAT_PX = 30; // pixels per beat (piano roll — independent zoom)

// ============================================================
// SEQUENCER DATA MODEL
// ============================================================
// One ordered list of tracks. Each track is fully independent: own kind,
// items, playback state, instrument, channel, volume, mute/solo, synth.
//
//   kind === 'chord'  — items[] are chord blocks      ({interval, q, …})
//   kind === 'free'   — items[] are CLIPS, each clip
//                       holds its own notes:
//                         { id, start, beats, notes:[{midi,start,beats}], label? }
//                       Chord-pads cannot be dropped on a free lane —
//                       they go to chord-tracks or into an open piano-roll.
//
// All track data lives directly on each track in SEQ.tracksList — use
// `firstTrackOfKind('chord').items` / `.pendingIdx` / `.activeIdx` etc.
// The previous SEQ.items / SEQ.midiItems / SEQ.noteItems / SEQ.activeIdx
// proxy-aliases were removed once every call site was migrated.

const INSTRUMENT_OPTIONS = [
  ['synth', 'Synth'], ['piano', 'Piano'], ['epiano', 'E-Piano'], ['epiano2', 'E-Piano 2'],
  ['organ', 'Organ'], ['strings', 'Strings'], ['choir', 'Choir'], ['vibes', 'Vibes'], ['pad', 'Pad'],
];

let _trackIdCounter = 0;
function newTrackId() { return 'tr-' + (++_trackIdCounter); }

let _clipIdCounter = 0;
function newClipId() { return 'cl-' + (++_clipIdCounter); }

// A clip on a free track. notes have RELATIVE starts (within the clip).
function makeClip({ id, start = 0, beats = 1, notes = [], label = null } = {}) {
  return { id: id || newClipId(), start, beats, notes, label };
}

// Wrap a single legacy note ({midi, label, beats, start}) into a 1-note clip.
function clipFromLegacyNote(item) {
  return makeClip({
    start: item.start,
    beats: item.beats,
    label: item.label || null,
    notes: [{ midi: item.midi, label: item.label, start: 0, beats: item.beats }],
  });
}

function makeTrack(opts = {}) {
  return {
    id:         opts.id || newTrackId(),
    kind:       opts.kind || 'free',
    name:       opts.name || (opts.kind === 'chord' ? 'Chords' : 'Free'),
    instrument: opts.instrument ?? 'epiano',
    channel:    opts.channel ?? 0,
    // 'instrument' = play in-app via SF2/synth; 'midi' = send to MIDI output.
    output:     opts.output === 'midi' ? 'midi' : 'instrument',
    // MIDI output port id (Web MIDI device id). Empty = use global default.
    midiPortId:   opts.midiPortId   || '',
    // MIDI input port id — when set, incoming notes on that port (matching
    // track.channel, or any channel if track.channel < 0) play through the
    // track's instrument live. Empty = no input.
    midiInPortId: opts.midiInPortId || '',
    volume:     opts.volume ?? 1.0,
    muted:      !!opts.muted,
    soloed:     !!opts.soloed,
    synth:      opts.synth || null, // null = link to chord-pad voice (state.synth)
    items:      Array.isArray(opts.items) ? opts.items : [],
    // Per-track playback / drag state
    pendingIdx: 0, pendingTime: 0, cycleStart: 0,
    activeIdx: -1, dragSrcIdx: null, dropTarget: null,
  };
}

const SEQ = {
  tracksList: [],

  // Default visual-cursor offset (ms). 75ms is roughly right for typical
  // Windows Web Audio output buffers; users on lower-latency setups can
  // tune it down via Settings → Cursor offset.
  visualLatencyMs: 75,

  rollTool: 'none',
  rollSnap: true,
  rollSnapVal: 1,
  rollKeyboard: false,
  playing: false,
  playStartTime: 0,
  rafId: null,
  pendingTimers: new Set(),
  activeNodes: new Set(),
  nowChord: '',
  nowNote: '',
  timer: null,
  TICK_MS: 25,
  LOOKAHEAD: 0.15,
  loopStart: 0,
  loopEnd: 4,
  loop: false,
  animBeat: 0, animLastTime: 0, animLoopLen: 4, animLoopStart: 0,
  _dragLabel: '', _dragChord: null, _dragHoverId: null,
  _undoStack: [], _redoStack: [],
  selection: [], // [{ trackId, item }]
  clipboard: null,
};
// Play cursor (set by ruler clicks). Always starts at beat 0 on page load
// so a fresh session begins playback from the very start of the timeline.
SEQ.startBeat = 0;
SEQ.animBeat  = 0;

// Start with no tracks — user adds what they need via "+ Add Track".

function trackById(id)            { return SEQ.tracksList.find(t => t.id === id); }
function firstTrackOfKind(kind)   { return SEQ.tracksList.find(t => t.kind === kind); }
function tracksOfKind(kind)       { return SEQ.tracksList.filter(t => t.kind === kind); }

function addTrack(kind, opts)     { const t = makeTrack({ ...(opts||{}), kind }); SEQ.tracksList.push(t); return t; }
function removeTrackById(id) {
  const idx = SEQ.tracksList.findIndex(t => t.id === id);
  if (idx >= 0) SEQ.tracksList.splice(idx, 1);
}

// Ensure a track of the given kind exists; create one (with sidebar +
// lane DOM) if not. Returns the (first) matching track.
function ensureTrackOfKind(kind) {
  let t = firstTrackOfKind(kind);
  if (t) return t;
  t = addTrack(kind, { name: kind === 'chord' ? 'Chords' : 'Notes' });
  if (!t.synth && kind !== 'chord') t.synth = { ...state.synth };
  rebuildTracksUI();
  seqRenderAll();
  return t;
}

// ---------- Undo / Redo ----------
const SEQ_UNDO_LIMIT = 60;
function seqSnapshot() {
  return JSON.stringify({
    tracksList: SEQ.tracksList.map(t => ({
      id: t.id, kind: t.kind, name: t.name,
      instrument: t.instrument, channel: t.channel, volume: t.volume, output: t.output, midiPortId: t.midiPortId, midiInPortId: t.midiInPortId,
      muted: t.muted, soloed: t.soloed, synth: t.synth,
      items: t.items,
    })),
    loopStart: SEQ.loopStart, loopEnd: SEQ.loopEnd, loop: SEQ.loop,
  });
}
function seqCheckpoint() {
  const snap = seqSnapshot();
  const stack = SEQ._undoStack;
  if (stack.length > 0 && stack[stack.length - 1] === snap) return;
  stack.push(snap);
  if (stack.length > SEQ_UNDO_LIMIT) stack.shift();
  SEQ._redoStack.length = 0;
}
function seqApplySnapshot(json) {
  try {
    const d = JSON.parse(json);
    if (Array.isArray(d.tracksList)) {
      SEQ.tracksList.length = 0;
      for (const tIn of d.tracksList) {
        SEQ.tracksList.push(makeTrack({
          id: tIn.id, kind: tIn.kind || 'free', name: tIn.name,
          instrument: tIn.instrument, channel: tIn.channel, volume: tIn.volume, output: tIn.output, midiPortId: tIn.midiPortId, midiInPortId: tIn.midiInPortId,
          muted: tIn.muted, soloed: tIn.soloed, synth: tIn.synth,
          items: tIn.items || [],
        }));
      }
    } else {
      // Legacy snapshot shape
      const chord = firstTrackOfKind('chord');
      const free  = firstTrackOfKind('free');
      if (chord) chord.items = d.items     || [];
      if (free)  free.items  = [...(d.midiItems || []), ...(d.noteItems || [])];
    }
    if (typeof d.loopStart === 'number') SEQ.loopStart = d.loopStart;
    if (typeof d.loopEnd   === 'number') SEQ.loopEnd   = d.loopEnd;
    if (typeof d.loop      === 'boolean') SEQ.loop     = d.loop;
    SEQ.selection = []; // identity broken on parse
    rebuildTracksUI();
    seqRenderAll();
  } catch (_) {}
}
function seqUndo() {
  if (SEQ._undoStack.length === 0) return;
  SEQ._redoStack.push(seqSnapshot());
  seqApplySnapshot(SEQ._undoStack.pop());
}
function seqRedo() {
  if (SEQ._redoStack.length === 0) return;
  SEQ._undoStack.push(seqSnapshot());
  seqApplySnapshot(SEQ._redoStack.pop());
}

// ---------- Selection / clipboard ----------
// Selection model — entries are { trackId, item }. Legacy string forms
// ('chords' | 'free' | 'melody') still resolve via trackByRef().
function trackByRef(ref) {
  if (!ref) return null;
  if (typeof ref === 'object' && ref.kind) return ref;
  if (ref === 'chords') return firstTrackOfKind('chord');
  if (ref === 'free')   return firstTrackOfKind('free');
  if (ref === 'melody') return null;
  return trackById(ref);
}
function seqTrackItems(ref) {
  const t = trackByRef(ref);
  return t ? t.items : [];
}
function _selKey(sel) { return sel.trackId || sel.track; } // legacy compat
function seqIsSelected(ref, item) {
  const key = (typeof ref === 'string' ? ref : ref?.id);
  return SEQ.selection.some(s => _selKey(s) === key && s.item === item);
}
function seqSelectionToggle(ref, item, additive) {
  const t = trackByRef(ref);
  if (!t) return;
  if (!additive) SEQ.selection = [];
  const i = SEQ.selection.findIndex(s => _selKey(s) === t.id && s.item === item);
  if (i >= 0) SEQ.selection.splice(i, 1);
  else SEQ.selection.push({ trackId: t.id, item });
  seqRefreshSelectionVisuals();
}
function seqClearSelection() {
  if (SEQ.selection.length === 0) return;
  SEQ.selection = [];
  seqRefreshSelectionVisuals();
}
function seqRefreshSelectionVisuals() {
  document.querySelectorAll('.seq-lane .seq-block, .seq-lane .roll-note')
    .forEach(el => el.classList.remove('selected'));
  for (const sel of SEQ.selection) {
    const t = trackByRef(_selKey(sel));
    if (!t) continue;
    const idx = t.items.indexOf(sel.item);
    if (idx < 0) continue;
    const lane = document.querySelector(`.seq-lane[data-track-id="${t.id}"]`);
    if (!lane) continue;
    const blocks = lane.querySelectorAll('.seq-block, .roll-note');
    if (blocks[idx]) blocks[idx].classList.add('selected');
  }
}
function seqSelectAll() {
  SEQ.selection = [];
  for (const t of SEQ.tracksList) {
    for (const it of t.items) SEQ.selection.push({ trackId: t.id, item: it });
  }
  seqRefreshSelectionVisuals();
}
function seqDeleteSelection() {
  if (SEQ.selection.length === 0) return;
  seqCheckpoint();
  for (const sel of SEQ.selection) {
    const t = trackByRef(_selKey(sel));
    if (!t) continue;
    const i = t.items.indexOf(sel.item);
    if (i >= 0) t.items.splice(i, 1);
  }
  SEQ.selection = [];
  seqRenderAll();
}
function seqCopySelection() {
  if (SEQ.selection.length === 0) return;
  const minStart = Math.min(...SEQ.selection.map(s => s.item.start));
  SEQ.clipboard = {
    items: SEQ.selection.map(s => ({
      trackId: _selKey(s),
      data:    JSON.parse(JSON.stringify(s.item)),
      relStart: s.item.start - minStart,
    })),
  };
}
function seqCutSelection() {
  if (SEQ.selection.length === 0) return;
  seqCopySelection();
  seqDeleteSelection();
}
function seqPasteSelection() {
  if (!SEQ.clipboard || SEQ.clipboard.items.length === 0) return;
  seqCheckpoint();
  // Paste at the play cursor when set, otherwise at the end of the loop.
  const baseBeat = (typeof SEQ.startBeat === 'number') ? SEQ.startBeat : SEQ.loopEnd;
  const newSelection = [];
  let maxEnd = baseBeat;
  for (const e of SEQ.clipboard.items) {
    const t = trackByRef(e.trackId);
    if (!t) continue;
    const newItem = { ...e.data, id: undefined, start: e.relStart + baseBeat };
    if (Array.isArray(newItem.notes)) newItem.notes = newItem.notes.map(n => ({ ...n }));
    if (!newItem.id) newItem.id = newClipId();
    t.items.push(newItem);
    newSelection.push({ trackId: t.id, item: newItem });
    maxEnd = Math.max(maxEnd, newItem.start + (newItem.beats || 1));
  }
  for (const t of SEQ.tracksList) t.items.sort((a, b) => a.start - b.start);
  SEQ.selection = newSelection;
  seqAutoExtendLoop(maxEnd);
  seqRenderAll();
}

// ---- Drop-from-chord-pad helpers ------------------------------------------
// Single source of truth for inserting a chord block / chord-clip / note-clip
// into a track from any drag-drop path (native HTML5 lane drop, piano-roll
// drop, or touch-drag). Each helper does the full sequence:
// seqCheckpoint → mutate → sort → seqAutoExtendLoop → render → resync.
function dropChord(track, beat, data) {
  if (!track) return;
  const beats = chordDropLen();
  seqCheckpoint();
  if (track.kind === 'chord') {
    track.items.push({
      interval: data.interval, q: data.q, bassInterval: data.bassInterval, label: data.label,
      beats, start: beat,
      keyRoot: state.keys[state.currentTemplate], template: state.currentTemplate,
      // Lock per-clip overrides at drop time so changing the global
      // voicing / octave / bass knobs later doesn't retroactively
      // rearrange sequenced chords. User can re-edit per clip via
      // right-click → menu.
      voicing:     state.voicing,
      octave:      state.octave,
      bassEnabled: state.bassEnabled,
      bassOctave:  state.bassOctave,
    });
  } else {
    const midis = chordToMidiNotes(state.keys[state.currentTemplate], state.octave, data.interval, data.q);
    track.items.push(makeClip({
      start: beat, beats,
      label: data.label || null,
      notes: midis.map(midi => ({ midi, label: midiNoteLabel(midi), start: 0, beats })),
    }));
  }
  track.items.sort((a, b) => a.start - b.start);
  // Note: NO seqAutoExtendLoop call here. Dropping a chord doesn't move
  // the loop bounds — the user controls the loop region explicitly via
  // the ruler handles. A chord placed past loopEnd simply waits until
  // the loop is widened or won't play (intentional).
  seqRenderTrack(track);
  seqResyncTrack(track);
  seqSave();
}
function dropNote(track, beat, data) {
  if (!track || track.kind === 'chord') return;
  seqCheckpoint();
  track.items.push(makeClip({
    start: beat, beats: 1,
    label: data.label,
    notes: [{ midi: data.midi, label: data.label, start: 0, beats: 1 }],
  }));
  track.items.sort((a, b) => a.start - b.start);
  seqAutoExtendLoop(beat + 1);
  seqRenderTrack(track);
  seqResyncTrack(track);
  seqSave();
}
// Add a chord's notes — octave-shifted so the chord root lands closest to
// anchorMidi — into an existing focused clip. Used for chord drops onto the
// piano-roll. Notes use chordDropLen() for their duration.
function addChordToClip(track, clip, beat, data, anchorMidi) {
  if (!clip) return;
  const baseNotes = chordToMidiNotes(state.keys[state.currentTemplate], state.octave, data.interval, data.q);
  if (baseNotes.length === 0) return;
  const root = baseNotes[0];
  const shift = Math.round((anchorMidi - root) / 12) * 12;
  const beats = chordDropLen();
  seqCheckpoint();
  baseNotes.map(m => m + shift).forEach(midi => clip.notes.push({
    midi, label: midiNoteLabel(midi),
    start: beat, beats,
  }));
  clip.notes.sort((a, b) => a.start - b.start);
  if (beat + beats > clip.beats) clip.beats = beat + beats;
  seqAutoExtendLoop(clip.start + clip.beats);
  renderPianoRoll();
  if (track) { seqRenderTrack(track); seqResyncTrack(track); }
  seqSave();
}

// Duplicate selection in place: each selected clip is cloned, with the
// copy starting right after the original ends.
function seqDuplicateSelection() {
  if (SEQ.selection.length === 0) return;
  seqCheckpoint();
  const newSelection = [];
  let maxEnd = 0;
  for (const sel of SEQ.selection) {
    const t = trackByRef(_selKey(sel));
    if (!t) continue;
    const src = sel.item;
    const beats = src.beats || 1;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = newClipId();
    copy.start = src.start + beats;
    if (Array.isArray(copy.notes)) copy.notes = copy.notes.map(n => ({ ...n }));
    t.items.push(copy);
    newSelection.push({ trackId: t.id, item: copy });
    maxEnd = Math.max(maxEnd, copy.start + beats);
  }
  for (const t of SEQ.tracksList) t.items.sort((a, b) => a.start - b.start);
  SEQ.selection = newSelection;
  seqAutoExtendLoop(maxEnd);
  seqRenderAll();
}

// Snap every selected clip's `start` to the current arrangement-snap
// grid. Item `beats` stays untouched so users can pre-set length and
// then quantize the position separately. With snap turned off this is
// a no-op (arrSnap returns the raw beat).
function seqQuantizeSelection() {
  if (SEQ.selection.length === 0) return;
  seqCheckpoint();
  for (const sel of SEQ.selection) {
    sel.item.start = Math.max(0, arrSnap(sel.item.start));
  }
  for (const t of SEQ.tracksList) t.items.sort((a, b) => a.start - b.start);
  seqRenderAll();
  seqSave();
}

// ---- Piano-roll note clipboard --------------------------------------------
// Mirrors the clip-level copy/cut/paste/duplicate semantics but operates on
// note objects within the currently-focused clip.
SEQ.prClipboard = null;
function prRollHasNoteSelection() {
  return SEQ.pianoRollOpen && SEQ.prSelection && SEQ.prSelection.size > 0;
}
function prCopyNotes() {
  if (!prRollHasNoteSelection()) return;
  const { clip } = focusedClipObjects();
  if (!clip) return;
  const notes = clip.notes.filter(n => SEQ.prSelection.has(n));
  if (notes.length === 0) return;
  const minStart = Math.min(...notes.map(n => n.start));
  SEQ.prClipboard = {
    items: notes.map(n => ({
      relStart: n.start - minStart,
      midi:     n.midi,
      beats:    n.beats,
    })),
  };
}
function prCutNotes() {
  if (!prRollHasNoteSelection()) return;
  prCopyNotes();
  const { track, clip } = focusedClipObjects();
  if (!clip) return;
  seqCheckpoint();
  clip.notes = clip.notes.filter(n => !SEQ.prSelection.has(n));
  SEQ.prSelection.clear();
  renderPianoRoll();
  if (track) { seqRenderTrack(track); seqResyncTrack(track); }
  seqSave();
}
function prPasteNotes() {
  if (!SEQ.prClipboard || SEQ.prClipboard.items.length === 0) return;
  const { track, clip } = focusedClipObjects();
  if (!clip) return;
  seqCheckpoint();
  // Paste at play-cursor if it falls inside the clip's range, else at beat 0
  // of the clip. Pitch is preserved as-is from the clipboard.
  let baseBeat = 0;
  if (typeof SEQ.startBeat === 'number' && SEQ.startBeat >= clip.start) {
    baseBeat = SEQ.startBeat - clip.start;
  }
  const newNotes = SEQ.prClipboard.items.map(it => ({
    start: baseBeat + it.relStart,
    midi:  Math.max(0, Math.min(127, it.midi)),
    beats: it.beats,
    label: midiNoteLabel(it.midi),
  }));
  for (const n of newNotes) clip.notes.push(n);
  clip.notes.sort((a, b) => a.start - b.start);
  // Auto-extend clip if pasted notes exceed its length.
  const maxEnd = Math.max(...newNotes.map(n => n.start + n.beats));
  if (maxEnd > clip.beats) clip.beats = maxEnd;
  seqAutoExtendLoop(clip.start + clip.beats);
  SEQ.prSelection.clear();
  newNotes.forEach(n => SEQ.prSelection.add(n));
  renderPianoRoll();
  if (track) { seqRenderTrack(track); seqResyncTrack(track); }
  seqSave();
}
function prDuplicateNotes() {
  if (!prRollHasNoteSelection()) return;
  const { track, clip } = focusedClipObjects();
  if (!clip) return;
  seqCheckpoint();
  const sel = clip.notes.filter(n => SEQ.prSelection.has(n));
  if (sel.length === 0) return;
  const maxEnd = Math.max(...sel.map(n => n.start + n.beats));
  const minStart = Math.min(...sel.map(n => n.start));
  const shift = maxEnd - minStart;
  const clones = sel.map(n => ({
    start: n.start + shift,
    midi:  n.midi,
    beats: n.beats,
    label: n.label,
  }));
  for (const c of clones) clip.notes.push(c);
  clip.notes.sort((a, b) => a.start - b.start);
  const newMax = Math.max(...clones.map(c => c.start + c.beats));
  if (newMax > clip.beats) clip.beats = newMax;
  seqAutoExtendLoop(clip.start + clip.beats);
  SEQ.prSelection.clear();
  clones.forEach(c => SEQ.prSelection.add(c));
  renderPianoRoll();
  if (track) { seqRenderTrack(track); seqResyncTrack(track); }
  seqSave();
}
// Snap every selected note's `start` to the piano-roll snap grid.
// `beats` stays untouched. If snap is off, rollSnap returns the raw
// beat so this becomes a no-op.
function prQuantizeNotes() {
  if (!prRollHasNoteSelection()) return;
  const { track, clip } = focusedClipObjects();
  if (!clip) return;
  seqCheckpoint();
  clip.notes.forEach(n => {
    if (SEQ.prSelection.has(n)) n.start = Math.max(0, rollSnap(n.start));
  });
  clip.notes.sort((a, b) => a.start - b.start);
  renderPianoRoll();
  if (track) { seqRenderTrack(track); seqResyncTrack(track); }
  seqSave();
}
function prSelectAllNotes() {
  const { clip } = focusedClipObjects();
  if (!clip) return;
  SEQ.prSelection.clear();
  clip.notes.forEach(n => SEQ.prSelection.add(n));
  renderPianoRoll();
}

// Run a function with state.synth temporarily swapped to a per-track config.
// All audio-trigger functions (startAudioNote / startSampleNote /
// startSf2Voice / startBassNote) read state.synth synchronously when they
// schedule their gain / LFO / filter values, so a swap-around-the-call works.
function withSynth(synth, fn) {
  if (!synth) return fn();
  const prev = state.synth;
  state.synth = synth;
  try { return fn(); } finally { state.synth = prev; }
}

// Resolve a track from a legacy kind string (or already a track object).
//   'chords' → first chord track
//   'free'   → first free track
//   'melody' → null (track kind removed)
//   <object> → as-is
function resolveTrack(ref) {
  if (!ref) return null;
  if (typeof ref === 'object') return ref;
  if (ref === 'chords') return firstTrackOfKind('chord');
  if (ref === 'free')   return firstTrackOfKind('free');
  if (ref === 'melody') return null;
  return trackById(ref);
}

// The default (first) Chord track shares its voice with the chord-pad —
// they're the same instrument. Additional tracks have their own
// independent synth + instrument config.
function seqTrackSynth(ref) {
  const t = resolveTrack(ref);
  if (!t) return state.synth;
  return t.synth || state.synth;
}
function seqTrackInstrument(ref) {
  const t = resolveTrack(ref);
  if (!t) return state.instrument;
  return t.instrument;
}

function seqTrackAudible(ref) {
  const t = resolveTrack(ref);
  if (!t) return true;
  const anySolo = SEQ.tracksList.some(tr => tr.soloed);
  if (anySolo) return t.soloed;
  return !t.muted;
}
function seqTrackVel(ref, base) {
  const t = resolveTrack(ref);
  if (!t) return base;
  return Math.max(1, Math.min(127, Math.round(base * t.volume)));
}
// Stub — kept so the (now no-op) call sites don't throw if invoked.
function sendTrackChannelVolume() {}

function seqBeatDur() {
  // tempo = BPM of a *quarter* note. In time signatures with eighth-note
  // beats (currently just 6/8 in our options list) each beat is half as
  // long. The dropdown stores only the numerator on state.beatsPerBar; 6
  // uniquely identifies 6/8 in our supported set.
  const eighthBeat = state.beatsPerBar === 6;
  return (eighthBeat ? 30 : 60) / state.tempo;
}

function seqTimeout(fn, delay) {
  const id = setTimeout(() => { SEQ.pendingTimers.delete(id); fn(); }, delay);
  SEQ.pendingTimers.add(id);
}

function seqUpdateNowPlaying() {
  const el = document.getElementById('now-playing-notes');
  if (!el) return;
  const parts = [];
  if (SEQ.nowChord) parts.push(SEQ.nowChord);
  if (SEQ.nowNote)  parts.push('♩ ' + SEQ.nowNote);
  el.textContent = parts.join('  ·  ') || '—';
}

function seqAnimatePlayhead() {
  if (!SEQ.playing) return;
  const ctx     = getAudioCtx();
  // Compensate for the audio output latency so the visual playhead matches
  // what you actually hear, not what was just scheduled.
  // - ctx.outputLatency: total render+output latency (Chrome reports it).
  // - ctx.baseLatency:   fallback for browsers without outputLatency.
  // - SEQ.visualLatencyMs: manual user fudge (set via DevTools) for drivers
  //   that under-report — e.g. `SEQ.visualLatencyMs = 30` shifts visual 30ms.
  const lat = (ctx.outputLatency ?? ctx.baseLatency ?? 0) + (SEQ.visualLatencyMs || 0) / 1000;
  const now = ctx.currentTime - lat;
  const rawDt  = now - SEQ.animLastTime;
  const dt     = rawDt > 0 ? Math.min(rawDt, seqBeatDur() * SEQ.animLoopLen) : 0;
  if (rawDt > 0) SEQ.animLastTime = now;
  let px;
  if (SEQ.loop) {
    SEQ.animBeat += dt / seqBeatDur();
    const L = SEQ.animLoopLen;
    const pos = ((SEQ.animBeat - SEQ.animLoopStart) % L + L) % L;
    SEQ.animBeat = SEQ.animLoopStart + pos;
    px = SEQ.animBeat * BEAT_PX;
  } else {
    if (dt > 0) SEQ.animBeat += dt / seqBeatDur();
    px = SEQ.animBeat * BEAT_PX;
    const minW = px + 64;
    const cLane = document.getElementById('seq-lane');
    const nLane = document.getElementById('seq-note-lane');
    const mLane = document.getElementById('seq-midi-lane');
    if (cLane && parseFloat(cLane.style.minWidth || 0) < minW) cLane.style.minWidth = minW + 'px';
    if (nLane && parseFloat(nLane.style.minWidth || 0) < minW) nLane.style.minWidth = minW + 'px';
    if (mLane && parseFloat(mLane.style.minWidth || 0) < minW) mLane.style.minWidth = minW + 'px';
    const wrap = document.getElementById('seq-lane-wrap');
    if (wrap) {
      wrap.scrollLeft = Math.max(0, px - wrap.clientWidth * 0.75);
    }
  }
  // Follow-mode: let the playhead move freely through the left half
  // of the viewport; once it would cross the midpoint, pin it there
  // and scroll the lanes underneath. When the loop wraps the cursor
  // jumps backward, so also snap when it falls off the left edge.
  if (SEQ.followArr && SEQ.playing) {
    const wrap = document.getElementById('seq-lane-wrap');
    if (wrap) {
      const mid = wrap.clientWidth * 0.5;
      const cursorX = px - wrap.scrollLeft;
      if (cursorX > mid)       wrap.scrollLeft = px - mid;
      else if (cursorX < 0)    wrap.scrollLeft = Math.max(0, px);
    }
  }
  document.querySelectorAll('.seq-playhead').forEach(ph => { ph.style.left = px + 'px'; });

  // Piano-roll playhead is clip-relative: only shown when the playhead is
  // inside the focused clip's time range, and positioned at (beat - clip.start).
  const prBody = document.getElementById('seq-pianoroll-body');
  if (prBody && SEQ.pianoRollOpen) {
    const prPh = prBody.querySelector('.seq-playhead');
    const { clip } = focusedClipObjects();
    const insideClip = clip && SEQ.animBeat >= clip.start && SEQ.animBeat < clip.start + clip.beats;
    if (prPh) {
      if (insideClip) {
        prPh.style.display = 'block';
        const phX = (SEQ.animBeat - clip.start) * PR_BEAT_PX + prKbW();
        prPh.style.left    = phX + 'px';
        prPh.style.top     = prBody.scrollTop + 'px';
        prPh.style.height  = prBody.clientHeight + 'px';
        prPh.style.bottom  = 'auto';
        if (SEQ.followPr && SEQ.playing) {
          const mid = prBody.clientWidth * 0.5;
          const cursorX = phX - prBody.scrollLeft;
          if (cursorX > mid)       prBody.scrollLeft = phX - mid;
          else if (cursorX < 0)    prBody.scrollLeft = Math.max(0, phX);
        }
      } else {
        prPh.style.display = 'none';
      }
    }
    // Light up keyboard rows whose notes are currently sounding in the
    // focused clip — gives the piano-roll piano the same playback-feedback
    // as the chord-pad keyboard.
    let activeMidi = SEQ._prActiveMidi;
    if (!activeMidi) activeMidi = SEQ._prActiveMidi = new Set();
    activeMidi.clear();
    if (insideClip && Array.isArray(clip.notes)) {
      const rel = SEQ.animBeat - clip.start;
      for (const n of clip.notes) {
        const s = n.start || 0;
        const e = s + (n.beats || 0);
        if (rel >= s && rel < e) activeMidi.add(n.midi);
      }
    }
    prBody.querySelectorAll('.pr-keyboard-row').forEach(row => {
      const m = +row.dataset.midi;
      row.classList.toggle('pr-key-active', activeMidi.has(m));
    });
  }
  // Keep roll-mode playhead pinned to visible viewport (absolute child scrolls with content)
  {
    const mLane = document.getElementById('seq-midi-lane');
    if (mLane) {
      const mPh = mLane.querySelector('.seq-playhead');
      if (mPh) {
        const st = mLane.scrollTop;
        mPh.style.top = (st - 7) + 'px';
        mPh.style.bottom = 'auto';
        mPh.style.height = (mLane.clientHeight + 14) + 'px';
      }
      // Highlight rows for notes active at current beat
      const beat = SEQ.animBeat;
      const activeMidi = new Set(
        (firstTrackOfKind('free')?.items || []).filter(it => beat >= it.start && beat < it.start + it.beats).map(it => it.midi)
      );
      mLane.querySelectorAll('.roll-row').forEach(row => {
        row.classList.toggle('roll-row-active', activeMidi.has(+row.dataset.midi));
      });
    }
  }
  // Chord view (if open) gets its playhead position + current-card
  // highlight updated on every frame.
  if (typeof updateChordViewPlayhead === 'function') updateChordViewPlayhead();
  SEQ.rafId = requestAnimationFrame(seqAnimatePlayhead);
}

function seqTotalDur() {
  return (SEQ.loopEnd - SEQ.loopStart) * seqBeatDur();
}

function seqResyncAnimLoop() {
  const newLen   = SEQ.loopEnd - SEQ.loopStart;
  const newStart = SEQ.loopStart;
  if (newLen !== SEQ.animLoopLen || newStart !== SEQ.animLoopStart) {
    const pos = ((SEQ.animBeat - newStart) % newLen + newLen) % newLen;
    SEQ.animBeat = newStart + pos;
    SEQ.animLoopLen   = newLen;
    SEQ.animLoopStart = newStart;
  }
}

function seqLoopOffset() { return SEQ.loop ? SEQ.loopStart : 0; }
function seqItemInRange(item) { return !SEQ.loop || (item.start >= SEQ.loopStart && item.start < SEQ.loopEnd); }
function seqFindNextInRange(items, fromIdx) {
  if (!SEQ.loop) return fromIdx < items.length ? fromIdx : -1;
  for (let i = fromIdx; i < items.length; i++) {
    if (items[i].start >= SEQ.loopStart && items[i].start < SEQ.loopEnd) return i;
  }
  return -1;
}

function seqLaneWidth(items) {
  const blockEnd = items.reduce((m, x) => Math.max(m, x.start + x.beats), 0);
  return Math.max(blockEnd, SEQ.loopEnd, 4) * BEAT_PX + 64;
}

function seqAutoExtendLoop(blockEnd) {
  if (blockEnd > SEQ.loopEnd) {
    SEQ.loopEnd = blockEnd;
    seqUpdateLoopEnd();
    // The loop's total length just changed. During playback, every
    // track's pending schedule was anchored to the OLD total via its
    // cycleStart — keeping any of those would put tracks out of phase
    // with the new boundary (the symptom: some chords sound softer
    // because re-scheduled notes overlap held ones, and the loop
    // appears to shift). Re-anchor + resync ALL tracks against the
    // new total so they wrap together.
    if (SEQ.playing) seqLoopBaseChangedResync();
  }
}

function seqUpdateLoopVisible() {
  // Keep loop markers & shading in the DOM regardless of SEQ.loop, and let
  // CSS dim them via a body-level class when loop is disabled.
  document.getElementById('seq-loop-end')?.style.removeProperty('display');
  document.getElementById('seq-loop-start')?.style.removeProperty('display');
  document.querySelectorAll('.seq-loop-line, .seq-loop-start-line').forEach(l => l.style.removeProperty('display'));
  document.body.classList.toggle('loop-disabled', !SEQ.loop);
}

function seqUpdateLoopEnd() {
  const px = SEQ.loopEnd * BEAT_PX;
  document.querySelectorAll('.seq-loop-end').forEach(h => { h.style.left = px + 'px'; });
  document.querySelectorAll('.seq-loop-line').forEach(l => { l.style.left = px + 'px'; });
  const cLane = document.getElementById('seq-lane');
  const mLane = document.getElementById('seq-midi-lane');
  const chordItems = firstTrackOfKind('chord')?.items || [];
  const freeItems  = firstTrackOfKind('free')?.items  || [];
  if (cLane && chordItems.length > 0) cLane.style.minWidth = seqLaneWidth(chordItems) + 'px';
  if (mLane && freeItems.length  > 0) mLane.style.minWidth = seqLaneWidth(freeItems) + 'px';
  _syncRulerLoopBar();
  seqUpdateLoopVisible();
  if (SEQ.chordViewOpen && typeof renderChordView === 'function') renderChordView();
}

function seqUpdateLoopStart() {
  const px = SEQ.loopStart * BEAT_PX;
  document.querySelectorAll('.seq-loop-start').forEach(h => { h.style.left = Math.max(0, px - 11) + 'px'; });
  document.querySelectorAll('.seq-loop-start-line').forEach(l => { l.style.left = px + 'px'; });
  _syncRulerLoopBar();
  seqUpdateLoopVisible();
  if (SEQ.chordViewOpen && typeof renderChordView === 'function') renderChordView();
}

// Re-sync the orange loop-range bar on the ruler with the current
// SEQ.loopStart / SEQ.loopEnd. Called whenever the loop boundaries
// move — keep this here instead of relying on the bar being re-created.
function _syncRulerLoopBar() {
  const bar = document.querySelector('#seq-ruler .seq-loop-bar');
  if (!bar) return;
  bar.style.left  = (SEQ.loopStart * BEAT_PX) + 'px';
  bar.style.width = Math.max(2, (SEQ.loopEnd - SEQ.loopStart) * BEAT_PX) + 'px';
}

function seqMakeBlock(item, idx, isNote, isMidi = false) {
  const _activeTrack = firstTrackOfKind((isMidi || isNote) ? 'free' : 'chord');
  const activeIdx = _activeTrack ? _activeTrack.activeIdx : -1;
  const block = document.createElement('div');
  block.className = 'seq-block' + (isMidi ? ' seq-midi-block' : isNote ? ' seq-note-block' : '') + (idx === activeIdx ? ' active' : '');
  block.dataset.idx = idx;
  block.style.left  = (item.start * BEAT_PX) + 'px';
  block.style.width = (item.beats * BEAT_PX) + 'px';

  const name = document.createElement('span');
  name.className = 'seq-block-name';
  name.innerHTML = item.label;
  block.appendChild(name);

  const ticks = document.createElement('div');
  ticks.className = 'seq-block-ticks';
  const refreshTicks = (beats) => {
    ticks.innerHTML = '';
    for (let i = 1; i < beats; i++) {
      const tk = document.createElement('span');
      tk.className = 'seq-tick';
      tk.style.left = ((i / beats) * 100) + '%';
      ticks.appendChild(tk);
    }
  };
  refreshTicks(item.beats);
  block.appendChild(ticks);

  // LEFT resize handle for chord/note blocks — moves item.start while
  // keeping the right edge anchored (so the absolute end position stays
  // the same). Cannot shrink below `snap` beats or push start negative.
  const resizeL = document.createElement('div');
  resizeL.className = 'seq-resize seq-resize-left';
  resizeL.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    seqCheckpoint();
    resizeL.setPointerCapture(e.pointerId);
    const startX = e.clientX, startStart = item.start, startBts = item.beats;
    const snap = SEQ.arrSnap ? SEQ.arrSnapVal : 0.5;
    const laneL = block.parentElement;
    const ownerL =
      (laneL && laneL.dataset && laneL.dataset.trackId && trackById(laneL.dataset.trackId)) ||
      (isMidi ? firstTrackOfKind('free') : isNote ? null : firstTrackOfKind('chord'));
    const itemsL = ownerL ? ownerL.items : (firstTrackOfKind((isMidi || isNote) ? 'free' : 'chord')?.items || []);
    const onMove = (ev) => {
      const dxBeats = (ev.clientX - startX) / BEAT_PX;
      const maxDelta = startBts - snap;
      const delta = Math.max(-startStart, Math.min(maxDelta, dxBeats));
      item.start = startStart + delta;
      item.beats = startBts - delta;
      block.style.left  = (item.start * BEAT_PX) + 'px';
      block.style.width = (item.beats * BEAT_PX) + 'px';
      refreshTicks(Math.round(item.beats));
      if (laneL) laneL.style.minWidth = seqLaneWidth(itemsL) + 'px';
    };
    const onUp = () => {
      resizeL.removeEventListener('pointermove', onMove);
      resizeL.removeEventListener('pointerup', onUp);
      const snapped = Math.max(0, Math.round(item.start / snap) * snap);
      const delta = snapped - item.start;
      item.start = snapped;
      item.beats = Math.max(snap, item.beats - delta);
      if (isNote || isMidi) seqAutoExtendLoop(item.start + item.beats);
      if (ownerL) seqRenderTrack(ownerL);
    };
    resizeL.addEventListener('pointermove', onMove);
    resizeL.addEventListener('pointerup', onUp);
  });
  block.appendChild(resizeL);

  const resize = document.createElement('div');
  resize.className = 'seq-resize';
  resize.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    seqCheckpoint();
    resize.setPointerCapture(e.pointerId);
    const startX = e.clientX, startBts = item.beats;
    const snap = 0.5;
    const lane = block.parentElement;
    const ownerResize =
      (lane && lane.dataset && lane.dataset.trackId && trackById(lane.dataset.trackId)) ||
      (isMidi ? firstTrackOfKind('free') : isNote ? null : firstTrackOfKind('chord'));
    const items = ownerResize ? ownerResize.items : (firstTrackOfKind((isMidi || isNote) ? 'free' : 'chord')?.items || []);
    const onMove = (ev) => {
      item.beats = Math.max(snap, startBts + (ev.clientX - startX) / BEAT_PX);
      block.style.width = (item.beats * BEAT_PX) + 'px';
      refreshTicks(Math.round(item.beats));
      if (lane) lane.style.minWidth = seqLaneWidth(items) + 'px';
      if (isNote || isMidi) seqAutoExtendLoop(item.start + item.beats);
    };
    const onUp = () => {
      resize.removeEventListener('pointermove', onMove);
      resize.removeEventListener('pointerup', onUp);
      item.beats = Math.max(snap, Math.round(item.beats / snap) * snap);
      block.style.width = (item.beats * BEAT_PX) + 'px';
      refreshTicks(item.beats);
      if (isNote || isMidi) seqAutoExtendLoop(item.start + item.beats);
      seqSave();
    };
    resize.addEventListener('pointermove', onMove);
    resize.addEventListener('pointerup', onUp);
  });
  block.appendChild(resize);

  // Move by drag
  block.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.seq-resize') || e.target.closest('.seq-delete')) return;
    if (SEQ.arrTool === 'pan' || SEQ._arrSpaceHeld) return;
    if (SEQ.arrTool === 'erase') {
      e.preventDefault();
      seqCheckpoint();
      const lane2 = block.parentElement;
      const ot2 = (lane2 && lane2.dataset && lane2.dataset.trackId && trackById(lane2.dataset.trackId)) ||
                  (isMidi ? firstTrackOfKind('free') : isNote ? null : firstTrackOfKind('chord'));
      const items2 = ot2 ? ot2.items : (firstTrackOfKind((isMidi || isNote) ? 'free' : 'chord')?.items || []);
      const i = items2.indexOf(item);
      if (i >= 0) items2.splice(i, 1);
      if (ot2) { seqRenderTrack(ot2); seqResyncTrack(ot2); }
      seqSave();
      return;
    }
    e.preventDefault();
    seqCheckpoint();
    block.setPointerCapture(e.pointerId);
    const startX = e.clientX, startBeat = item.start;
    const snap = SEQ.arrSnap ? SEQ.arrSnapVal : (1 / BEAT_PX);
    const sourceLane  = block.parentElement;
    // Group-move: if this block is part of a multi-selection of chord
    // items, drag/drop affects all of them together.
    const isChordItem = !isMidi && !isNote;
    const groupItems  = (isChordItem && SEQ.selection.some(s => s.item === item))
      ? SEQ.selection
          .filter(s => {
            const tr = trackById(s.trackId);
            return tr && tr.kind === 'chord' && !Array.isArray(s.item.notes);
          })
          .map(s => ({ track: trackById(s.trackId), item: s.item, startBeat: s.item.start }))
      : null;
    // Derive the owning track from the parent lane's data-track-id, falling
    // back to the legacy kind mapping for the hardcoded default lanes.
    const ownerTrack =
      (sourceLane && sourceLane.dataset && sourceLane.dataset.trackId && trackById(sourceLane.dataset.trackId)) ||
      (isMidi ? firstTrackOfKind('free') : isNote ? null : firstTrackOfKind('chord'));
    // Audible preview routed through the owner track's output (MIDI or
    // in-app instrument) so what you hear matches sequencer playback.
    // Skipped while playback is running — you're listening to the song.
    if (!SEQ.playing) {
      const previewMidi = [];
      if (isMidi || isNote) {
        previewMidi.push(item.midi);
      } else {
        const kr  = item.keyRoot !== undefined ? item.keyRoot : state.keys[state.currentTemplate];
        const oct = item.octave  !== undefined ? item.octave  : state.octave;
        chordToMidiNotes(kr, oct, item.interval, item.q, item.voicing).forEach(m => previewMidi.push(m));
      }
      if (previewMidi.length && ownerTrack && ownerTrack.output === 'midi') {
        const port = midiPortById(ownerTrack.midiPortId);
        const vel  = seqTrackVel(ownerTrack, state.velocity);
        previewMidi.forEach(m => sendNoteOn(m, vel, ownerTrack.channel, port));
        const stop = () => previewMidi.forEach(m => sendNoteOff(m, ownerTrack.channel, port));
        block.addEventListener('pointerup',     stop, { once: true });
        block.addEventListener('pointercancel', stop, { once: true });
      } else if (previewMidi.length && state.audioEnabled) {
        const inst  = ownerTrack ? seqTrackInstrument(ownerTrack) : null;
        const synth = ownerTrack ? ownerTrack.synth : null;
        const previewNodes = [];
        previewMidi.forEach(m => {
          let node;
          if (synth) withSynth(synth, () => { node = startAudioNote(m, state.velocity, null, null, inst); });
          else node = startAudioNote(m, state.velocity, null, null, inst);
          if (node) previewNodes.push(node);
        });
        const stop = () => previewNodes.forEach(stopAudioNote);
        block.addEventListener('pointerup',     stop, { once: true });
        block.addEventListener('pointercancel', stop, { once: true });
      }
    }
    const items = ownerTrack ? ownerTrack.items : (firstTrackOfKind((isMidi || isNote) ? 'free' : 'chord')?.items || []);
    let cloneCreated = false;
    let cloneRefs    = []; // [{ track, item }] for the alt-drag duplicates
    let moved = false;
    let ghost = null;
    let groupGhosts = []; // [{ el, gItem }] — one per follower in groupItems
    let groupGhostLane = null;
    let targetLane = sourceLane;
    let targetTrack = ownerTrack;
    let currentSnapped = startBeat;
    const clearGroupGhosts = () => {
      for (const g of groupGhosts) g.el.remove();
      groupGhosts = [];
      groupGhostLane = null;
    };
    const onMove = (ev) => {
      _edgeAutoScroll(document.getElementById('seq-lane-wrap'), ev.clientX);
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 2) return;
      // Use the live pointermove altKey only — `e.altKey` (pointerdown)
      // would stick "true" after the user lets go of Alt mid-drag and
      // prevent the clones from being removed.
      const altCopy = ev.altKey;
      if (altCopy && !cloneCreated) {
        // Don't re-render during the drag — that would tear the dragged
        // block out of the DOM and break pointer capture. Just push the
        // clones into the arrays; onUp re-renders affected tracks.
        if (groupItems) {
          for (const g of groupItems) {
            const cloneItem = JSON.parse(JSON.stringify(g.item));
            cloneItem.start = g.startBeat;
            g.track.items.push(cloneItem);
            g.track.items.sort((a, b) => a.start - b.start);
            cloneRefs.push({ track: g.track, item: cloneItem });
          }
        } else {
          const cloneItem = JSON.parse(JSON.stringify(item));
          cloneItem.start = startBeat;
          items.push(cloneItem);
          items.sort((a, b) => a.start - b.start);
          cloneRefs.push({ track: ownerTrack, item: cloneItem });
        }
        cloneCreated = true;
      } else if (!altCopy && cloneCreated) {
        // Alt released mid-drag — drop back to move-only by removing
        // the clones we created. Originals keep moving with the cursor.
        for (const r of cloneRefs) {
          const idx = r.track.items.indexOf(r.item);
          if (idx >= 0) r.track.items.splice(idx, 1);
        }
        cloneRefs = [];
        cloneCreated = false;
        block.classList.remove('copy-drag');
      }
      moved = true;
      block.classList.add('moving');
      if (altCopy) block.classList.add('copy-drag');
      // Block stays put; only the ghost moves. item.start is committed
      // from the ghost position on pointerup.
      const liveStart = Math.max(0, startBeat + dx / BEAT_PX);
      const snapped = Math.max(0, Math.round(liveStart / snap) * snap);
      currentSnapped = snapped;
      // Cross-track drop targets — chord-blocks can go to other chord lanes
      // or to free lanes (converted to a clip on drop). Note-blocks and
      // free-clip blocks aren't routed through this seqMakeBlock path.
      const els = document.elementsFromPoint(ev.clientX, ev.clientY);
      const overLane = els.find(el => el.classList?.contains('seq-lane'));
      if (overLane) {
        const t = trackById(overLane.dataset.trackId);
        if (!isMidi && !isNote) {
          if (t && (t.kind === 'chord' || t.kind === 'free')) { targetLane = overLane; targetTrack = t; }
        } else {
          if (t && t.kind === (isMidi ? 'free' : 'chord')) { targetLane = overLane; targetTrack = t; }
        }
      }
      if (ghost && ghost.parentElement !== targetLane) { ghost.remove(); ghost = null; }
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'seq-ghost';
        ghost.style.width = (item.beats * BEAT_PX) + 'px';
        targetLane?.appendChild(ghost);
      }
      ghost.style.left = (snapped * BEAT_PX) + 'px';
      // Multi-select ghosts — one per other selected chord item, all in
      // the target lane at their group-relative position.
      if (groupItems) {
        const deltaBeats = snapped - startBeat;
        if (groupGhostLane !== targetLane) {
          clearGroupGhosts();
          for (const gi of groupItems) {
            if (gi.item === item) continue; // lead has its own ghost
            const el = document.createElement('div');
            el.className = 'seq-ghost';
            el.style.width = (gi.item.beats * BEAT_PX) + 'px';
            targetLane?.appendChild(el);
            groupGhosts.push({ el, gItem: gi });
          }
          groupGhostLane = targetLane;
        }
        for (const g of groupGhosts) {
          const ns = Math.max(0, g.gItem.startBeat + deltaBeats);
          g.el.style.left = (ns * BEAT_PX) + 'px';
        }
      }
    };
    const onUp = (ev) => {
      block.removeEventListener('pointermove', onMove);
      block.removeEventListener('pointerup', onUp);
      block.classList.remove('moving');
      if (ghost) { ghost.remove(); ghost = null; }
      clearGroupGhosts();
      if (moved) {
        item.start = currentSnapped;
        const groupTargetChord = groupItems && targetTrack && targetTrack.kind === 'chord';
        const groupTargetFree  = groupItems && targetTrack && targetTrack.kind === 'free';
        if (groupItems && (groupTargetChord || groupTargetFree || targetTrack === ownerTrack)) {
          // Multi-move: apply lead item's beat-delta to every selected
          // chord item, and (if target track changed) move/convert them
          // all to the new track. Free target → bake notes into a clip;
          // chord target → just move the chord item.
          const deltaBeats = item.start - startBeat;
          const affected = new Set();
          for (const g of groupItems) {
            const newStart = Math.max(0, Math.round((g.startBeat + deltaBeats) / snap) * snap);
            g.item.start = newStart;
            affected.add(g.track);
            if (targetTrack && targetTrack !== g.track && (groupTargetChord || groupTargetFree)) {
              const idx = g.track.items.indexOf(g.item);
              if (idx >= 0) g.track.items.splice(idx, 1);
              let placed = g.item;
              if (groupTargetFree) {
                const kr  = g.item.keyRoot !== undefined ? g.item.keyRoot : state.keys[state.currentTemplate];
                const oct = g.item.octave  !== undefined ? g.item.octave  : state.octave;
                const midis = chordToMidiNotes(kr, oct, g.item.interval, g.item.q, g.item.voicing);
                placed = makeClip({
                  start: newStart, beats: g.item.beats,
                  label: g.item.label || '',
                  notes: midis.map(m => ({ midi: m, label: midiNoteLabel(m), start: 0, beats: g.item.beats })),
                });
              }
              targetTrack.items.push(placed);
              // Update the selection's trackId so subsequent ops know
              // the item's new home.
              const sel = SEQ.selection.find(s => s.item === g.item);
              if (sel) { sel.trackId = targetTrack.id; if (placed !== g.item) sel.item = placed; }
              affected.add(targetTrack);
            }
          }
          affected.forEach(t => {
            if (!t) return;
            t.items.sort((a, b) => a.start - b.start);
            seqRenderTrack(t);
            seqResyncTrack(t);
          });
        } else if (targetTrack && targetTrack !== ownerTrack) {
          const idx = items.indexOf(item);
          if (idx >= 0) items.splice(idx, 1);
          if (targetTrack.kind === 'free' && !isMidi && !isNote) {
            // Convert chord item → free clip with the chord's notes baked in.
            const kr = item.keyRoot !== undefined ? item.keyRoot : state.keys[state.currentTemplate];
            const oct = item.octave !== undefined ? item.octave : state.octave;
            const midis = chordToMidiNotes(kr, oct, item.interval, item.q, item.voicing);
            const clip = makeClip({
              start: item.start, beats: item.beats,
              label: item.label || '',
              notes: midis.map(m => ({ midi: m, label: midiNoteLabel(m), start: 0, beats: item.beats })),
            });
            targetTrack.items.push(clip);
          } else {
            targetTrack.items.push(item);
          }
          targetTrack.items.sort((a, b) => a.start - b.start);
          if (ownerTrack) seqRenderTrack(ownerTrack);
          seqRenderTrack(targetTrack);
          if (ownerTrack) seqResyncTrack(ownerTrack);
          seqResyncTrack(targetTrack);
          // Loop bounds are user-controlled; only auto-extend for note
          // / clip placements, never for chord items.
          if (isNote || isMidi) seqAutoExtendLoop(item.start + item.beats);
        } else {
          items.sort((a, b) => a.start - b.start);
          if (ownerTrack) seqRenderTrack(ownerTrack);
          if (isNote || isMidi) seqAutoExtendLoop(item.start + item.beats);
        }
      } else if (ownerTrack) {
        seqSelectionToggle(ownerTrack, item, ev.ctrlKey || ev.metaKey || ev.shiftKey);
      }
    };
    block.addEventListener('pointermove', onMove);
    block.addEventListener('pointerup', onUp);
  });

  // Double-click a CHORD block (not note/midi) → open the chord view
  // for the owning track.
  if (!isNote && !isMidi) {
    block.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const laneEl = block.parentElement;
      const owner = (laneEl && laneEl.dataset && laneEl.dataset.trackId)
        ? trackById(laneEl.dataset.trackId)
        : firstTrackOfKind('chord');
      if (owner && typeof openChordView === 'function') openChordView(owner);
    });
    // Right-click → small popover to override the per-clip voicing.
    // Item-level voicing was captured at drop time; this lets the user
    // change it without affecting the global voicing or other clips.
    block.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _showChordBlockMenu(e.clientX, e.clientY, item, block);
    });
  }

  return block;
}

// Floating right-click menu for chord blocks — per-clip overrides for
// voicing, octave and bass. Removes itself on outside-click or Esc.
function _showChordBlockMenu(clientX, clientY, item, block) {
  document.querySelectorAll('.seq-block-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'seq-block-menu';
  // Pre-build option lists.
  const octaveOpts = ['<option value="">— global —</option>']
    .concat([1,2,3,4,5,6,7,8].map(o => `<option value="${o}">${o}</option>`))
    .join('');
  // Bass merges enabled+octave into a single picker: '' = global,
  // 'off' = disabled, '0'..'4' = enabled at that octave.
  const bassOpts = '<option value="">— global —</option>'
    + '<option value="off">off</option>'
    + [0,1,2,3,4].map(o => `<option value="${o}">oct ${o}</option>`).join('');
  menu.innerHTML = `
    <div class="seq-block-menu-row">
      <span class="seq-block-menu-label">Voicing</span>
      <select class="seq-block-menu-voicing">
        <option value="">— global —</option>
        <option value="auto">Auto</option>
        <option value="auto1">Auto 1st</option>
        <option value="auto2">Auto 2nd</option>
        <option value="high">High</option>
        <option value="low">Low</option>
        <option value="spread">Spread</option>
        <option value="root">Root</option>
      </select>
    </div>
    <div class="seq-block-menu-row">
      <span class="seq-block-menu-label">Octave</span>
      <select class="seq-block-menu-octave">${octaveOpts}</select>
    </div>
    <div class="seq-block-menu-row">
      <span class="seq-block-menu-label">Bass</span>
      <select class="seq-block-menu-bass">${bassOpts}</select>
    </div>
  `;
  document.body.appendChild(menu);
  // Position; flip if it'd overflow the viewport.
  const r = menu.getBoundingClientRect();
  let left = clientX;
  let top  = clientY;
  if (left + r.width  > window.innerWidth  - 8) left = window.innerWidth  - r.width  - 8;
  if (top  + r.height > window.innerHeight - 8) top  = window.innerHeight - r.height - 8;
  menu.style.left = left + 'px';
  menu.style.top  = top  + 'px';
  const selV = menu.querySelector('.seq-block-menu-voicing');
  const selO = menu.querySelector('.seq-block-menu-octave');
  const selB = menu.querySelector('.seq-block-menu-bass');
  selV.value = item.voicing ?? '';
  selO.value = item.octave  != null ? String(item.octave) : '';
  selB.value = (item.bassEnabled === false)
    ? 'off'
    : (item.bassOctave != null ? String(item.bassOctave) : '');
  const onChange = () => {
    seqCheckpoint();
    if (selV.value === '') delete item.voicing; else item.voicing = selV.value;
    if (selO.value === '') delete item.octave;  else item.octave  = +selO.value;
    if (selB.value === '') {
      delete item.bassEnabled; delete item.bassOctave;
    } else if (selB.value === 'off') {
      item.bassEnabled = false;
      delete item.bassOctave;
    } else {
      item.bassEnabled = true;
      item.bassOctave  = +selB.value;
    }
    seqSave();
    const laneEl = block.parentElement;
    const owner  = (laneEl && laneEl.dataset && laneEl.dataset.trackId)
      ? trackById(laneEl.dataset.trackId) : null;
    if (owner) {
      seqRenderTrack(owner);
      seqResyncTrack(owner);
    }
  };
  selV.addEventListener('change', onChange);
  selO.addEventListener('change', onChange);
  selB.addEventListener('change', onChange);
  setTimeout(() => selV.focus(), 0);
  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown',   onKey,     true);
  };
  const onOutside = (ev) => { if (!menu.contains(ev.target)) close(); };
  const onKey     = (ev) => { if (ev.key === 'Escape') close(); };
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown',   onKey,     true);
  }, 0);
}

const SEQ_KEY = 'chord-pad-seq-v1';
// Local-only UI preferences, kept separate from project content so
// importing a project doesn't clobber your view-state (current key,
// voicing, octave, …). Only goes to localStorage — never to JSON export.
const UI_PREFS_KEY = 'chord-pad-ui-v1';
function uiPrefsSave() {
  try {
    const blob = {
      padKeys: { ...state.keys },
      padTemplate: state.currentTemplate,
      followArr: !!SEQ.followArr,
      followPr:  !!SEQ.followPr,
      chordviewTrackId: SEQ.focusedChordTrackId || null,
      arrBeatPx: BEAT_PX,
      prBeatPx:  PR_BEAT_PX,
      chordviewPxPerBeat: (typeof CHORDVIEW_PX_PER_BEAT !== 'undefined') ? CHORDVIEW_PX_PER_BEAT : null,
      // Keyboard's own instrument + synth + output routing — kept local
      // so a project import doesn't change the user's keyboard sound.
      keyboardTrack: state.keyboardTrack ? {
        instrument:  state.keyboardTrack.instrument,
        output:      state.keyboardTrack.output,
        channel:     state.keyboardTrack.channel,
        midiPortId:  state.keyboardTrack.midiPortId,
        volume:      state.keyboardTrack.volume,
        synth:       state.keyboardTrack.synth,
      } : null,
    };
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify(blob));
  } catch (_) {}
}
function uiPrefsLoad() {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.padKeys && typeof d.padKeys === 'object') {
      for (const k in d.padKeys) {
        if (k in state.keys && typeof d.padKeys[k] === 'number') state.keys[k] = d.padKeys[k];
      }
    }
    if (typeof d.padTemplate === 'string' && d.padTemplate in state.keys) state.currentTemplate = d.padTemplate;
    if (typeof d.followArr === 'boolean') SEQ.followArr = d.followArr;
    if (typeof d.followPr  === 'boolean') SEQ.followPr  = d.followPr;
    if (typeof d.chordviewTrackId === 'string') SEQ.focusedChordTrackId = d.chordviewTrackId;
    if (typeof d.arrBeatPx === 'number' && d.arrBeatPx >= 8 && d.arrBeatPx <= 160) BEAT_PX = d.arrBeatPx;
    if (typeof d.prBeatPx  === 'number' && d.prBeatPx  >= 8 && d.prBeatPx  <= 200) PR_BEAT_PX  = d.prBeatPx;
    if (d.keyboardTrack && state.keyboardTrack) {
      const k = d.keyboardTrack;
      if (typeof k.instrument === 'string') state.keyboardTrack.instrument = k.instrument;
      if (k.output === 'instrument' || k.output === 'midi') state.keyboardTrack.output = k.output;
      if (typeof k.channel === 'number') state.keyboardTrack.channel = k.channel;
      if (typeof k.midiPortId === 'string') state.keyboardTrack.midiPortId = k.midiPortId;
      if (typeof k.volume === 'number') state.keyboardTrack.volume = k.volume;
      if (k.synth && typeof k.synth === 'object') state.keyboardTrack.synth = { ...state.keyboardTrack.synth, ...k.synth };
    }
    // chordview zoom is restored by chordview.js itself once it has
    // declared its own CHORDVIEW_PX_PER_BEAT (loads after this file).
  } catch (_) {}
}

// Produce the JSON-serializable snapshot of the whole project. Same shape
// used by seqSave() (→ localStorage) and seqExportProject() (→ download).
function seqProjectSnapshot() {
  // Serialize each track minus its transient playback / drag state.
  const tracksOut = SEQ.tracksList.map(t => ({
    id: t.id, kind: t.kind, name: t.name,
    instrument: t.instrument, channel: t.channel, volume: t.volume, output: t.output, midiPortId: t.midiPortId, midiInPortId: t.midiInPortId,
    muted: t.muted, soloed: t.soloed, synth: t.synth,
    items: t.items,
  }));
  return {
    tracksList: tracksOut,
    loopStart: SEQ.loopStart,
    loopEnd: SEQ.loopEnd,
    loop: SEQ.loop,
    beatsPerBar: state.beatsPerBar,
    tempo: state.tempo,
    volumeBalance: state.volumeBalance,
    padOutput: state.padOutput,
    padChannel: state.padChannel,
    padMidiPortId: state.padMidiPortId,
    midiClockPortId: state.midiClockPortId,
    midiClockEnabled: state.midiClockEnabled,
    keyboardMidiPortId: state.keyboardMidiPortId,
    prBodyHeight: SEQ.prBodyHeight,
    visualLatencyMs: SEQ.visualLatencyMs,
  };
}
function seqSave() {
  try { localStorage.setItem(SEQ_KEY, JSON.stringify(seqProjectSnapshot())); } catch (_) {}
  // Mirror to UI prefs so things like the keyboard's virtual track —
  // which isn't part of the project snapshot — also persist whenever
  // the modal calls seqSave() after a change.
  uiPrefsSave();
}

// Trigger a browser download of the current project as a .json file.
function seqExportProject() {
  const data  = JSON.stringify({ chordPad: 1, savedAt: new Date().toISOString(), ...seqProjectSnapshot() }, null, 2);
  const blob  = new Blob([data], { type: 'application/json' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `chord-pad-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Apply an imported project snapshot. Same logic as seqLoad but reading
// from an arbitrary object instead of localStorage. Re-renders + saves
// so the new state immediately takes over (and persists).
function seqImportProject(d) {
  if (!d || typeof d !== 'object') return false;
  // Drop transient runtime state before swapping.
  if (SEQ.playing) seqStop();
  if (typeof d.loopStart       === 'number')  SEQ.loopStart        = d.loopStart;
  if (typeof d.loopEnd         === 'number')  SEQ.loopEnd          = d.loopEnd;
  if (typeof d.loop            === 'boolean') SEQ.loop             = d.loop;
  if (typeof d.beatsPerBar     === 'number')  state.beatsPerBar    = d.beatsPerBar;
  if (typeof d.tempo           === 'number')  state.tempo          = d.tempo;
  if (typeof d.volumeBalance   === 'boolean') state.volumeBalance  = d.volumeBalance;
  if (d.padOutput === 'midi' || d.padOutput === 'instrument') state.padOutput = d.padOutput;
  if (typeof d.padChannel      === 'number')  state.padChannel     = Math.max(0, Math.min(15, d.padChannel));
  if (typeof d.padMidiPortId   === 'string')  state.padMidiPortId  = d.padMidiPortId;
  if (typeof d.midiClockPortId === 'string')  state.midiClockPortId = d.midiClockPortId;
  if (typeof d.midiClockEnabled === 'boolean') state.midiClockEnabled = d.midiClockEnabled;
  if (typeof d.keyboardMidiPortId === 'string') state.keyboardMidiPortId = d.keyboardMidiPortId;
  if (typeof d.prBodyHeight    === 'number')  SEQ.prBodyHeight     = d.prBodyHeight;
  if (typeof d.visualLatencyMs === 'number')  SEQ.visualLatencyMs  = d.visualLatencyMs;
  if (Array.isArray(d.tracksList)) {
    SEQ.tracksList.length = 0;
    for (const tIn of d.tracksList) {
      let items = Array.isArray(tIn.items) ? tIn.items : [];
      if ((tIn.kind || 'free') === 'free') {
        items = items.map(it => Array.isArray(it.notes) ? it : clipFromLegacyNote(it));
      }
      SEQ.tracksList.push(makeTrack({
        id: tIn.id, kind: tIn.kind || 'free', name: tIn.name,
        instrument: tIn.instrument, channel: tIn.channel, volume: tIn.volume,
        output: tIn.output, midiPortId: tIn.midiPortId, midiInPortId: tIn.midiInPortId,
        muted: tIn.muted, soloed: tIn.soloed, synth: tIn.synth,
        items,
      }));
    }
  }
  // Clear selection — old refs point at removed item objects.
  SEQ.selection = [];
  if (SEQ.prSelection) SEQ.prSelection.clear();
  SEQ.focusedClip = null;
  _dedupClipIds();
  // Rebuild UI from scratch + persist.
  if (typeof rebuildTracksUI === 'function') rebuildTracksUI();
  if (typeof seqRenderAll === 'function') seqRenderAll();
  if (typeof renderPianoRoll === 'function') renderPianoRoll();
  seqSave();
  return true;
}

// Walk every free-track clip and rewrite any duplicate / missing id
// to a fresh one. Legacy projects (or bugs in earlier versions) could
// leave two clips sharing one id — which makes `document.querySelector`
// pick the wrong block during drag, and makes double-click-to-open-in-
// piano-roll open the wrong clip. Returns true if any id was rewritten.
function _dedupClipIds() {
  const seen = new Set();
  let fixed = false;
  for (const tr of SEQ.tracksList) {
    if (tr.kind !== 'free') continue;
    for (const clip of tr.items) {
      if (!clip || typeof clip !== 'object') continue;
      if (!clip.id || seen.has(clip.id)) {
        clip.id = newClipId();
        fixed = true;
      }
      seen.add(clip.id);
    }
  }
  return fixed;
}

function seqLoad() {
  try {
    const raw = localStorage.getItem(SEQ_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (typeof d.loopStart   === 'number')  SEQ.loopStart      = d.loopStart;
    if (typeof d.loopEnd     === 'number')  SEQ.loopEnd        = d.loopEnd;
    if (typeof d.loop        === 'boolean') SEQ.loop           = d.loop;
    if (typeof d.beatsPerBar === 'number')  state.beatsPerBar  = d.beatsPerBar;
    if (typeof d.tempo       === 'number')  state.tempo        = d.tempo;
    if (typeof d.volumeBalance === 'boolean') state.volumeBalance = d.volumeBalance;
    if (d.padOutput === 'midi' || d.padOutput === 'instrument') state.padOutput = d.padOutput;
    if (typeof d.padChannel === 'number') state.padChannel = Math.max(0, Math.min(15, d.padChannel));
    if (typeof d.padMidiPortId === 'string') state.padMidiPortId = d.padMidiPortId;
    if (typeof d.midiClockPortId === 'string') state.midiClockPortId = d.midiClockPortId;
    if (typeof d.midiClockEnabled === 'boolean') state.midiClockEnabled = d.midiClockEnabled;
    if (typeof d.keyboardMidiPortId === 'string') state.keyboardMidiPortId = d.keyboardMidiPortId;
    if (typeof d.prBodyHeight  === 'number')  SEQ.prBodyHeight    = d.prBodyHeight;
    if (typeof d.visualLatencyMs === 'number') SEQ.visualLatencyMs = d.visualLatencyMs;

    if (Array.isArray(d.tracksList)) {
      // New format: full tracks list.
      SEQ.tracksList.length = 0;
      for (const tIn of d.tracksList) {
        let items = Array.isArray(tIn.items) ? tIn.items : [];
        // Free tracks: ensure every item is a clip. Migrate any legacy
        // bare-note items (no .notes) by wrapping them in a 1-note clip.
        if ((tIn.kind || 'free') === 'free') {
          items = items.map(it => Array.isArray(it.notes) ? it : clipFromLegacyNote(it));
        }
        SEQ.tracksList.push(makeTrack({
          id: tIn.id, kind: tIn.kind || 'free', name: tIn.name,
          instrument: tIn.instrument, channel: tIn.channel, volume: tIn.volume, output: tIn.output, midiPortId: tIn.midiPortId, midiInPortId: tIn.midiInPortId,
          muted: tIn.muted, soloed: tIn.soloed, synth: tIn.synth,
          items,
        }));
      }
      return;
    }

    // Legacy format: items / noteItems / midiItems + tracks{chords,melody,free}.
    const chordItems = Array.isArray(d.items) ? d.items : [];
    // Old melody items merge into the free track's items (melody kind removed).
    const legacyFree = [...(Array.isArray(d.midiItems) ? d.midiItems : []),
                        ...(Array.isArray(d.noteItems) ? d.noteItems : [])];
    const freeItems  = legacyFree.map(clipFromLegacyNote);
    const chordCfg = d.tracks?.chords || {};
    const freeCfg  = d.tracks?.free   || {};
    SEQ.tracksList.length = 0;
    SEQ.tracksList.push(makeTrack({
      id: 'tr-default-chord', kind: 'chord', name: 'Chords',
      instrument: chordCfg.instrument, channel: chordCfg.channel, volume: chordCfg.volume,
      muted: chordCfg.muted, soloed: chordCfg.soloed, synth: chordCfg.synth,
      items: chordItems,
    }));
    SEQ.tracksList.push(makeTrack({
      id: 'tr-default-free', kind: 'free', name: 'Free',
      instrument: freeCfg.instrument, channel: freeCfg.channel, volume: freeCfg.volume,
      muted: freeCfg.muted, soloed: freeCfg.soloed, synth: freeCfg.synth,
      items: freeItems,
    }));
  } catch (_) {}
}

// Fill any uninitialised per-track synth with a clone of the chord-pad
// defaults. Run after seqLoad so persisted track synths survive. The
// Every track has its own synth dict (chord-pad's state.synth is separate
// from the chord-track now). Seed missing synths from a sensible default.
function seqInitTrackSynths() {
  const epiano = INSTRUMENT_PRESETS?.epiano || state.synth;
  for (const tr of SEQ.tracksList) {
    if (!tr.synth) tr.synth = { ...epiano };
  }
  // Sync the id counter past any tr-N loaded from localStorage so freshly
  // added tracks never collide with existing ones.
  for (const tr of SEQ.tracksList) {
    const m = /^tr-(\d+)$/.exec(tr.id || '');
    if (m) _trackIdCounter = Math.max(_trackIdCounter, parseInt(m[1], 10));
  }
  // Defensive: ensure every free-track clip has a unique id.
  const fixed = _dedupClipIds();
  if (fixed) {
    try { localStorage.setItem(SEQ_KEY, JSON.stringify(seqProjectSnapshot())); } catch (_) {}
  }
  // Migrate stored chord labels: items dropped before a QUALITY_GLYPH
  // rename (e.g. `Maj7` → `maj7`) keep their old label string in
  // localStorage. Regenerate from q + keyRoot + interval on every load
  // so the visible chord names always track the current spelling.
  if (typeof QUALITY_GLYPH !== 'undefined' && typeof chordRootName === 'function'
      && typeof formatChordRoot === 'function' && typeof qualityToHTML === 'function') {
    for (const tr of SEQ.tracksList) {
      if (tr.kind !== 'chord') continue;
      for (const it of tr.items) {
        if (it.q == null || it.interval == null) continue;
        const root = chordRootName(it.keyRoot ?? state.keys[state.currentTemplate], it.interval);
        const glyph = QUALITY_GLYPH[it.q] ?? '';
        it.label = formatChordRoot(root) + qualityToHTML(glyph);
      }
    }
  }
}

function seqUpdateHints() {
  const wrap = document.getElementById('seq-lane-wrap');
  if (!wrap) return;
  const center = wrap.scrollLeft + wrap.clientWidth / 2;
  document.querySelectorAll('.seq-drop-hint').forEach(h => { h.style.left = center + 'px'; });
}

function refreshLucide() {
  if (window.lucide) lucide.createIcons();
}


function syncTrackLabelHeights() {
  // Match each lane's height to its label's natural content height — the
  // label has more rows (name, instrument, mixer) than fits in 54px and
  // setting the lane to match keeps the sidebar / arrangement aligned.
  document.querySelectorAll('.seq-track-label[data-track-id]').forEach(label => {
    const id   = label.dataset.trackId;
    const lane = document.querySelector(`.seq-lane[data-track-id="${id}"]`);
    if (!lane) return;
    label.style.height = '';
    const labelH = label.getBoundingClientRect().height;
    const laneH  = lane.getBoundingClientRect().height;
    const h = Math.max(labelH, laneH);
    label.style.height = h + 'px';
    lane.style.minHeight = h + 'px';
  });
}

function seqRender() {
  const lane = document.getElementById('seq-lane');
  if (!lane) return;
  lane.innerHTML = '';
  const items = firstTrackOfKind('chord')?.items || [];
  if (items.length === 0) {
    lane.style.minWidth = '';
  } else {
    lane.style.minWidth = seqLaneWidth(items) + 'px';
    items.forEach((item, idx) => lane.appendChild(seqMakeBlock(item, idx, false)));
  }
  _appendLaneOverlays(lane);
  seqUpdateLoopVisible();
  syncTrackLabelHeights();
  seqRenderRuler();
  refreshLucide();
  seqRefreshSelectionVisuals();
  seqSave();
}

function seqHighlight(idx) {
  const ct = firstTrackOfKind('chord');
  if (ct) ct.activeIdx = idx;
  document.querySelectorAll('#seq-lane .seq-block').forEach((b, i) => {
    b.classList.toggle('active', i === idx);
  });
}

function seqHighlightNote(idx) {
  // Note track was removed — keep the function as a no-op for old call
  // sites until they're all gone.
  document.querySelectorAll('#seq-note-lane .seq-block').forEach((b, i) => {
    b.classList.toggle('active', i === idx);
  });
}

const ROLL_ROW_H    = 8;
const ROLL_TOP_MIDI = 96;   // C7
const ROLL_BOT_MIDI = 24;   // C1
const ROLL_H        = (ROLL_TOP_MIDI - ROLL_BOT_MIDI + 1) * ROLL_ROW_H;  // 584px
let ROLL_VIEW_H     = 160;

function rollScrollForMidi(midi) {
  return Math.max(0, (ROLL_TOP_MIDI - midi) * ROLL_ROW_H - ROLL_VIEW_H / 2);
}

function rollBuildGrid(lane) {
  lane.style.padding = '0';
  // Normal-flow spacer gives the lane real scrollHeight so scrollTop works
  const spacer = document.createElement('div');
  spacer.style.cssText = `height:${ROLL_H}px;width:0;pointer-events:none;flex-shrink:0;`;
  lane.appendChild(spacer);
  for (let m = ROLL_TOP_MIDI; m >= ROLL_BOT_MIDI; m--) {
    const row = document.createElement('div');
    row.className = 'roll-row' + (midiIsBlack(m) ? ' roll-row-black' : '');
    row.dataset.midi = m;
    row.style.top    = (ROLL_TOP_MIDI - m) * ROLL_ROW_H + 'px';
    row.style.height = ROLL_ROW_H + 'px';
    if (m % 12 === 0 && !SEQ.rollKeyboard) {
      const lbl = document.createElement('span');
      lbl.className = 'roll-c-label';
      lbl.textContent = 'C' + (Math.floor(m / 12) - 1);
      row.appendChild(lbl);
    }
    lane.appendChild(row);
  }

}

function rollBuildKeyboard(lane) {
  const kb = document.createElement('div');
  kb.className = 'roll-keyboard';
  kb.style.height = ROLL_H + 'px';
  for (let m = ROLL_TOP_MIDI; m >= ROLL_BOT_MIDI; m--) {
    const isBlack = midiIsBlack(m);
    const key = document.createElement('div');
    key.className = 'roll-key ' + (isBlack ? 'roll-key-black' : 'roll-key-white');
    const rowTop = (ROLL_TOP_MIDI - m) * ROLL_ROW_H;
    if (isBlack) {
      key.style.top = rowTop + 'px';
    } else {
      const blackAbove = m < ROLL_TOP_MIDI && midiIsBlack(m + 1);
      const blackBelow = m > ROLL_BOT_MIDI && midiIsBlack(m - 1);
      const extTop    = blackAbove ? ROLL_ROW_H / 2 : 0;
      const extBottom = blackBelow ? ROLL_ROW_H / 2 : 0;
      key.style.top    = (rowTop - extTop) + 'px';
      key.style.height = (ROLL_ROW_H + extTop + extBottom) + 'px';
    }
    if (!isBlack && m % 12 === 0) {
      const lbl = document.createElement('span');
      lbl.className = 'roll-key-label';
      lbl.textContent = 'C' + (Math.floor(m / 12) - 1);
      key.appendChild(lbl);
    }
    key.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      key.setPointerCapture(e.pointerId);
      kbNoteOn(m);
      key.addEventListener('pointerup',    () => kbNoteOff(m), { once: true });
      key.addEventListener('pointercancel',() => kbNoteOff(m), { once: true });
    });
    kb.appendChild(key);
  }
  lane.appendChild(kb);
}

function updateKeyboardPosition() {
  const wrap = document.getElementById('seq-lane-wrap');
  const lane = document.getElementById('seq-midi-lane');
  if (!wrap || !lane) return;
  const kb = lane.querySelector('.roll-keyboard');
  if (kb) kb.style.left = wrap.scrollLeft + 'px';
}

function updateRollOverflow() {
  const lane = document.getElementById('seq-midi-lane');
  if (!lane) return;
  const st    = lane.scrollTop;
  const viewH = lane.clientHeight || ROLL_VIEW_H;

  lane.querySelectorAll('.roll-overflow-top, .roll-overflow-bot').forEach(el => el.remove());

  const topVisibleMidi = ROLL_TOP_MIDI - st / ROLL_ROW_H;
  const botVisibleMidi = ROLL_TOP_MIDI - (st + viewH) / ROLL_ROW_H;

  (firstTrackOfKind('free')?.items || []).forEach(item => {
    const above = item.midi > topVisibleMidi;
    const below = item.midi < botVisibleMidi;
    if (!above && !below) return;
    const mark = document.createElement('div');
    mark.className = above ? 'roll-overflow-top' : 'roll-overflow-bot';
    mark.style.left  = (item.start * BEAT_PX) + 'px';
    mark.style.width = Math.max(4, item.beats * BEAT_PX) + 'px';
    mark.style.top   = above ? st + 'px' : (st + viewH - 3) + 'px';
    lane.appendChild(mark);
  });
}

function midiIsBlack(midi) {
  return [1, 3, 6, 8, 10].includes(midi % 12);
}

function seqRollAddLines(lane) {
  const isRoll = lane.classList.contains('roll-mode');
  const sl = document.createElement('div');
  sl.className = 'seq-loop-start-line';
  sl.style.left = (SEQ.loopStart * BEAT_PX) + 'px';
  if (isRoll) { sl.style.top = '0'; sl.style.height = ROLL_H + 'px'; sl.style.bottom = 'auto'; }
  lane.appendChild(sl);
  const ll = document.createElement('div');
  ll.className = 'seq-loop-line';
  ll.style.left = (SEQ.loopEnd * BEAT_PX) + 'px';
  if (isRoll) { ll.style.top = '0'; ll.style.height = ROLL_H + 'px'; ll.style.bottom = 'auto'; }
  lane.appendChild(ll);
  const ph = document.createElement('div');
  ph.className = 'seq-playhead';
  ph.style.display = SEQ.playing ? 'block' : 'none';
  lane.appendChild(ph);
}


// cfg: { items, track, onRerender, activeIdx, noteClass, yDrag }
function seqMakeRollNote(item, idx, topMidi, botMidi, cfg) {
  const block = document.createElement('div');
  block.className = 'roll-note' + (cfg.noteClass ? ' ' + cfg.noteClass : '') + (idx === cfg.activeIdx ? ' active' : '');
  block.style.left   = (item.start * BEAT_PX) + 'px';
  block.style.top    = (topMidi - item.midi) * ROLL_ROW_H + 'px';
  block.style.width  = Math.max(ROLL_ROW_H, item.beats * BEAT_PX) + 'px';
  block.style.height = (ROLL_ROW_H - 1) + 'px';

  if (item.beats * BEAT_PX > 20) {
    const lbl = document.createElement('span');
    lbl.className = 'roll-note-label';
    lbl.textContent = item.label;
    block.appendChild(lbl);
  }

  // Delete
  const del = document.createElement('span');
  del.className = 'roll-note-del';
  del.innerHTML = '<i data-lucide="x"></i>';
  del.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
  del.addEventListener('click', e => {
    e.stopPropagation();
    cfg.items.splice(idx, 1);
    if (cfg.track && cfg.track.pendingIdx >= cfg.items.length) cfg.track.pendingIdx = 0;
    cfg.onRerender();
  });
  block.appendChild(del);

  // Resize
  const resize = document.createElement('div');
  resize.className = 'roll-note-resize';
  resize.addEventListener('pointerdown', e => {
    e.stopPropagation(); e.preventDefault();
    resize.setPointerCapture(e.pointerId);
    const startX = e.clientX, startBts = item.beats;
    const onMove = ev => {
      item.beats = Math.max(0.125, startBts + (ev.clientX - startX) / BEAT_PX);
      block.style.width = Math.max(ROLL_ROW_H, item.beats * BEAT_PX) + 'px';
      seqAutoExtendLoop(item.start + item.beats);
    };
    const onUp = () => {
      resize.removeEventListener('pointermove', onMove);
      resize.removeEventListener('pointerup', onUp);
      if (SEQ.rollSnap) {
        item.beats = Math.max(SEQ.rollSnapVal, rollSnapBeat(item.beats));
        block.style.width = (item.beats * BEAT_PX) + 'px';
      }
      seqSave();
    };
    resize.addEventListener('pointermove', onMove);
    resize.addEventListener('pointerup', onUp);
  });
  block.appendChild(resize);

  // Drag (X = time, Y = pitch if cfg.yDrag)
  block.addEventListener('pointerdown', e => {
    if (e.target.closest('.roll-note-resize') || e.target.closest('.roll-note-del')) return;
    // Eraser tool: delete on click
    if (SEQ.rollTool === 'erase') {
      e.preventDefault();
      cfg.items.splice(idx, 1);
      if (cfg.track && cfg.track.pendingIdx >= cfg.items.length) cfg.track.pendingIdx = 0;
      cfg.onRerender();
      return;
    }
    e.preventDefault();
    block.setPointerCapture(e.pointerId);
    if (state.audioEnabled && !SEQ.playing) {
      // Use the owning track's instrument if we can resolve it from the lane.
      const laneEl = block.parentElement;
      const ot    = (laneEl && laneEl.dataset && laneEl.dataset.trackId && trackById(laneEl.dataset.trackId)) || null;
      const inst  = ot ? seqTrackInstrument(ot) : null;
      const synth = ot ? ot.synth : null;
      let previewNode;
      if (synth) withSynth(synth, () => { previewNode = startAudioNote(item.midi, state.velocity, null, null, inst); });
      else previewNode = startAudioNote(item.midi, state.velocity, null, null, inst);
      const stopPreview = () => previewNode && stopAudioNote(previewNode);
      block.addEventListener('pointerup',     stopPreview, { once: true });
      block.addEventListener('pointercancel', stopPreview, { once: true });
    }
    const startX = e.clientX, startY = e.clientY;
    const startBeat = item.start, startMidi = item.midi;
    let moved = false;
    const onMove = ev => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      moved = true;
      block.classList.add('moving');
      item.start = Math.max(0, startBeat + dx / BEAT_PX);
      if (cfg.yDrag) {
        const newMidi = Math.max(botMidi, Math.min(topMidi, startMidi - Math.round(dy / ROLL_ROW_H)));
        if (newMidi !== item.midi) { item.midi = newMidi; item.label = midiNoteLabel(newMidi); }
        block.style.top = (topMidi - item.midi) * ROLL_ROW_H + 'px';
      }
      block.style.left = (item.start * BEAT_PX) + 'px';
    };
    const onUp = () => {
      block.removeEventListener('pointermove', onMove);
      block.removeEventListener('pointerup', onUp);
      block.classList.remove('moving');
      if (moved) {
        if (SEQ.rollSnap) {
          item.start = Math.max(0, rollSnapBeat(item.start));
          block.style.left = (item.start * BEAT_PX) + 'px';
        }
        cfg.items.sort((a, b) => a.start - b.start);
        seqAutoExtendLoop(item.start + item.beats);
        cfg.onRerender();
      }
    };
    block.addEventListener('pointermove', onMove);
    block.addEventListener('pointerup', onUp);
  });

  return block;
}

function seqRenderMidiCollapsed(lane) {
  lane.innerHTML = '';
  lane.classList.remove('roll-mode');
  lane.onscroll = null;
  lane.style.padding = '';
  const items = firstTrackOfKind('free')?.items || [];
  if (items.length === 0) return;
  lane.style.minWidth = seqLaneWidth(items) + 'px';
  const intervals = items.map(i => [i.start, i.start + i.beats]).sort((a, b) => a[0] - b[0]);
  const merged = [[...intervals[0]]];
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1];
    if (intervals[i][0] <= last[1]) last[1] = Math.max(last[1], intervals[i][1]);
    else merged.push([...intervals[i]]);
  }
  merged.forEach(([s, e]) => {
    const block = document.createElement('div');
    block.className = 'seq-block';
    block.style.cssText = `left:${s * BEAT_PX}px;width:${(e - s) * BEAT_PX}px`;
    lane.appendChild(block);
  });
  seqRollAddLines(lane);
  seqUpdateLoopEnd();
}

function seqRenderMidi() {
  const lane = document.getElementById('seq-midi-lane');
  if (!lane) return;
  if (lane.classList.contains('track-collapsed')) {
    seqRenderMidiCollapsed(lane);
    syncTrackLabelHeights();
    seqSave();
    return;
  }
  const savedScroll = lane.scrollTop;
  lane.innerHTML = '';
  lane.style.padding = '';
  lane.classList.add('roll-mode');
  lane.onscroll = () => { updateRollOverflow(); updateKeyboardPosition(); };

  const ft = firstTrackOfKind('free');
  const items = ft?.items || [];
  lane.style.minWidth = items.length > 0 ? seqLaneWidth(items) + 'px' : '';
  rollBuildGrid(lane);
  if (SEQ.rollKeyboard) rollBuildKeyboard(lane);
  if (items.length > 0) {
    const midiCfg = { items, track: ft, onRerender: seqRenderMidi, activeIdx: ft?.activeIdx ?? -1, yDrag: true };
    items.forEach((item, idx) => lane.appendChild(seqMakeRollNote(item, idx, ROLL_TOP_MIDI, ROLL_BOT_MIDI, midiCfg)));
  }
  const ctr = items.length > 0 ? Math.round(items.reduce((s, i) => s + i.midi, 0) / items.length) : 66;
  lane.scrollTop = savedScroll || rollScrollForMidi(ctr);
  updateRollOverflow();
  updateKeyboardPosition();
  seqRollAddLines(lane);
  seqUpdateLoopEnd();
  syncTrackLabelHeights();
  seqRenderRuler();
  refreshLucide();
  seqRefreshSelectionVisuals();
  seqSave();
}

function seqHighlightMidi(idx) {
  const ft = firstTrackOfKind('free');
  if (ft) ft.activeIdx = idx;
  document.querySelectorAll('#seq-midi-lane .roll-note').forEach((b, i) => {
    b.classList.toggle('active', i === idx);
  });
}

function seqTick() {
  if (!SEQ.playing) return;
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  const bd  = seqBeatDur();
  const horizon = now + SEQ.LOOKAHEAD;
  for (const tr of SEQ.tracksList) {
    if (tr.kind === 'chord')      seqTickChordTrack(tr, now, bd, horizon);
    else if (tr.kind === 'free')  seqTickFreeTrack(tr, now, bd, horizon);
  }
  seqDebugTick(now, bd);
}

// ---- Debug HUD ------------------------------------------------------------
// Enable from DevTools: `SEQ.debug = true` (or `SEQ.debug = 'hud'` for the
// on-screen overlay too). Logs at most ~5×/sec while playing so the console
// stays readable. Reset throttle counter with SEQ._dbgT = 0.
SEQ.debug = false;
SEQ._dbgT = 0;
function seqDebugTick(now, bd) {
  if (!SEQ.debug) return;
  if (SEQ._dbgT && now - SEQ._dbgT < 0.2) return;
  SEQ._dbgT = now;
  const snap = {
    t:         +now.toFixed(3),
    bd:        +bd.toFixed(4),
    animBeat:  +(SEQ.animBeat || 0).toFixed(3),
    cycleStart:+(firstTrackOfKind('chord')?.cycleStart ?? 0).toFixed(3),
    loop:      SEQ.loop,
    loopStart: SEQ.loopStart,
    loopEnd:   SEQ.loopEnd,
    tracks:    SEQ.tracksList.map(tr => ({
      name:    tr.name,
      kind:    tr.kind,
      pIdx:    tr.pendingIdx,
      pTime:   tr.pendingTime === Infinity ? 'inf' : +tr.pendingTime.toFixed(3),
      pDelta:  tr.pendingTime === Infinity ? 'inf' : +(tr.pendingTime - now).toFixed(3),
      cStart:  +(tr.cycleStart ?? 0).toFixed(3),
    })),
  };
  console.log('[SEQ]', snap);
  if (SEQ.debug === 'hud') seqDebugRenderHUD(snap);
}
function seqDebugRenderHUD(s) {
  let hud = document.getElementById('seq-debug-hud');
  if (!hud) {
    hud = document.createElement('pre');
    hud.id = 'seq-debug-hud';
    hud.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99999;background:rgba(0,0,0,0.78);color:#9f7;font:10px/1.3 monospace;padding:8px 10px;border:1px solid #333;border-radius:4px;pointer-events:none;max-width:340px;';
    document.body.appendChild(hud);
  }
  hud.textContent = JSON.stringify(s, null, 2);
}

// Per-track scheduled-events tracking. Each entry describes a single
// note (or chord, for chord-tracks): when it starts, when it ends, the
// AudioBufferSource nodes (if instrument output) and the MIDI port +
// midi numbers (if MIDI output). seqResyncTrack walks this list and
// selectively cancels only events whose `startAt` is still in the
// future, leaving currently-playing ones untouched. Stops the "soft
// note" double-fire that used to happen on mid-play mutations.
function _seqRecordEvent(track, event) {
  if (!track._scheduled) track._scheduled = [];
  track._scheduled.push(event);
}
function _seqCancelFuture(track, now) {
  if (!track._scheduled || track._scheduled.length === 0) return;
  const kept = [];
  for (const ev of track._scheduled) {
    if (ev.endAt <= now) continue;            // finished — drop
    if (ev.startAt > now + 0.001) {           // future — cancel
      // Audio: stop scheduled BufferSource before it starts (no sound).
      if (ev.audioNodes) {
        for (const node of ev.audioNodes) {
          try { node.stop(now); } catch (_) {}
          SEQ.activeNodes?.delete(node);
        }
      }
      // MIDI: the note-on already sits in the OS driver queue with a
      // future timestamp — we can't unqueue it. Send a note-off at the
      // same timestamp + 1 ms so the driver fires noteOn → noteOff
      // back-to-back; effectively inaudible (< 1 ms note).
      if (ev.port && ev.midiNotes) {
        const cancelTs = audioTimeToMidiTs(ev.startAt + 0.001);
        for (const m of ev.midiNotes) sendNoteOff(m, ev.channel, ev.port, cancelTs);
      }
      continue;
    }
    kept.push(ev);                            // currently playing — keep
  }
  track._scheduled = kept;
}

function seqTickChordTrack(track, now, bd, horizon) {
  while (track.items.length > 0 && track.pendingTime < horizon) {
    const item = track.items[track.pendingIdx];
    const t    = track.cycleStart + (item.start - seqLoopOffset()) * bd;
    const dur  = item.beats * bd;
    const onDelay  = Math.max(0, (t - now) * 1000);
    const offDelay = Math.max(0, (t + dur * 0.95 - now) * 1000);
    const shift    = item.semitoneShift || 0;
    const itemOct  = item.octave !== undefined ? item.octave : state.octave;
    const notes    = chordToMidiNotes(item.keyRoot, itemOct, item.interval, item.q, item.voicing).map(n => Math.max(0, Math.min(127, n + shift)));
    const bassInt  = item.bassInterval !== undefined ? item.bassInterval : item.interval;
    // Per-clip overrides for the bass layer. `bassEnabled` and
    // `bassOctave` on the item win over the global state when set.
    const bassEnabled = item.bassEnabled ?? state.bassEnabled;
    const bassOct     = item.bassOctave  ?? state.bassOctave;
    const bassNote    = bassEnabled ? (bassOct + 1) * 12 + (item.keyRoot + bassInt) % 12 : null;

    const audible   = seqTrackAudible(track);
    const vel       = seqTrackVel(track, state.velocity);
    const inst      = seqTrackInstrument(track);

    const useInstrument = track.output !== 'midi';
    const useMidi       = track.output === 'midi';
    const capturedNotes = [...notes], capturedBass = bassNote;
    const trkPort = useMidi ? midiPortById(track.midiPortId) : null;
    // Event record for selective cancellation on mutation. Populated
    // below as we schedule audio + MIDI.
    const event = {
      startAt: t,
      endAt: t + dur * 0.95,
      audioNodes: null,
      port: useMidi && audible ? trkPort : null,
      channel: track.channel,
      midiNotes: useMidi && audible ? (capturedBass !== null ? [...capturedNotes, capturedBass] : capturedNotes) : null,
    };
    if (useInstrument && state.audioEnabled && audible) {
      const fire = () => {
        const audioNodes = notes.map((n, i) => startAudioNote(n, vel, t + i * 0.002, null, inst));
        audioNodes.forEach(n => SEQ.activeNodes.add(n));
        seqTimeout(() => audioNodes.forEach(n => { stopAudioNote(n); SEQ.activeNodes.delete(n); }), offDelay);
        if (bassNote !== null) {
          const bassNode = startBassNote(bassNote, t, null, inst);
          SEQ.activeNodes.add(bassNode);
          audioNodes.push(bassNode);
          seqTimeout(() => { stopAudioNote(bassNode); SEQ.activeNodes.delete(bassNode); }, offDelay);
        }
        event.audioNodes = audioNodes;
      };
      withSynth(track.synth, fire);
    }
    // Schedule MIDI directly via port.send timestamps — sample-precise, no
    // setTimeout jitter. Display updates still go through seqTimeout so
    // they only run at "now" time (not preemptively).
    if (useMidi && audible && trkPort) {
      const onTs  = audioTimeToMidiTs(t);
      const offTs = audioTimeToMidiTs(t + dur * 0.95);
      capturedNotes.forEach(n => sendNoteOn(n, vel, track.channel, trkPort, onTs));
      if (capturedBass !== null) sendNoteOn(capturedBass, vel, track.channel, trkPort, onTs);
      capturedNotes.forEach(n => sendNoteOff(n, track.channel, trkPort, offTs));
      if (capturedBass !== null) sendNoteOff(capturedBass, track.channel, trkPort, offTs);
    }
    _seqRecordEvent(track, event);
    seqTimeout(() => {
      SEQ.nowChord = chordDisplayName(item.keyRoot, item.interval, item.q) + ' [' + capturedNotes.map(midiNoteName).join(' · ') + ']';
      seqUpdateNowPlaying();
    }, onDelay);
    seqTimeout(() => {
      SEQ.nowChord = '';
      seqUpdateNowPlaying();
    }, offDelay);

    if (track.id === 'tr-default-chord') {
      const capturedIdx = track.pendingIdx;
      seqTimeout(() => seqHighlight(capturedIdx), onDelay);
      seqTimeout(() => { if (track.activeIdx === capturedIdx) seqHighlight(-1); }, offDelay);
    }

    track.pendingIdx++;
    seqAdvanceTrackPending(track, bd);
  }
}

// Compute a flat sorted list of {midi, label, beats, start} from all
// clips' notes, with absolute start = clip.start + note.start. Cached
// on the track and invalidated when items change.
function freeTrackFlatNotes(track) {
  if (!track._flatNotes || track._flatDirty) {
    const out = [];
    for (const clip of track.items) {
      const clipEnd = clip.beats;
      for (const note of clip.notes) {
        // Skip notes that start outside the clip — they wouldn't trigger.
        if (note.start >= clipEnd) continue;
        // Truncate note duration at clip end (Ableton/Cubase/Logic default).
        // Non-destructive: the underlying note.beats is unchanged; only the
        // playback-effective beats is clipped.
        const effBeats = Math.min(note.beats, clipEnd - note.start);
        if (effBeats <= 0) continue;
        out.push({
          midi: note.midi,
          label: note.label || midiNoteLabel(note.midi),
          beats: effBeats,
          start: clip.start + note.start,
          velocity: note.velocity,
        });
      }
    }
    out.sort((a, b) => a.start - b.start);
    track._flatNotes = out;
    track._flatDirty = false;
  }
  return track._flatNotes;
}
function invalidateFreeTrackFlat(track) { if (track) track._flatDirty = true; }

function seqTickFreeTrack(track, now, bd, horizon) {
  const notes = freeTrackFlatNotes(track);
  while (notes.length > 0 && track.pendingTime < horizon) {
    const item = notes[track.pendingIdx];
    if (!item) break;
    const t    = track.cycleStart + (item.start - seqLoopOffset()) * bd;
    const dur  = item.beats * bd;
    const onDelay  = Math.max(0, (t - now) * 1000);
    const offDelay = Math.max(0, (t + dur * 0.95 - now) * 1000);
    const audible  = seqTrackAudible(track);
    // Per-note velocity overrides the track's, but still get scaled by
    // the track's mute/solo gain via seqTrackVel.
    const baseVel  = (typeof item.velocity === 'number') ? item.velocity : state.velocity;
    const vel      = seqTrackVel(track, baseVel);
    const inst     = seqTrackInstrument(track);
    const useInstrument = track.output !== 'midi';
    const useMidi       = track.output === 'midi';
    const capturedMidi = item.midi, capturedLabel = item.label;
    const trkPort = useMidi ? midiPortById(track.midiPortId) : null;
    const event = {
      startAt: t,
      endAt: t + dur * 0.95,
      audioNodes: null,
      port: useMidi && audible ? trkPort : null,
      channel: track.channel,
      midiNotes: useMidi && audible ? [capturedMidi] : null,
    };
    if (useInstrument && state.audioEnabled && audible) {
      withSynth(track.synth, () => {
        const node = startAudioNote(item.midi, vel, t, null, inst);
        SEQ.activeNodes.add(node);
        event.audioNodes = [node];
        seqTimeout(() => { stopAudioNote(node); SEQ.activeNodes.delete(node); }, offDelay);
      });
    }
    if (useMidi && audible && trkPort) {
      const onTs  = audioTimeToMidiTs(t);
      const offTs = audioTimeToMidiTs(t + dur * 0.95);
      sendNoteOn(capturedMidi, vel, track.channel, trkPort, onTs);
      sendNoteOff(capturedMidi, track.channel, trkPort, offTs);
    }
    _seqRecordEvent(track, event);
    seqTimeout(() => {
      SEQ.nowNote = capturedLabel;
      seqUpdateNowPlaying();
    }, onDelay);
    seqTimeout(() => {
      SEQ.nowNote = '';
      seqUpdateNowPlaying();
    }, offDelay);

    track.pendingIdx++;
    seqAdvanceTrackPendingFlat(track, notes, bd);
  }
}

function seqAdvanceTrackPendingFlat(track, notes, bd) {
  const nextIdx = seqFindNextInRange(notes, track.pendingIdx);
  if (nextIdx < 0) {
    if (SEQ.loop) {
      track.cycleStart += seqTotalDur();
      const fi = seqFindNextInRange(notes, 0);
      track.pendingIdx  = fi >= 0 ? fi : 0;
      track.pendingTime = fi >= 0 ? track.cycleStart + (notes[fi].start - SEQ.loopStart) * bd : Infinity;
    } else {
      track.pendingTime = Infinity;
    }
  } else {
    track.pendingIdx  = nextIdx;
    track.pendingTime = track.cycleStart + (notes[nextIdx].start - seqLoopOffset()) * bd;
  }
}

// Advance a track's pendingIdx / pendingTime past the end (or to the next
// looped iteration). Shared by chord and free track tickers.
function seqAdvanceTrackPending(track, bd) {
  const nextIdx = seqFindNextInRange(track.items, track.pendingIdx);
  if (nextIdx < 0) {
    if (SEQ.loop) {
      track.cycleStart += seqTotalDur();
      const fi = seqFindNextInRange(track.items, 0);
      track.pendingIdx  = fi >= 0 ? fi : 0;
      track.pendingTime = fi >= 0 ? track.cycleStart + (track.items[fi].start - SEQ.loopStart) * bd : Infinity;
    } else {
      track.pendingTime = Infinity;
    }
  } else {
    track.pendingIdx  = nextIdx;
    track.pendingTime = track.cycleStart + (track.items[nextIdx].start - seqLoopOffset()) * bd;
  }
}



// Generic per-track resync: recomputes pendingIdx / pendingTime / cycleStart
// so the next note plays at the right time relative to the current clock.
// For free tracks, indexing is over the flattened note list rather than clips.
function seqResyncTrack(track, opts) {
  if (!SEQ.playing || !track) return;
  invalidateFreeTrackFlat(track);
  // jumpInto: include items that started before `now` but haven't
  // ended yet — set by seqJumpToBeat so a cursor jump INTO a clip
  // fires it (clamped to 0). For every other path (edits, drops,
  // drags, resizes) we only schedule items whose start is still
  // ahead — touching a note/clip during playback never produces a
  // mid-way attack.
  const jumpInto = !!(opts && opts.jumpInto);
  const ctxNow = getAudioCtx().currentTime;
  // Cancel any events that haven't started yet for this track so we
  // don't double-fire when the upcoming tick reschedules. Currently-
  // playing events are kept (their note-on already happened — we let
  // them ring out so the user doesn't hear them clipped).
  _seqCancelFuture(track, ctxNow);
  const list = track.kind === 'free' ? freeTrackFlatNotes(track) : track.items;
  if (list.length === 0) return;
  const bd    = seqBeatDur();
  const tRef  = SEQ.playStartTime + 0.05;
  const total = seqTotalDur();
  const now   = ctxNow;
  const ls    = seqLoopOffset();
  const cycleNum   = SEQ.loop ? Math.max(0, Math.floor((now - tRef) / total)) : 0;
  const cycleStart = tRef + cycleNum * total;
  for (let i = 0; i < list.length; i++) {
    if (!seqItemInRange(list[i])) continue;
    const t = cycleStart + (list[i].start - ls) * bd;
    const itemBeats = list[i].beats || 0;
    const match = jumpInto
      ? (t + itemBeats * bd > now)
      : (t > now);
    if (match) {
      track.cycleStart  = cycleStart;
      track.pendingIdx  = i;
      track.pendingTime = t;
      seqResyncAnimLoop();
      return;
    }
  }
  if (!SEQ.loop) { track.pendingTime = Infinity; return; }
  const next = cycleStart + total;
  const fi = seqFindNextInRange(list, 0);
  track.cycleStart  = next;
  track.pendingIdx  = fi >= 0 ? fi : 0;
  track.pendingTime = fi >= 0 ? next + (list[fi].start - SEQ.loopStart) * bd : Infinity;
  seqResyncAnimLoop();
}

function seqResyncAll(opts) { for (const t of SEQ.tracksList) seqResyncTrack(t, opts); }
// Re-anchor playStartTime so that the current visual beat (SEQ.animBeat) maps
// exactly to the current audio time under the *current* tempo + loop bounds.
// Without this, any change to tempo or loop-bounds mid-play makes the
// scheduler's `(now - playStartTime) / total` math compute a wrong cycleNum,
// causing notes to fire at the wrong moments.
function seqReanchorPlayStart() {
  if (!SEQ.playing) return;
  const ctx  = getAudioCtx();
  const bd   = seqBeatDur();
  const lo   = SEQ.loopStart;
  const hi   = SEQ.loopEnd;
  // SEQ.animBeat is the latency-compensated VISUAL position — anchoring
  // the scheduler to it puts the next note's audio time one outputLatency
  // behind the actual beat grid. Each re-anchor (loop-extend, jump,
  // tempo change) compounded the shift, so audio attacks drifted behind
  // the playhead the more you edited mid-play. Add lat/bd back to get
  // the SCHEDULER-time beat that corresponds to ctx.currentTime.
  const lat = (ctx.outputLatency ?? ctx.baseLatency ?? 0) + (SEQ.visualLatencyMs || 0) / 1000;
  const visualBeat    = SEQ.animBeat || lo;
  const schedulerBeat = visualBeat + lat / bd;
  const beat = Math.max(lo, Math.min(hi - 0.001, schedulerBeat));
  SEQ.playStartTime = ctx.currentTime - (beat - lo) * bd - 0.05;
  // Re-anchor each track's per-loop cycleStart so the scheduler picks up
  // the new origin on the next tick.
  for (const tr of SEQ.tracksList) tr.cycleStart = SEQ.playStartTime + 0.05;
}
// Throttled resync — call freely from pointermove handlers; only does the
// expensive seqResyncTrack work every ~80ms per track, so playback follows
// drag/resize edits without 60Hz reschedule churn.
function seqResyncTrackThrottled(track, opts) {
  if (!track || !SEQ.playing) return;
  // ALWAYS invalidate the flat-notes cache — it's cheap (sets a flag)
  // and otherwise the scheduler's 25 ms ticks between throttled resyncs
  // would schedule the next note from STALE note positions, audibly
  // running behind the visual playhead during a drag.
  invalidateFreeTrackFlat(track);
  const now = performance.now();
  if (track._lastResyncT && now - track._lastResyncT < 80) return;
  track._lastResyncT = now;
  seqResyncTrack(track, opts);
}
// Call when something that affects the global time-base changed (loop bounds,
// tempo): re-anchor, kill stale scheduled timers, then reschedule all tracks.
function seqLoopBaseChangedResync(opts) {
  if (!SEQ.playing) return;
  seqReanchorPlayStart();
  for (const t of SEQ.tracksList) invalidateFreeTrackFlat(t);
  SEQ.pendingTimers.forEach(id => clearTimeout(id));
  SEQ.pendingTimers.clear();
  seqResyncAll(opts);
  // Metronome state is tied to loop bounds + tempo, so reset it on any
  // base-change so accents land at the right beats from now on.
  metroHalt();
  metroRunSynced();
}
function seqResyncAllThrottled() {
  if (!SEQ.playing) return;
  const now = performance.now();
  if (SEQ._lastResyncAllT && now - SEQ._lastResyncAllT < 80) return;
  SEQ._lastResyncAllT = now;
  // Re-anchor first so the new loop-bounds / tempo math doesn't trip up
  // seqResyncTrack's cycleNum computation.
  seqReanchorPlayStart();
  for (const t of SEQ.tracksList) invalidateFreeTrackFlat(t);
  // Stop any currently-scheduled timers/nodes — they were scheduled under
  // the previous loop bounds and would otherwise double-fire after reanchor.
  SEQ.pendingTimers.forEach(id => clearTimeout(id));
  SEQ.pendingTimers.clear();
  seqResyncAll();
}

function seqResyncChords() { seqResyncTrack(firstTrackOfKind('chord')); }


function seqResyncMidi() { seqResyncTrack(firstTrackOfKind('free')); }

function seqInitPlay(t0) {
  const bd  = seqBeatDur();
  const ls  = seqLoopOffset();
  // Honour a user-set playhead position from clicking on the ruler. Clamped
  // to the loop range so we never start outside it.
  const wantStart = (typeof SEQ.startBeat === 'number')
    ? Math.max(SEQ.loopStart, Math.min(SEQ.loopEnd - 0.001, SEQ.startBeat))
    : SEQ.loopStart;
  SEQ.playing        = true;
  SEQ.playStartTime  = t0 - 0.05;
  SEQ.animBeat      = wantStart;
  SEQ.animLastTime  = t0;
  SEQ.animLoopLen   = SEQ.loopEnd - SEQ.loopStart;
  SEQ.animLoopStart = SEQ.loopStart;
  const offsetFromStart = wantStart - SEQ.loopStart;
  // Initialize each track's playback cursor independently.
  for (const tr of SEQ.tracksList) {
    invalidateFreeTrackFlat(tr);
    const list = tr.kind === 'free' ? freeTrackFlatNotes(tr) : tr.items;
    // Find the first item whose start is at-or-after the requested
    // starting beat (clamped to the loop range when looping). Without
    // this, seqFindNextInRange(list, 0) would point at item index 0,
    // and any items before wantStart would fire at t0 (all at once).
    let fi = -1;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (SEQ.loop && (it.start < SEQ.loopStart || it.start >= SEQ.loopEnd)) continue;
      if (it.start >= wantStart) { fi = i; break; }
    }
    tr.cycleStart  = t0 - offsetFromStart * bd;
    tr.pendingIdx  = fi >= 0 ? fi : 0;
    tr.pendingTime = fi >= 0 ? t0 + (list[fi].start - ls - offsetFromStart) * bd : Infinity;
    tr.activeIdx   = -1;
  }
  if (!SEQ.timer) SEQ.timer = setInterval(seqTick, SEQ.TICK_MS);
  document.querySelectorAll('.seq-playhead').forEach(ph => {
    // The roll's playhead is positioned by seqAnimatePlayhead with the
    // clip-relative formula. Skip it here to avoid a flash at left=0.
    if (ph.closest('#seq-pianoroll-body')) return;
    ph.style.display = 'block';
  });
  if (SEQ.rafId) cancelAnimationFrame(SEQ.rafId);
  SEQ.rafId = requestAnimationFrame(seqAnimatePlayhead);
  document.getElementById('seq-play-btn')?.classList.add('active');
}

function startPrecount(onDone) {
  const ctx  = getAudioCtx();
  const bd   = seqBeatDur();
  const tRef = ctx.currentTime + 0.05;
  const savedEnabled = METRO.enabled;
  METRO.enabled = true;
  metroRun(tRef, SEQ.loopStart);
  const beatSpan = document.getElementById('seq-rec-beat');

  function tick() {
    if (!SEQ.playing) {
      beatSpan.textContent = '';
      METRO.enabled = savedEnabled;
      if (!METRO.enabled) metroHalt();
      return;
    }
    const elapsed = getAudioCtx().currentTime - tRef;
    const beatNum = Math.floor(elapsed / bd);
    if (beatNum >= state.beatsPerBar) {
      beatSpan.textContent = '';
      METRO.enabled = savedEnabled;
      if (!METRO.enabled) metroHalt();
      onDone(getAudioCtx().currentTime + 0.05);
      return;
    }
    beatSpan.textContent = state.beatsPerBar - beatNum;
    REC._precountRaf = requestAnimationFrame(tick);
  }
  REC._precountRaf = requestAnimationFrame(tick);

  // mark play btn immediately so Stop works during precount
  document.getElementById('seq-play-btn')?.classList.add('active');
  SEQ.playing = true;
}

// Jump the play-cursor to a specific song-absolute beat. Updates the
// SEQ.startBeat/animBeat anchors and re-positions every visible playhead
// (arrangement, ruler, piano-roll). If playback is running, also
// re-anchors the audio scheduler so the next tick fires from there.
function seqJumpToBeat(beat) {
  const b = Math.max(0, beat);
  SEQ.startBeat = b;
  SEQ.animBeat  = b;
  // While playing, hard-cut every in-flight note. stopAudioNote does a
  // 0.5 s release envelope which is too soft for a cursor jump — the
  // listener still hears the old position fading for half a second.
  // Stop oscillators directly + send MIDI all-notes-off for every port
  // used by a track.
  if (SEQ.playing) {
    const ctx0 = getAudioCtx();
    SEQ.activeNodes?.forEach(node => {
      try { node.oscs?.forEach(o => o.stop(ctx0.currentTime)); } catch (_) {}
    });
    SEQ.activeNodes?.clear?.();
    // MIDI: send all-notes-off on every port any track might be using.
    if (state.midiAccess) {
      const ports = new Set();
      if (state.output) ports.add(state.output);
      for (const t of SEQ.tracksList) {
        if (t.midiPortId) {
          const p = state.midiAccess.outputs.get(t.midiPortId);
          if (p) ports.add(p);
        }
      }
      ports.forEach(p => {
        for (let ch = 0; ch < 16; ch++) {
          try { p.send([0xB0 | ch, 123, 0]); } catch (_) {}
        }
      });
    }
    // NOTE: do NOT null `tr._scheduled` here. seqResyncTrack (called
    // below via seqLoopBaseChangedResync) calls _seqCancelFuture which
    // walks the existing ledger to send note-off at the same timestamp
    // for any future-queued MIDI note-ons (you can't unqueue them from
    // the OS driver). Nulling first means those queued notes still fire
    // at their original times — which is the "50 notes at once" bug.
  }
  if (typeof resetChordViewLoopIter === 'function') resetChordViewLoopIter();
  // Arrangement playheads (full-height ones + per-lane ones).
  document.querySelectorAll('.seq-playhead-global, .seq-lane .seq-playhead').forEach(ph => {
    ph.style.display = 'block';
    ph.style.left = (b * BEAT_PX) + 'px';
  });
  // Piano-roll playhead is clip-relative + keyboard offset; only update
  // if the focused clip overlaps the jump target.
  const prBody = document.getElementById('seq-pianoroll-body');
  const prPh   = prBody?.querySelector('.seq-playhead');
  if (prPh && typeof focusedClipObjects === 'function') {
    const { clip } = focusedClipObjects();
    if (clip && b >= clip.start && b <= clip.start + clip.beats) {
      prPh.style.display = 'block';
      prPh.style.left = ((b - clip.start) * PR_BEAT_PX + prKbW()) + 'px';
    } else if (prPh) {
      prPh.style.display = 'none';
    }
  }
  // Full re-anchor + every-track resync, otherwise per-track pendingIdx
  // and pendingTime still reference the OLD anchor — visual jumps but
  // audio keeps ticking from where it was. seqLoopBaseChangedResync
  // does the reanchor, clears pending timers, and reschedules each
  // track from the new beat.
  if (SEQ.playing) seqLoopBaseChangedResync({ jumpInto: true });
  // Bring the new play position into view. Always (independent of the
  // follow-cursor toggle) so clicking a nav button feels responsive —
  // if the target is already on-screen we leave the scroll alone.
  const wrap = document.getElementById('seq-lane-wrap');
  if (wrap) {
    const px = b * BEAT_PX;
    if (px < wrap.scrollLeft + 20 || px > wrap.scrollLeft + wrap.clientWidth - 20) {
      wrap.scrollLeft = Math.max(0, px - wrap.clientWidth * 0.25);
    }
  }
  if (prBody) {
    const { clip } = (typeof focusedClipObjects === 'function') ? focusedClipObjects() : {};
    if (clip && b >= clip.start && b <= clip.start + clip.beats) {
      const phX = (b - clip.start) * PR_BEAT_PX + prKbW();
      if (phX < prBody.scrollLeft + 20 || phX > prBody.scrollLeft + prBody.clientWidth - 20) {
        prBody.scrollLeft = Math.max(0, phX - prBody.clientWidth * 0.25);
      }
    }
  }
}

// Maximum song-end beat across all tracks. Empty project → 0.
function seqProjectEndBeat() {
  let end = 0;
  for (const t of SEQ.tracksList) {
    for (const it of t.items) {
      end = Math.max(end, (it.start || 0) + (it.beats || 1));
    }
  }
  return end;
}

// Start / end of the current selection. Prefers piano-roll note
// selection if the roll is open and has notes selected; falls back to
// the arrangement clip-level selection. Returns null when nothing is
// selected.
function seqSelectionRange() {
  if (SEQ.pianoRollOpen && SEQ.prSelection && SEQ.prSelection.size > 0 && typeof focusedClipObjects === 'function') {
    const { clip } = focusedClipObjects();
    if (clip) {
      const notes = clip.notes.filter(n => SEQ.prSelection.has(n));
      if (notes.length) {
        const start = clip.start + Math.min(...notes.map(n => n.start));
        const end   = clip.start + Math.max(...notes.map(n => n.start + n.beats));
        return { start, end };
      }
    }
  }
  if (SEQ.selection.length > 0) {
    const items = SEQ.selection.map(s => s.item);
    const start = Math.min(...items.map(i => i.start || 0));
    const end   = Math.max(...items.map(i => (i.start || 0) + (i.beats || 1)));
    return { start, end };
  }
  return null;
}

function seqJumpTrackStart() { seqJumpToBeat(0); }
function seqJumpTrackEnd()   { seqJumpToBeat(seqProjectEndBeat()); }
function seqJumpSelStart()   { const r = seqSelectionRange(); if (r) seqJumpToBeat(r.start); }
function seqJumpSelEnd()     { const r = seqSelectionRange(); if (r) seqJumpToBeat(r.end); }
function seqJumpLoopStart()  { seqJumpToBeat(SEQ.loopStart || 0); }
function seqJumpLoopEnd()    { seqJumpToBeat(SEQ.loopEnd   || 0); }

function seqPlay(leadSec) {
  const ctx = getAudioCtx();
  // Default lead-in of 50 ms gives the scheduler safety margin. MIDI-clock
  // syncing passes a much smaller lead (~5 ms) so we line up with the
  // external master's beat 1 rather than trailing it by 50 ms.
  const lead = typeof leadSec === 'number' ? leadSec : 0.05;
  const t0   = ctx.currentTime + lead;

  if (REC.armed && PRECOUNT.enabled) {
    startPrecount((t0actual) => {
      if (!SEQ.playing) return;
      seqInitPlay(t0actual);
      recActivate(t0actual);
    });
    return;
  }

  seqInitPlay(t0);
  metroRun(t0, SEQ.animBeat ?? SEQ.loopStart);
  if (REC.armed) recActivate(t0);
  // Don't wait for the next 25ms tick — schedule anything inside the LOOKAHEAD
  // window right now so beat 0 actually fires close to t0.
  seqTick();
}

function seqStop() {
  // Snap the play-cursor (SEQ.startBeat) to wherever playback currently
  // is, so Stop "freezes in place" rather than rewinding to the spot
  // where Play was last pressed. Next Play resumes from here.
  if (typeof SEQ.animBeat === 'number') SEQ.startBeat = SEQ.animBeat;
  SEQ.playing = false;
  // Reset every track's active highlight so on next play the playhead
  // starts from a clean state. Also drop any in-flight scheduled-event
  // records — the global pendingTimers + activeNodes are cleared below
  // and panic() takes care of MIDI all-notes-off, so the per-track
  // tracker would only carry stale references after this point.
  for (const tr of SEQ.tracksList) {
    tr.activeIdx = -1;
    tr._scheduled = null;
  }
  if (typeof resetChordViewLoopIter === 'function') resetChordViewLoopIter();
  SEQ.nowChord = '';
  SEQ.nowNote  = '';
  SEQ.pendingTimers.forEach(id => clearTimeout(id));
  SEQ.pendingTimers.clear();
  SEQ.activeNodes.forEach(n => stopAudioNote(n));
  SEQ.activeNodes.clear();
  panic();
  if (SEQ.rafId) { cancelAnimationFrame(SEQ.rafId); SEQ.rafId = null; }
  if (typeof SEQ.startBeat === 'number') {
    document.querySelectorAll('.seq-playhead').forEach(ph => {
      // The roll-body playhead lives in a clip-relative coordinate system
      // (PR_BEAT_PX + keyboard offset, clip.start subtracted). Skip it here
      // — seqAnimatePlayhead positions it correctly on the next play, and
      // when stopped it should just hide so it doesn't appear as a stray
      // vertical line at left=0.
      if (ph.closest('#seq-pianoroll-body')) { ph.style.display = 'none'; return; }
      ph.style.display = 'block';
      ph.style.left = (SEQ.startBeat * BEAT_PX) + 'px';
    });
  } else {
    document.querySelectorAll('.seq-playhead').forEach(ph => ph.style.display = 'none');
  }
  document.querySelectorAll('.roll-row-active').forEach(r => r.classList.remove('roll-row-active'));
  const _cL = document.getElementById('seq-lane');
  const _mL = document.getElementById('seq-midi-lane');
  const _chordItems = firstTrackOfKind('chord')?.items || [];
  const _freeItems  = firstTrackOfKind('free')?.items  || [];
  if (_cL) _cL.style.minWidth = _chordItems.length > 0 ? seqLaneWidth(_chordItems) + 'px' : '';
  if (_mL) _mL.style.minWidth = _freeItems.length  > 0 ? seqLaneWidth(_freeItems) + 'px' : '';
  // Keep the current horizontal scroll — stop freezes in place rather
  // than rewinding, so jumping the viewport back to 0 would be jarring.
  document.querySelectorAll('.seq-drop-hint').forEach(h => { h.style.left = ''; });
  if (SEQ.timer) { clearInterval(SEQ.timer); SEQ.timer = null; }
  if (REC.active) recStop();
  if (!REC.active) metroHalt();
  document.querySelectorAll('.seq-block').forEach(b => b.classList.remove('active'));
  const npn = document.getElementById('now-playing-notes');
  if (npn) npn.textContent = '—';
  document.getElementById('seq-play-btn')?.classList.remove('active');
}

function seqIsOpen() {
  return !document.getElementById('seq-panel').classList.contains('collapsed');
}

function seqChordDragImage(label, beats = 4) {
  const w = beats * BEAT_PX;
  const h = 44;
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:-9999px;top:-9999px;width:${w}px;height:${h}px;`
    + `display:flex;align-items:center;justify-content:center;`
    + `background:#2a2b2e;border:1px solid rgba(255,255,255,0.15);border-radius:5px;`
    + `color:var(--text);font-size:13px;font-weight:500;box-sizing:border-box;padding:4px 10px;`
    + `pointer-events:none;`;
  el.innerHTML = label;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 0);
  return { el, h };
}

function seqSetGhost(lane, beat, beats) {
  let g = lane.querySelector('.seq-ghost');
  if (!g) { g = document.createElement('div'); g.className = 'seq-ghost'; lane.appendChild(g); }
  g.style.left  = (beat * BEAT_PX) + 'px';
  g.style.width = (beats * BEAT_PX) + 'px';
  g.innerHTML   = SEQ._dragLabel || '';
}
function seqClearGhost(lane) { lane.querySelector('.seq-ghost')?.remove(); }

function seqSetRollGhost(lane, beat, beats, midiNotes) {
  seqClearRollGhost(lane);
  midiNotes.forEach(midi => {
    if (midi < ROLL_BOT_MIDI || midi > ROLL_TOP_MIDI) return;
    const g = document.createElement('div');
    g.className = 'roll-note roll-note-ghost roll-ghost-chord';
    g.style.left   = (beat * BEAT_PX) + 'px';
    g.style.top    = (ROLL_TOP_MIDI - midi) * ROLL_ROW_H + 'px';
    g.style.width  = (beats * BEAT_PX) + 'px';
    g.style.height = (ROLL_ROW_H - 1) + 'px';
    lane.appendChild(g);
  });
}
function seqClearRollGhost(lane) { lane.querySelectorAll('.roll-ghost-chord').forEach(el => el.remove()); }

function chordNotesAtY(lane, clientY, interval, q) {
  const rect = lane.getBoundingClientRect();
  const relY = clientY - rect.top + lane.scrollTop;
  const targetMidi = Math.max(ROLL_BOT_MIDI, Math.min(ROLL_TOP_MIDI, ROLL_TOP_MIDI - Math.floor(relY / ROLL_ROW_H)));
  const base = chordToMidiNotes(state.keys[state.currentTemplate], state.octave, interval, q);
  const avg  = base.reduce((a, b) => a + b, 0) / base.length;
  const oct  = Math.round((targetMidi - avg) / 12);
  return base.map(m => m + oct * 12).filter(m => m >= ROLL_BOT_MIDI && m <= ROLL_TOP_MIDI);
}

function seqStartTouchDrag(touch, _legacyLaneId, getData, onCancelPlay) {
    const tid = touch.identifier;
    const startX = touch.clientX, startY = touch.clientY;
    let dragging = false;
    let ghost = null;
    let lastTouch = touch;
    let scrollRaf = null;
    let prGhostNotes = [];

    const clearPrGhost = () => { prGhostNotes.forEach(g => g.remove()); prGhostNotes = []; };
    const stopScroll  = () => { if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = null; } };

    // Hit-test the finger against every track lane plus the piano-roll body.
    // Returns { kind: 'lane'|'pr', el, rect, track? } or null.
    const hitTest = (cx, cy) => {
      const prBody = document.getElementById('seq-pianoroll-body');
      if (prBody && prBody.offsetParent !== null) {
        const r = prBody.getBoundingClientRect();
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
          return { kind: 'pr', el: prBody, rect: r };
        }
      }
      const lanes = document.querySelectorAll('.seq-lane[data-track-id]');
      for (const lane of lanes) {
        if (lane.offsetParent === null) continue;
        const r = lane.getBoundingClientRect();
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
          const track = trackById(lane.dataset.trackId);
          if (!track) continue;
          return { kind: 'lane', el: lane, rect: r, track };
        }
      }
      return null;
    };

    const autoScroll = () => {
      if (!dragging) return;
      const edge = 80, maxSpeed = 12;
      const y = lastTouch.clientY, vh = window.innerHeight;
      let speed = 0;
      if (y < edge)           speed = -maxSpeed * (1 - y / edge);
      else if (y > vh - edge) speed =  maxSpeed * (1 - (vh - y) / edge);
      if (speed !== 0) window.scrollBy(0, speed);

      // Auto-scroll the piano-roll body vertically AND horizontally when the
      // finger is over it near an edge — lets you drop chords on notes that
      // are outside the visible roll viewport.
      const prBody = document.getElementById('seq-pianoroll-body');
      if (prBody && prBody.offsetParent !== null) {
        const r = prBody.getBoundingClientRect();
        if (lastTouch.clientX >= r.left && lastTouch.clientX <= r.right) {
          const edge2 = 40, maxSpeed2 = 4;
          let spy = 0;
          if (y < r.top + edge2)         spy = -maxSpeed2 * (1 - (y - r.top) / edge2);
          else if (y > r.bottom - edge2) spy =  maxSpeed2 * (1 - (r.bottom - y) / edge2);
          if (spy !== 0) prBody.scrollTop += spy;
        }
        if (y >= r.top && y <= r.bottom) {
          const edgeH = 50, maxSpH = 14;
          let spx = 0;
          if (lastTouch.clientX < r.left + edgeH)
            spx = -maxSpH * (1 - (lastTouch.clientX - r.left) / edgeH);
          else if (lastTouch.clientX > r.right - edgeH)
            spx =  maxSpH * (1 - (r.right - lastTouch.clientX) / edgeH);
          if (spx !== 0) prBody.scrollLeft += spx;
        }
      }

      // Horizontal auto-scroll in the arrangement view when the finger is
      // near the left/right edge of the lane-wrap viewport.
      const laneWrap = document.getElementById('seq-lane-wrap');
      if (laneWrap && laneWrap.offsetParent !== null) {
        const r = laneWrap.getBoundingClientRect();
        if (y >= r.top && y <= r.bottom) {
          const edgeH = 60, maxSpH = 18;
          let sp = 0;
          if (lastTouch.clientX < r.left + edgeH)
            sp = -maxSpH * (1 - (lastTouch.clientX - r.left) / edgeH);
          else if (lastTouch.clientX > r.right - edgeH)
            sp =  maxSpH * (1 - (r.right - lastTouch.clientX) / edgeH);
          if (sp !== 0) laneWrap.scrollLeft += sp;
        }
      }

      // Roll-mode lanes (the legacy MIDI lane when it shows notes inline)
      // also need vertical scroll while a chord-drag is over them.
      document.querySelectorAll('.seq-lane[data-track-id].roll-mode').forEach(l => {
        const r = l.getBoundingClientRect();
        if (lastTouch.clientX < r.left || lastTouch.clientX > r.right) return;
        const edge2 = 40, maxSpeed2 = 4;
        let sp = 0;
        if (y < r.top + edge2)         sp = -maxSpeed2 * (1 - (y - r.top) / edge2);
        else if (y > r.bottom - edge2) sp =  maxSpeed2 * (1 - (r.bottom - y) / edge2);
        if (sp !== 0) {
          l.scrollTop += sp;
          if (typeof updateRollOverflow === 'function') updateRollOverflow();
          if (typeof updateKeyboardPosition === 'function') updateKeyboardPosition();
        }
      });

      scrollRaf = requestAnimationFrame(autoScroll);
    };

    const clearAllLaneGhosts = () => {
      document.querySelectorAll('.seq-lane[data-track-id]').forEach(l => {
        l.classList.remove('drag-over');
        l.querySelector('.seq-drop-hint')?.style.removeProperty('color');
        seqClearGhost(l);
        if (typeof seqClearRollGhost === 'function') seqClearRollGhost(l);
      });
    };

    const cleanup = () => {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend',  onUp);
      document.removeEventListener('touchcancel', onUp);
      stopScroll();
      if (ghost) { ghost.remove(); ghost = null; }
      document.body.classList.remove('seq-dragging-chord', 'seq-dragging-note');
      clearAllLaneGhosts();
      clearPrGhost();
    };

    const onMove = (ev) => {
      const t = Array.from(ev.changedTouches).find(t => t.identifier === tid);
      if (!t) return;
      lastTouch = t;
      const dx = t.clientX - startX, dy = t.clientY - startY;
      if (!dragging) {
        if (dx * dx + dy * dy < 64) return;
        dragging = true;
        if (onCancelPlay) onCancelPlay();
        const data = getData();
        SEQ._dragLabel = data.label;
        ghost = document.createElement('div');
        ghost.className = 'seq-touch-drag-ghost';
        ghost.innerHTML = data.label;
        document.body.appendChild(ghost);
        const isChordData = data.interval !== undefined;
        document.body.classList.add(isChordData ? 'seq-dragging-chord' : 'seq-dragging-note');
        SEQ._dragChord = isChordData ? { interval: data.interval, q: data.q } : null;
        autoScroll();
      }
      ev.preventDefault();
      ghost.style.left = t.clientX + 'px';
      ghost.style.top  = t.clientY + 'px';

      clearAllLaneGhosts();
      clearPrGhost();

      const hit = hitTest(t.clientX, t.clientY);
      if (!hit) return;
      const data = getData();
      const isChord = data.interval !== undefined;

      if (hit.kind === 'lane') {
        const track = hit.track;
        // Chord tracks only accept chord drops; free tracks accept both.
        if (track.kind === 'chord' && !isChord) return;
        const beat  = Math.max(0, arrSnap((t.clientX - hit.rect.left) / BEAT_PX));
        const beats = isChord ? chordDropLen() : 1;
        hit.el.classList.add('drag-over');
        hit.el.querySelector('.seq-drop-hint')?.style.setProperty('color', 'var(--accent)');
        if (isChord && hit.el.classList.contains('roll-mode') && typeof seqSetRollGhost === 'function') {
          seqSetRollGhost(hit.el, beat, beats, chordNotesAtY(hit.el, t.clientY, data.interval, data.q));
        } else {
          seqSetGhost(hit.el, beat, beats);
        }
      } else if (hit.kind === 'pr') {
        if (!isChord) return;
        const { track, clip } = focusedClipObjects();
        if (!track || !clip) return;
        const body = hit.el;
        const beat = Math.max(0, rollSnap((t.clientX - hit.rect.left + body.scrollLeft - prKbW()) / PR_BEAT_PX));
        const cursorMidi = Math.max(0, Math.min(127, body._prHi - Math.floor((t.clientY - hit.rect.top + body.scrollTop) / PR_ROW_H)));
        const baseNotes = chordToMidiNotes(state.keys[state.currentTemplate], state.octave, data.interval, data.q);
        if (baseNotes.length === 0) return;
        const root = baseNotes[0];
        const shift = Math.round((cursorMidi - root) / 12) * 12;
        const notes = baseNotes.map(m => m + shift);
        if (prGhostNotes.length !== notes.length) {
          clearPrGhost();
          notes.forEach(() => {
            const g = document.createElement('div');
            g.className = 'pr-note pr-ghost-note';
            body.appendChild(g);
            prGhostNotes.push(g);
          });
        }
        notes.forEach((midi, i) => {
          const g = prGhostNotes[i];
          g.style.left   = (beat * PR_BEAT_PX + prKbW()) + 'px';
          g.style.width  = (chordDropLen() * PR_BEAT_PX) + 'px';
          g.style.top    = ((body._prHi - midi) * PR_ROW_H) + 'px';
          g.style.height = (PR_ROW_H - 2) + 'px';
          g.textContent  = midiNoteLabel(midi);
        });
      }
    };

    const onUp = (ev) => {
      const t = Array.from(ev.changedTouches).find(t => t.identifier === tid);
      if (!t) return;
      if (!dragging) { cleanup(); return; }
      const hit = hitTest(t.clientX, t.clientY);
      const data = getData();
      const isChord = data.interval !== undefined;
      cleanup();
      if (!hit) return;
      if (hit.kind === 'pr') {
        if (!isChord) return;
        const { track, clip } = focusedClipObjects();
        if (!track || !clip) return;
        const body = hit.el;
        const beat = Math.max(0, rollSnap((t.clientX - hit.rect.left + body.scrollLeft - prKbW()) / PR_BEAT_PX));
        const cursorMidi = Math.max(0, Math.min(127, body._prHi - Math.floor((t.clientY - hit.rect.top + body.scrollTop) / PR_ROW_H)));
        addChordToClip(track, clip, beat, data, cursorMidi);
        return;
      }
      // Lane drop — dispatch by track kind.
      const dropBeat = Math.max(0, arrSnap((t.clientX - hit.rect.left) / BEAT_PX));
      if (isChord) dropChord(hit.track, dropBeat, data);
      else         dropNote(hit.track, dropBeat, data);
    };

    document.addEventListener('touchmove',   onMove, { passive: false });
    document.addEventListener('touchend',    onUp);
    document.addEventListener('touchcancel', onUp);
}

function seqAddTouchDrag(el, laneId, getData, onCancelPlay) {
  el.addEventListener('touchstart', (e) => {
    if (!seqIsOpen()) return;
    seqStartTouchDrag(e.changedTouches[0], laneId, getData, onCancelPlay);
  }, { passive: true });
}

function seqApplyZoom(newBeatPx, anchorClientX) {
  const wrap = document.getElementById('seq-lane-wrap');
  const prevBeatPx = BEAT_PX;
  BEAT_PX = Math.round(Math.max(8, Math.min(160, newBeatPx)));
  if (BEAT_PX === prevBeatPx) return;
  // Anchor zoom on cursor position if given, otherwise on viewport center.
  const rect    = wrap ? wrap.getBoundingClientRect() : null;
  const anchorX = (typeof anchorClientX === 'number' && rect)
                ? Math.max(0, Math.min(wrap.clientWidth, anchorClientX - rect.left))
                : (wrap ? wrap.clientWidth / 2 : 0);
  const anchorBeat = wrap ? (wrap.scrollLeft + anchorX) / prevBeatPx : 0;
  seqUpdateBarLine();
  seqRenderAll();
  if (wrap) {
    // Keep the LEFTMOST visible beat anchored so the user keeps seeing
    // whatever was at the start of the view (incl. beat 0 when scrolled
    // all the way left). Content under the cursor may shift right as
    // the zoom widens it — that's the trade-off for "see more on the
    // left". Optional cursor pull: 0 = pure leftmost anchor, 1 = pure
    // cursor anchor. Currently zero.
    const CURSOR_PULL = 0;
    const leftmostScroll = wrap.scrollLeft * (BEAT_PX / prevBeatPx);
    const cursorScroll   = anchorBeat * BEAT_PX - anchorX;
    wrap.scrollLeft = Math.max(0,
      leftmostScroll * (1 - CURSOR_PULL) + cursorScroll * CURSOR_PULL
    );
  }
  if (typeof uiPrefsSave === 'function') uiPrefsSave();
}

// Piano-roll horizontal zoom — separate from arrangement zoom. Anchors on
// cursor position when provided, otherwise on viewport center.
function prApplyZoom(newBeatPx, anchorClientX) {
  const body = document.getElementById('seq-pianoroll-body');
  const prev = PR_BEAT_PX;
  PR_BEAT_PX = Math.round(Math.max(8, Math.min(200, newBeatPx)));
  if (PR_BEAT_PX === prev) return;
  prUpdateGridVars();
  const kb      = (typeof prKbW === 'function') ? prKbW() : 0;
  const rect    = body ? body.getBoundingClientRect() : null;
  const anchorX = (typeof anchorClientX === 'number' && rect)
                ? Math.max(kb, Math.min(body.clientWidth, anchorClientX - rect.left))
                : (body ? body.clientWidth / 2 : 0);
  const anchorBeat = body ? (body.scrollLeft + anchorX - kb) / prev : 0;
  renderPianoRoll();
  if (body) {
    // Same anchor strategy as the arrangement zoom: keep the LEFTMOST
    // visible beat anchored so leftward content stays in view.
    // CURSOR_PULL = 0 → pure leftmost anchor; 1 → pure cursor anchor.
    const CURSOR_PULL = 0;
    const leftmostScroll = body.scrollLeft * (PR_BEAT_PX / prev);
    const cursorScroll   = anchorBeat * PR_BEAT_PX + kb - anchorX;
    body.scrollLeft = Math.max(0,
      leftmostScroll * (1 - CURSOR_PULL) + cursorScroll * CURSOR_PULL
    );
  }
  if (typeof uiPrefsSave === 'function') uiPrefsSave();
}
function prUpdateGridVars() {
  document.documentElement.style.setProperty('--pr-bar-px',  (state.beatsPerBar * PR_BEAT_PX) + 'px');
  document.documentElement.style.setProperty('--pr-beat-px', PR_BEAT_PX + 'px');
}

function initSeqPinchZoom() {
  const wrap = document.getElementById('seq-lane-wrap');
  if (!wrap) return;
  let pinchStartDist = 0;
  let pinchStartBeatPx = BEAT_PX;
  let pinching = false;
  let liveScale = 1;
  const inner = wrap.querySelector('.seq-tracks-inner');

  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    pinching = true;
    pinchStartDist = Math.hypot(
      e.touches[1].clientX - e.touches[0].clientX,
      e.touches[1].clientY - e.touches[0].clientY
    );
    pinchStartBeatPx = BEAT_PX;
    liveScale = 1;
  }, { passive: false });

  wrap.addEventListener('touchmove', (e) => {
    if (!pinching || e.touches.length !== 2) return;
    e.preventDefault();
    const dist = Math.hypot(
      e.touches[1].clientX - e.touches[0].clientX,
      e.touches[1].clientY - e.touches[0].clientY
    );
    liveScale = dist / pinchStartDist;
    const preview = Math.max(10, Math.min(120, pinchStartBeatPx * liveScale));
    if (inner) { inner.style.transformOrigin = 'left center'; inner.style.transform = `scaleX(${preview / BEAT_PX})`; }
  }, { passive: false });

  wrap.addEventListener('touchend', (e) => {
    if (!pinching || e.touches.length > 1) return;
    pinching = false;
    if (inner) inner.style.transform = '';
    seqApplyZoom(pinchStartBeatPx * liveScale);
  });

  document.getElementById('seq-zoom-in')   ?.addEventListener('click', () => seqApplyZoom(BEAT_PX * 1.33));
  document.getElementById('seq-zoom-out')  ?.addEventListener('click', () => seqApplyZoom(BEAT_PX / 1.33));
  document.getElementById('seq-zoom-reset')?.addEventListener('click', () => seqApplyZoom(30));
}

function initSeqLanePan() {
  const wrap = document.getElementById('seq-lane-wrap');
  if (!wrap) return;

  wrap.addEventListener('scroll', () => { seqUpdateHints(); updateKeyboardPosition(); });

  const EXCLUDE = '.seq-block, .seq-loop-start, .seq-loop-end, .seq-resize, .seq-delete, .roll-note, .roll-chord-group, .roll-note-del, .roll-note-resize, .seq-roll-toggle-btn';

  function startPan(startX, startY, laneEl) {
    let prevX = startX, prevY = startY;
    let panning = false;

    const extendLanes = () => {
      const needed = wrap.scrollLeft + wrap.clientWidth + BEAT_PX * 8;
      ['seq-lane', 'seq-note-lane', 'seq-midi-lane'].forEach(id => {
        const lane = document.getElementById(id);
        if (lane && needed > (parseFloat(lane.style.minWidth) || 0)) lane.style.minWidth = needed + 'px';
      });
    };

    return {
      panning: () => panning,
      move(clientX, clientY, prevent) {
        const dx = prevX - clientX, dy = prevY - clientY;
        if (!panning && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        panning = true;
        if (prevent) prevent();
        wrap.scrollLeft += dx;
        if (laneEl) laneEl.scrollTop += dy;
        prevX = clientX;
        prevY = clientY;
        extendLanes();
      }
    };
  }

  wrap.addEventListener('touchstart', (e) => {
    const target = e.target;
    if (target.closest(EXCLUDE)) return;
    const laneEl = target.closest('#seq-lane, #seq-note-lane, #seq-midi-lane');
    if (!laneEl) return;

    const touch = e.changedTouches[0];
    const tid   = touch.identifier;

    const pan = startPan(touch.clientX, touch.clientY, laneEl);
    const onMove = (ev) => {
      const t = Array.from(ev.changedTouches).find(t => t.identifier === tid);
      if (!t) return;
      pan.move(t.clientX, t.clientY, () => ev.preventDefault());
    };
    const onUp = () => {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend',  onUp);
      document.removeEventListener('touchcancel', onUp);
    };
    document.addEventListener('touchmove',   onMove, { passive: false });
    document.addEventListener('touchend',    onUp);
    document.addEventListener('touchcancel', onUp);
  }, { passive: false });

  wrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const target = e.target;
    if (target.closest(EXCLUDE)) return;
    const laneEl = target.closest('#seq-lane, #seq-note-lane, #seq-midi-lane');
    if (!laneEl) return;
    // Click on empty lane area clears selection (unless modifier held)
    if (!target.closest('.seq-block, .roll-note') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      seqClearSelection();
    }

    const pan = startPan(e.clientX, e.clientY, laneEl);

    const onMove = (ev) => {
      pan.move(ev.clientX, ev.clientY, null);
      if (pan.panning()) wrap.style.cursor = 'grabbing';
    };
    const onUp = () => {
      wrap.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

function initMidiLaneResize() {
  const lane  = document.getElementById('seq-midi-lane');
  const inner = document.querySelector('.seq-tracks-inner');
  if (!lane || !inner) return;

  const handle = document.createElement('div');
  handle.className = 'midi-lane-resize-handle';
  inner.appendChild(handle);

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = lane.getBoundingClientRect().height;
    const onMove = ev => {
      const newH = Math.max(60, Math.min(500, startH + ev.clientY - startY));
      lane.style.maxHeight = newH + 'px';
      ROLL_VIEW_H = newH;
      updateRollOverflow();
      syncTrackLabelHeights();
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

function initSeqLoopEnd() {
  const handle = document.getElementById('seq-loop-end');
  const lane   = document.getElementById('seq-lane');
  if (!handle || !lane) return;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const laneRect = lane.getBoundingClientRect();
      const beat = Math.max(1, Math.round((ev.clientX - laneRect.left) / BEAT_PX));
      // Enforce a minimum loop length of one bar.
      const minLen = state.beatsPerBar || 4;
      SEQ.loopEnd = Math.max(beat, SEQ.loopStart + minLen);
      seqUpdateLoopEnd();
      if (SEQ.loop) seqResyncAllThrottled();
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      if (SEQ.playing && SEQ.loop) seqLoopBaseChangedResync();
      seqSave();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

function initSeqLoopStart() {
  const handle = document.getElementById('seq-loop-start');
  const lane   = document.getElementById('seq-lane');
  if (!handle || !lane) return;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const laneRect = lane.getBoundingClientRect();
      const beat = Math.max(0, Math.round((ev.clientX - laneRect.left) / BEAT_PX));
      // Enforce a minimum loop length of one bar.
      const minLen = state.beatsPerBar || 4;
      SEQ.loopStart = Math.min(beat, SEQ.loopEnd - minLen);
      seqUpdateLoopStart();
      if (SEQ.loop) seqResyncAllThrottled();
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      if (SEQ.playing && SEQ.loop) seqLoopBaseChangedResync();
      seqSave();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}
