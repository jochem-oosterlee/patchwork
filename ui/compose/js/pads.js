// ============================================================
// CHORD PADS + SCALE CHORDS + CONNECTION ARROWS
// ============================================================
//
// Extracted from chord-pad.js. Loaded AFTER seq.js (it calls
// seqIsOpen / seqStartTouchDrag) but BEFORE chord-pad.js — chord-pad
// .js's startup block calls rebuildBoard() at parse time so the
// builders need to be defined by then.
//
// Cross-file dependencies (resolved at runtime via window scope):
//   chord-pad.js: state, TEMPLATES, V2_SECTIONS, V2_KEYMAPS,
//                 QUALITY_GLYPH, INSTRUMENT_PRESETS, chordToMidiNotes,
//                 midiNoteName, formatChordRoot, chordRootName,
//                 currentScaleAbsolute, qualityToHTML
//   chord-pad.js (audio side): playChord, releaseChord, releaseAll
//   chord-pad.js (UI): showPianoTooltip, hidePianoTooltip,
//                 showSynonymTooltip / hideSynonymTooltip (now here),
//                 updateNowPlaying, updateSuggestions
//   audio.js:     getAudioCtx, startAudioNote, stopAudioNote
//   midi.js:      sendNoteOn, sendNoteOff
//   seq.js:       SEQ, seqIsOpen, seqStartTouchDrag,
//                 seqChordDragImage
//
// Public surface used by the rest of the app:
//   createPad, extQuality
//   buildScaleChordsBoard, buildChordLibraryBoard,
//   buildMajorHarmonyBoard, buildMinorHarmonyBoard,
//   updateNeapolitanSplit
//   rebuildBoard, scheduleDraw
//   SCALE_DEFS, computeScaleDegrees, SCALE_ROW_KEYS, scaleKeymap
//   showSynonymTooltip, hideSynonymTooltip
//   CONNECTIONS + drawConnections + helpers (drawRow*, drawPad*)

// ============================================================
// PAD RENDERING (Roman + button + quality)
// ============================================================
function extQuality(baseQ, ext) {
  if (!ext) return null;
  if (ext === 'maj7')  return baseQ === 'min' ? 'mmaj7' : baseQ === 'aug' ? 'augmaj7' : 'maj7';
  if (ext === 'maj7+') return 'augmaj7';
  if (ext === 'mmaj7') return 'mmaj7';
  if (ext === '°7')    return 'dim7';
  if (ext === 'ø')     return 'm7b5';
  if (ext === '7')     return baseQ === 'min' ? 'min7' : baseQ === 'dim' ? 'dim7' : 'dom7';
  return null;
}

function createPad(id, chordSpec, keyLabel, isStartHere) {
  const keyRoot = state.keys[state.currentTemplate];
  const root = chordRootName(keyRoot, chordSpec.interval);
  const glyph = chordSpec.qDisplay ?? QUALITY_GLYPH[chordSpec.q];
  const bassRoot = chordSpec.bassInterval !== undefined
    ? chordRootName(keyRoot, chordSpec.bassInterval) : null;

  const pad = document.createElement('div');
  pad.id = id;
  pad.className = 'pad';
  pad.dataset.interval    = chordSpec.interval;
  pad.dataset.q           = chordSpec.q;
  pad.dataset.bassInterval = chordSpec.bassInterval ?? '';
  pad.draggable = seqIsOpen();
  pad.addEventListener('dragstart', (e) => {
    if (!seqIsOpen()) { e.preventDefault(); return; }
    const label = `${formatChordRoot(root)}${qualityToHTML(glyph)}`;
    e.dataTransfer.effectAllowed = 'copy';
    const _chordPayload = JSON.stringify({
      interval: chordSpec.interval,
      q: chordSpec.q,
      bassInterval: chordSpec.bassInterval,
      label,
    });
    e.dataTransfer.setData('application/x-chord', _chordPayload);
    SEQ._prDragPayload = _chordPayload;
    SEQ._dragLabel = label;
    SEQ._dragChord = { interval: chordSpec.interval, q: chordSpec.q };
    const { el, h } = seqChordDragImage(label, state.beatsPerBar);
    e.dataTransfer.setDragImage(el, 0, h / 2);
    document.body.classList.add('seq-dragging-chord');
    setTimeout(() => { pad.classList.add('dragging'); document.querySelector('#seq-lane .seq-drop-hint')?.style.setProperty('color', 'var(--accent)'); }, 0);
  });
  pad.addEventListener('dragend', () => {
    document.body.classList.remove('seq-dragging-chord');
    pad.classList.remove('dragging');
    document.querySelector('#seq-lane .seq-drop-hint')?.style.removeProperty('color');
  });
  pad.innerHTML = `
    ${isStartHere ? '<span class="start-here-marker">start here</span>' : ''}
    <span class="pad-roman">${qualityToHTML(chordSpec.roman)}</span>
    <div class="pad-button">
      ${keyLabel ? `<span class="pad-key">${keyLabel}</span>` : ''}
      <span class="pad-chord">
        <span class="pad-name">${formatChordRoot(root)}${bassRoot ? `<span class="pad-bass-slash">/${formatChordRoot(bassRoot)}</span>` : ''}</span><span class="pad-quality">${qualityToHTML(glyph)}</span>
      </span>
      ${chordSpec.ext ? `<span class="pad-ext">${qualityToHTML(chordSpec.ext)}</span>` : ''}
    </div>
  `;

  const extQ = extQuality(chordSpec.q, chordSpec.ext);

  const showMainTooltip = () => {
    const keyRoot   = state.keys[state.currentTemplate];
    const rootPitch = (keyRoot + chordSpec.interval) % 12;
    showPianoTooltip(pad, rootPitch, chordSpec.q, chordSpec.pianoScale);
  };
  const onUp   = ()  => releaseChord(id);
  pad.addEventListener('mousedown', () => { showMainTooltip(); playChord(id, chordSpec.interval, chordSpec.q, chordSpec.bassInterval); });
  pad.addEventListener('mouseup',   onUp);
  pad.addEventListener('mouseleave', () => { onUp(); hidePianoTooltip(); });
  pad.addEventListener('touchstart', (e) => {
    e.preventDefault();
    showMainTooltip();
    playChord(id, chordSpec.interval, chordSpec.q, chordSpec.bassInterval);
    if (seqIsOpen()) seqStartTouchDrag(e.changedTouches[0], 'seq-lane', () => ({
      interval: chordSpec.interval, q: chordSpec.q, bassInterval: chordSpec.bassInterval,
      label: `${formatChordRoot(root)}${qualityToHTML(glyph)}`,
    }), () => releaseChord(id));
  }, { passive: false });
  pad.addEventListener('touchend', () => { onUp(); hidePianoTooltip(); });
  pad.addEventListener('mouseenter', (e) => {
    showMainTooltip();
    if (e.buttons > 0 && !seqIsOpen()) playChord(id, chordSpec.interval, chordSpec.q, chordSpec.bassInterval);
  });

  const badge = pad.querySelector('.pad-ext');
  if (badge && extQ) {
    badge.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      playChord(id, chordSpec.interval, extQ);
    });
    badge.draggable = seqIsOpen();
    badge.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      if (!seqIsOpen()) { e.preventDefault(); return; }
      // Derive the label from the RESOLVED quality (extQ), not the badge's
      // display glyph (chordSpec.ext). They can differ — e.g. the vi badge
      // shows "7" but resolves to min7 — and using the glyph gave wrong
      // labels like "A7" for an Am7. Falls in line with how seqLoad
      // regenerates labels from `q` on every load.
      const extGlyph = QUALITY_GLYPH[extQ] ?? chordSpec.ext;
      const extLabel = `${formatChordRoot(root)}${qualityToHTML(extGlyph)}`;
      e.dataTransfer.effectAllowed = 'copy';
      const _extPayload = JSON.stringify({
        interval: chordSpec.interval,
        q: extQ,
        bassInterval: chordSpec.bassInterval,
        label: extLabel,
      });
      e.dataTransfer.setData('application/x-chord', _extPayload);
      SEQ._prDragPayload = _extPayload;
      SEQ._dragLabel = extLabel;
      SEQ._dragChord = { interval: chordSpec.interval, q: extQ };
      const { el, h } = seqChordDragImage(extLabel, state.beatsPerBar);
      e.dataTransfer.setDragImage(el, 0, h / 2);
      document.body.classList.add('seq-dragging-chord');
      setTimeout(() => { badge.classList.add('dragging'); document.querySelector('#seq-lane .seq-drop-hint')?.style.setProperty('color', 'var(--accent)'); }, 0);
    });
    badge.addEventListener('dragend', () => {
      document.body.classList.remove('seq-dragging-chord');
      badge.classList.remove('dragging');
      document.querySelector('#seq-lane .seq-drop-hint')?.style.removeProperty('color');
      if (SEQ._dragHoverId) { releaseChord(SEQ._dragHoverId); SEQ._dragHoverId = null; }
    });
    badge.addEventListener('touchstart', (e) => {
      e.preventDefault(); e.stopPropagation();
      playChord(id, chordSpec.interval, extQ);
      if (seqIsOpen()) seqStartTouchDrag(e.changedTouches[0], 'seq-lane', () => ({
        interval: chordSpec.interval, q: extQ, bassInterval: chordSpec.bassInterval,
        label: `${formatChordRoot(root)}${qualityToHTML(QUALITY_GLYPH[extQ] ?? chordSpec.ext)}`,
      }), () => releaseChord(id));
    }, { passive: false });
    badge.addEventListener('touchend', (e) => { e.stopPropagation(); releaseChord(id); });
    badge.addEventListener('mouseup', (e) => {
      e.stopPropagation();
      releaseChord(id);
    });
    badge.addEventListener('mouseenter', (e) => {
      e.stopPropagation();
      const keyRoot   = state.keys[state.currentTemplate];
      const rootPitch = (keyRoot + chordSpec.interval) % 12;
      let badgeScale = chordSpec.pianoScale;
      if (badgeScale === undefined && chordSpec.q === 'dim') {
        badgeScale = Array.from(currentScaleAbsolute()).map(p => (p - rootPitch + 12) % 12);
      }
      showPianoTooltip(pad, rootPitch, extQ, badgeScale);
    });
    badge.addEventListener('mouseleave', () => {
      releaseChord(id);
      const keyRoot   = state.keys[state.currentTemplate];
      const rootPitch = (keyRoot + chordSpec.interval) % 12;
      showPianoTooltip(pad, rootPitch, chordSpec.q, chordSpec.pianoScale);
    });
    badge.addEventListener('touchstart', (e) => {
      e.stopPropagation(); e.preventDefault();
      const keyRoot   = state.keys[state.currentTemplate];
      const rootPitch = (keyRoot + chordSpec.interval) % 12;
      let badgeScale = chordSpec.pianoScale;
      if (badgeScale === undefined && chordSpec.q === 'dim') {
        badgeScale = Array.from(currentScaleAbsolute()).map(p => (p - rootPitch + 12) % 12);
      }
      showPianoTooltip(pad, rootPitch, extQ, badgeScale);
      playChord(id, chordSpec.interval, extQ);
    }, { passive: false });
    badge.addEventListener('touchend', (e) => {
      e.stopPropagation();
      releaseChord(id);
      hidePianoTooltip();
    });
  }

  return pad;
}

// ============================================================
// SCALE CHORDS
// ============================================================
const SCALE_DEFS = {
  'major':          [0, 2, 4, 5, 7, 9, 11],
  'minor':          [0, 2, 3, 5, 7, 8, 10],
  'harmonic-major': [0, 2, 4, 5, 7, 8, 11],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
};

function computeScaleDegrees(scaleIntervals) {
  function getInterval(i, step) {
    const j = i + step;
    return scaleIntervals[j % 7] + Math.floor(j / 7) * 12 - scaleIntervals[i];
  }
  const TRIAD_MAP = { '4,7':'maj','3,7':'min','3,6':'dim','4,8':'aug' };
  const SEVENTH_MAP = {
    '4,7,11':'maj7','4,7,10':'dom7','3,7,10':'min7','3,7,11':'mmaj7',
    '3,6,10':'m7b5','3,6,9':'dim7','4,8,11':'augmaj7','4,8,10':'aug7',
  };
  const NINTH_MAP  = { 'dom7':'dom9','maj7':'maj9','min7':'min9','mmaj7':null,'m7b5':null,'dim7':null,'augmaj7':null,'aug7':null };
  const ELEVENTH_MAP = { 'dom9':'dom11','maj9':'maj11','min9':'min11' };
  return Array.from({ length: 7 }, (_, i) => {
    const second   = getInterval(i, 1);
    const third    = getInterval(i, 2);
    const fourth   = getInterval(i, 3);
    const fifth    = getInterval(i, 4);
    const sixth    = getInterval(i, 5);
    const seventh  = getInterval(i, 6);
    const ninth    = getInterval(i, 8);
    const eleventh = getInterval(i, 10);
    const triadQ   = TRIAD_MAP[`${third},${fifth}`] ?? null;
    const seventhQ = SEVENTH_MAP[`${third},${fifth},${seventh}`] ?? null;
    const ninthQ   = (seventhQ && ninth === 14) ? (NINTH_MAP[seventhQ] ?? null) : null;
    const eleventhQ = (ninthQ && eleventh === 17) ? (ELEVENTH_MAP[ninthQ] ?? null) : null;
    return {
      interval:   scaleIntervals[i],
      triadQ,
      seventhQ,
      sixthQ:     (triadQ === 'maj' && sixth === 9) ? 'maj6' : (triadQ === 'min' && sixth === 9) ? 'min6' : null,
      ninthQ,
      eleventhQ,
      add2Q:      (triadQ && second === 2 && fifth === 7) ? (triadQ === 'maj' ? 'majadd2' : triadQ === 'min' ? 'minadd2' : null) : null,
      add4Q:      (triadQ && fourth === 5 && fifth === 7) ? (triadQ === 'maj' ? 'majadd4' : triadQ === 'min' ? 'minadd4' : null) : null,
      hasPower:   fifth === 7,
      hasSus2:    second === 2 && fifth === 7,
      hasSus4:    fourth === 5 && fifth === 7,
      hasSus24:   second === 2 && fourth === 5 && fifth === 7,
      has7sus2:   second === 2 && fifth === 7 && seventh === 10,
      has7sus4:   fourth === 5 && fifth === 7 && seventh === 10,
    };
  });
}


const SCALE_ROW_KEYS = {
  'sus2':    ['1','2','3','4','5','6','7'],
  'triad':   ['a','s','d','f','g','h','j'],
  'sus4':    ['z','x','c','v','b','n','m'],
  'seventh': ['q','w','e','r','t','y','u'],
};

let scaleKeymap = {}; // key → { padId, interval, q }

function buildScaleChordsBoard() {
  const key     = state.keys['scale-chords'];
  const mode    = (state.scaleType === 'minor' || state.scaleType === 'harmonic-minor') ? 'minor' : 'major';
  TEMPLATES['scale-chords'].keyMode = mode;
  const scale   = SCALE_DEFS[state.scaleType];
  const degrees = computeScaleDegrees(scale);
  const board   = document.querySelector('[data-board="scale-chords"]');
  board.innerHTML = '';
  scaleKeymap = {};

  const ROW_DEFS = {
    power:    { label: '5',          getQ: d => d.hasPower  ? 'power'  : null },
    sus2:     { label: 'Sus2',       getQ: d => d.hasSus2   ? 'sus2'   : null },
    triad:    { label: 'Triads', getQ: d => d.triadQ },
    sus4:     { label: 'Sus4',       getQ: d => d.hasSus4   ? 'sus4'   : null },
    sus24:    { label: 'Sus24',      getQ: d => d.hasSus24  ? 'sus24'  : null },
    sixth:    { label: '6',          getQ: d => d.sixthQ },
    '7sus2':  { label: '7sus2',      getQ: d => d.has7sus2  ? '7sus2'  : null },
    seventh:  { label: '7ths',       getQ: d => d.seventhQ },
    '7sus4':  { label: '7sus4',      getQ: d => d.has7sus4  ? '7sus4'  : null },
    ninth:    { label: '9',          getQ: d => d.ninthQ },
    eleventh: { label: '11',         getQ: d => d.eleventhQ },
    add2:     { label: 'Add2/Add9',  getQ: d => d.add2Q },
    add4:     { label: 'Add4/Add11', getQ: d => d.add4Q },
  };

  const PARALLEL = { 'major':'minor','minor':'major','harmonic-major':'harmonic-minor','harmonic-minor':'harmonic-major' };
  const SCALE_LABEL = { 'major':'Major','minor':'Minor','harmonic-major':'Harmonic Major','harmonic-minor':'Harmonic Minor' };

  function buildSection(scaleType, sectionLabel) {
    const sScale   = SCALE_DEFS[scaleType];
    const sDegrees = computeScaleDegrees(sScale);
    const sMode    = (scaleType === 'minor' || scaleType === 'harmonic-minor') ? 'minor' : 'major';
    const sRows = state.rowOrder
      .filter(id => state.visibleRows.has(id))
      .map(id => ({ id, ...ROW_DEFS[id], flowText: ROW_DEFS[id].flowText ?? null }));

    const sectionEl = document.createElement('div');
    sectionEl.className = 'scale-section';
    if (sectionLabel) {
      const hdr = document.createElement('div');
      hdr.className = 'scale-section-label';
      hdr.textContent = sectionLabel;
      sectionEl.appendChild(hdr);
    }

    sRows.forEach(rowDef => {
      const rowGroup = document.createElement('div');
      rowGroup.className = 'scale-row-group';
      const labelEl = document.createElement('div');
      labelEl.className = 'scale-row-label';
      labelEl.innerHTML = rowDef.flowText
        ? `<span>${rowDef.label}</span><span style="opacity:.45;margin-left:8px">${rowDef.flowText}</span>`
        : rowDef.label;
      rowGroup.appendChild(labelEl);

      const row = document.createElement('div');
      row.className = `scale-row scale-row-${rowDef.id}`;

      sDegrees.forEach((deg, colIdx) => {
        const q = rowDef.getQ(deg);
        const cell = document.createElement('div');
        cell.className = 'scale-cell' + (q ? '' : ' scale-cell-empty');
        if (q) {
          const padId   = `scale-pad-${sMode}-${rowDef.id}-${colIdx}`;
          const keyLabel = SCALE_ROW_KEYS[rowDef.id]?.[colIdx]?.toUpperCase() ?? null;
          if (keyLabel) scaleKeymap[SCALE_ROW_KEYS[rowDef.id][colIdx]] = { padId, interval: deg.interval, q };
          cell.appendChild(createPad(padId, { interval: deg.interval, q, roman: '' }, keyLabel, false));
        }
        row.appendChild(cell);
      });
      rowGroup.appendChild(row);
      sectionEl.appendChild(rowGroup);
    });
    return sectionEl;
  }

  const boardEl = document.createElement('div');
  boardEl.className = 'scale-board';

  if (state.combineParallel) {
    boardEl.appendChild(buildSection(state.scaleType,              SCALE_LABEL[state.scaleType]));
    boardEl.appendChild(buildSection(PARALLEL[state.scaleType],    SCALE_LABEL[PARALLEL[state.scaleType]]));
  } else {
    boardEl.appendChild(buildSection(state.scaleType, null));
  }

  board.appendChild(boardEl);
}

let synTooltipEl = null;
function getSynTooltipEl() {
  if (!synTooltipEl) {
    synTooltipEl = document.createElement('div');
    synTooltipEl.id = 'chord-syn-tooltip';
    document.body.appendChild(synTooltipEl);
  }
  return synTooltipEl;
}
function showSynonymTooltip(padEl, rootName, syns, equivs = []) {
  const el = getSynTooltipEl();
  const synsHtml = syns.length
    ? `<div class="syn-row">${syns.map(s => `<span class="syn">${rootName}${s}</span>`).join('')}</div>`
    : '';
  const equivsHtml = equivs.length
    ? `<div class="syn-equiv">${equivs.map(line => `<div class="syn-equiv-line">${line}</div>`).join('')}</div>`
    : '';
  el.innerHTML = synsHtml + equivsHtml;
  el.style.display = 'block';
  const r  = padEl.getBoundingClientRect();
  const tw = el.offsetWidth;
  const th = el.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  let top  = r.bottom + 8;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  if (top + th > window.innerHeight - 8) top = r.top - th - 8;
  el.style.left = left + 'px';
  el.style.top  = top + 'px';
}
function hideSynonymTooltip() {
  if (synTooltipEl) synTooltipEl.style.display = 'none';
}

function buildChordLibraryBoard() {
  const board = document.querySelector('[data-board="chord-library"]');
  board.innerHTML = '';

  const SECTIONS = [
    { label: 'Triads',           qs: ['maj', 'min', 'dim', 'aug'] },
    { label: 'Sus',              qs: ['sus2', 'sus4', 'sus24'] },
    { label: 'Sixths',           qs: ['maj6', 'min6', 'maj6add9'] },
    { label: 'Add',              qs: ['majadd2', 'minadd2', 'majadd4', 'minadd4'] },
    { label: 'Sevenths',         qs: ['maj7', 'dom7', 'min7', 'mmaj7', 'm7b5', 'dim7', 'augmaj7', 'aug7'] },
    { label: 'Seventh Sus',      qs: ['7sus2', '7sus4'] },
    { label: 'Ninths',           qs: ['maj9', 'dom9', 'min9'] },
    { label: 'Elevenths',        qs: ['maj11', 'dom11', 'min11'] },
    { label: 'Thirteenths',      qs: ['maj13', 'dom13', 'min13'] },
    { label: 'Altered Dominants',qs: ['7b5', 'aug7', '7b9', '7s9', '7s11', '7b13', '7alt'] },
  ];

  // Synonym suffixes (root prepended at render time)
  const SYNONYMS = {
    'maj':     ['', 'maj', 'M', 'Δ'],
    'min':     ['m', 'min', 'mi', '−'],
    'dim':     ['dim', '°', 'm♭5'],
    'aug':     ['aug', '+', '(♯5)', '(+5)'],
    'sus2':    ['sus2', '2'],
    'sus4':    ['sus4', 'sus', '4'],
    'power':   ['5', 'no3'],
    'sus24':   ['sus24', 'sus4add9', 'sus4(add9)'],
    'maj6':    ['6', 'maj6', 'M6', 'add6'],
    'min6':    ['m6', 'min6', '−6'],
    'maj7':    ['maj7', 'M7', 'Δ7', 'Δ', 'ma7', 'j7'],
    'dom7':    ['7', 'dom7'],
    'min7':    ['m7', 'min7', 'mi7', '−7'],
    'mmaj7':   ['mmaj7', 'm(maj7)', 'minmaj7', 'm♯7', '−Δ7'],
    'm7b5':    ['m7♭5', 'ø', 'ø7', '½dim7'],
    'dim7':    ['dim7', '°7'],
    'augmaj7': ['+maj7', 'maj7♯5', 'maj7(+5)', 'Δ7♯5'],
    'aug7':    ['+7', '7♯5', '7(+5)', 'aug7'],
    '7sus2':   ['7sus2'],
    '7sus4':   ['7sus4', '7sus'],
    'dom9':    ['9', 'dom9'],
    'maj9':    ['maj9', 'M9', 'Δ9'],
    'min9':    ['m9', 'min9', '−9'],
    'dom11':   ['11'],
    'maj11':   ['maj11', 'M11', 'Δ11'],
    'min11':   ['m11', '−11'],
    'majadd2': ['add9', '(add9)', '(9)'],
    'minadd2': ['m(add9)', 'madd9', '−(add9)'],
    'majadd4': ['add11', '(add11)', '(11)'],
    'minadd4': ['m(add11)', 'madd11', '−(add11)'],
    'maj6add9': ['6/9', '6add9', '6(9)'],
    'dom13':    ['13', 'dom13'],
    'maj13':    ['maj13', 'M13', 'Δ13'],
    'min13':    ['m13', 'min13', '−13'],
    '7b5':      ['7♭5', '7(−5)', '7(♭5)'],
    '7b9':      ['7♭9', '7(−9)', '7(♭9)'],
    '7s9':      ['7♯9', '7(+9)', '7(♯9)'],
    '7s11':     ['7♯11', '9♯11'],
    '7b13':     ['7♭13', '7(♭13)'],
    '7alt':     ['7alt', '7(♭9♯9♭5♯5)'],
  };

  // Enharmonic / functional equivalents.
  // {offset,suffix} → "= <root+offset><suffix>"; {text} → free-form line.
  const EQUIVS = {
    'maj6':  [{ prefix: '=', offset: 9, suffix: 'm7' }],
    'maj7':  [{ prefix: '=', offset: 4, suffix: 'm(add♭6)' }],
    'min6':  [{ prefix: '=', offset: 9, suffix: 'm7♭5' }, { prefix: '⊂', offset: 5, suffix: '9 (no root)' }],
    'dim7':  [{ text: 'symmetric — every minor-3rd up is the same chord' }],
    'aug':   [{ text: 'symmetric — every major-3rd up is the same chord' }],
    'sus2':  [{ prefix: '=', offset: 7, suffix: 'sus4 (inv)' }],
    '7b9':   [{ prefix: '⊂', offset: 1, suffix: '°7 (no root)' }],
    'maj9':  [{ prefix: '⊂', offset: 4, suffix: 'm7 (no root)' }],
    'dom13': [{ prefix: '⊂', offset: 7, suffix: 'm6 (no root)' }, { prefix: '⊂', offset: 10, suffix: 'maj7♯11' }],
  };

  const boardEl = document.createElement('div');
  boardEl.className = 'lib-board';

  SECTIONS.forEach(sec => {
    const group = document.createElement('div');
    group.className = 'lib-row-group';

    const labelEl = document.createElement('div');
    labelEl.className = 'lib-row-label';
    labelEl.textContent = sec.label;
    group.appendChild(labelEl);

    const row = document.createElement('div');
    row.className = 'lib-row';

    sec.qs.forEach(q => {
      const cell = document.createElement('div');
      cell.className = 'lib-cell';
      const padId = `lib-pad-${q}`;
      const pad = createPad(padId, { interval: 0, q, roman: '' }, null, false);
      const syns = SYNONYMS[q];
      const equivs = EQUIVS[q];
      if ((syns && syns.length) || (equivs && equivs.length)) {
        const libRoot = state.keys['chord-library'];
        const rootName = formatChordRoot(chordRootName(libRoot, 0));
        const equivLines = (equivs || []).map(eq => {
          if (eq.text) return eq.text;
          const altRoot = formatChordRoot(chordRootName(libRoot, eq.offset));
          return `${eq.prefix} ${altRoot}${eq.suffix}`;
        });
        pad.addEventListener('mouseenter', () => showSynonymTooltip(pad, rootName, syns || [], equivLines));
        pad.addEventListener('mouseleave', hideSynonymTooltip);
      }
      cell.appendChild(pad);
      row.appendChild(cell);
    });

    group.appendChild(row);
    boardEl.appendChild(group);
  });

  board.appendChild(boardEl);
}

function buildMajorHarmonyBoard() {
  const board = document.querySelector('[data-board="major-harmony"]');
  board.innerHTML = '';
  board.classList.add('v2');
  const sections = V2_SECTIONS['major-harmony'];
  const keymap   = V2_KEYMAPS['major-harmony'];

  const reverseKeymap = {};
  for (const [k, v] of Object.entries(keymap)) {
    reverseKeymap[`${v[0]},${v[1]}`] = k.toUpperCase();
  }

  sections.forEach((section) => {
    const sectionEl = document.createElement('div');
    sectionEl.className = 'major-section';

    const flowEl = document.createElement('div');
    flowEl.className = 'major-flow-label';
    flowEl.innerHTML = `<span>${section.label}</span><span style="opacity:.45; margin-left:8px">${section.flowText}</span>`;
    sectionEl.appendChild(flowEl);

    const row = document.createElement('div');
    row.className = `major-row ${section.id}`;

    section.chords.forEach((chord, cIdx) => {
      const cell = document.createElement('div');
      cell.className = 'pad-cell' + (chord ? '' : ' empty');
      if (chord) {
        const padId = `major-pad-${section.id}-${cIdx}`;
        const keyLabel = reverseKeymap[`${section.id},${cIdx}`] || '';
        cell.appendChild(createPad(padId, chord, keyLabel, false));
      }
      row.appendChild(cell);
    });

    const fillerCount = 7 - section.chords.length;
    for (let i = 0; i < fillerCount; i++) {
      const cell = document.createElement('div');
      cell.className = 'pad-cell empty';
      row.appendChild(cell);
    }

    sectionEl.appendChild(row);
    board.appendChild(sectionEl);
  });
}

function updateNeapolitanSplit() {
  document.querySelectorAll('.minor-row.has-neapolitan').forEach(row => {
    const rowRect = row.getBoundingClientRect();
    const regularCells = [...row.querySelectorAll('.pad-cell:not(.empty):not(.neapolitan)')];
    const firstCell = regularCells[0];
    const lastCell  = regularCells[regularCells.length - 1];
    if (!firstCell || !lastCell) return;
    const leftPad     = firstCell.getBoundingClientRect().left - rowRect.left;
    const splitFromLeft = lastCell.getBoundingClientRect().right - rowRect.left + leftPad;
    row.style.setProperty('--nea-split', (rowRect.width - splitFromLeft) + 'px');
  });
}

function buildMinorHarmonyBoard() {
  const board = document.querySelector('[data-board="minor-harmony"]');
  board.innerHTML = '';
  const sections = V2_SECTIONS['minor-harmony'];
  const keymap   = V2_KEYMAPS['minor-harmony'];

  const reverseKeymap = {};
  for (const [k, v] of Object.entries(keymap)) {
    reverseKeymap[`${v[0]},${v[1]}`] = k.toUpperCase();
  }

  const TOTAL_COLS = 7;

  sections.forEach((section) => {
    const sectionEl = document.createElement('div');
    sectionEl.className = 'minor-section';

    const hasNea = !!section.neapolitan;

    const flowEl = document.createElement('div');
    flowEl.className = 'minor-flow-label';
    flowEl.innerHTML = `<span>${section.label}</span><span style="opacity:.45; margin-left:8px">${section.flowText}</span>${hasNea ? `<span style="margin-left:auto; opacity:.7; letter-spacing:0.22em">NEAPOLITAN</span>` : ''}`;
    sectionEl.appendChild(flowEl);

    const row = document.createElement('div');
    row.className = `minor-row ${section.id}`;

    // Chord cells
    section.chords.forEach((chord, cIdx) => {
      const cell = document.createElement('div');
      cell.className = 'pad-cell' + (chord ? '' : ' empty');
      if (chord) {
        const padId = `minor-pad-${section.id}-${cIdx}`;
        const keyLabel = reverseKeymap[`${section.id},${cIdx}`] || '';
        cell.appendChild(createPad(padId, chord, keyLabel, false));
      }
      row.appendChild(cell);
    });

    // Empty filler cells so each row has TOTAL_COLS columns
    const fillerCount = TOTAL_COLS - section.chords.length - (hasNea ? 1 : 0);
    for (let i = 0; i < fillerCount; i++) {
      const cell = document.createElement('div');
      cell.className = 'pad-cell empty';
      row.appendChild(cell);
    }

    if (hasNea) {
      row.classList.add('has-neapolitan');
      const cell = document.createElement('div');
      cell.className = 'pad-cell neapolitan';
      const padId = 'minor-pad-neapolitan-0';
      const keyLabel = reverseKeymap['neapolitan,0'] || '';
      cell.appendChild(createPad(padId, section.neapolitan, keyLabel, false));
      row.appendChild(cell);
    }

    sectionEl.appendChild(row);
    board.appendChild(sectionEl);
  });
}

// ============================================================
// CONNECTION ARROWS (SVG overlay)
// ============================================================
const CONNECTIONS = {
  'major-harmony': [
    // Main → Sec.Dom (group: one-way up)
    { fromRow: '.major-row.main', toRow: '.major-row.secdom', type: 'oneway' },
    // Sec.Dom → Main (1-to-1: each secondary dominant resolves to its target)
    { from: 'major-pad-secdom-0', to: 'major-pad-main-0', type: 'oneway' },
    { from: 'major-pad-secdom-1', to: 'major-pad-main-1', type: 'oneway' },
    { from: 'major-pad-secdom-2', to: 'major-pad-main-2', type: 'oneway' },
    { from: 'major-pad-secdom-3', to: 'major-pad-main-3', type: 'oneway' },
    { from: 'major-pad-secdom-4', to: 'major-pad-main-4', type: 'oneway' },
    { from: 'major-pad-secdom-5', to: 'major-pad-main-5', type: 'oneway' },
    // I, IV, V ↕ modal (twoway)
    { fromPad: 'major-pad-main-0', toRow: '.major-row.modal', type: 'twoway' },
    { fromPad: 'major-pad-main-2', toRow: '.major-row.modal', type: 'twoway' },
    { fromPad: 'major-pad-main-4', toRow: '.major-row.modal', type: 'twoway' },
  ],
  'minor-harmony': [
    // main → sd_v (group up, starts at 1/3 of main row height)
    { fromRow: '.minor-row.main', toRow: '.minor-row.sd_v', type: 'oneway', fromYFraction: 1/3 },
    // sd_v → only V(7) = main-4
    { fromRow: '.minor-row.sd_v', toPad: 'minor-pad-main-4', type: 'oneway' },
    // main → sd_iv (group down, starts at 2/3 of main row height)
    { fromRow: '.minor-row.main', toRow: '.minor-row.sd_iv', type: 'oneway', fromYFraction: 2/3 },
    // sd_iv → only iv (main-2) and bVI (main-3)
    { fromRow: '.minor-row.sd_iv', toPad: 'minor-pad-main-2', type: 'oneway' },
    { fromRow: '.minor-row.sd_iv', toPad: 'minor-pad-main-3', type: 'oneway' },
  ],
};

function getButtonRect(padEl) {
  const btn = padEl.querySelector('.pad-button');
  return (btn || padEl).getBoundingClientRect();
}

function drawRowConnection(svg, fromEl, toEl, boardRect, type, fromYFraction = 0.5, isActive = false) {
  const fr = fromEl.getBoundingClientRect();
  const tr = toEl.getBoundingClientRect();
  const fy = fr.top  + fr.height * fromYFraction - boardRect.top;
  const ty = tr.top  + tr.height / 2 - boardRect.top;
  const leftEdge = Math.min(fr.left, tr.left) - boardRect.left;
  const xEnd = leftEdge - 2;
  const xArm = Math.max(window.innerWidth > 1024 ? -20 : -8, leftEdge - 24);
  const r    = 6;
  const dir  = ty > fy ? 1 : -1;

  const d = [
    `M ${xEnd} ${fy}`,
    `H ${xArm + r}`,
    `Q ${xArm} ${fy} ${xArm} ${fy + dir * r}`,
    `V ${ty - dir * r}`,
    `Q ${xArm} ${ty} ${xArm + r} ${ty}`,
    `H ${xEnd}`,
  ].join(' ');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', 'connection-line' + (isActive ? ' conn-active' : ''));
  path.setAttribute('fill', 'none');
  svg.appendChild(path);

  {
    const s = 6, h = 4;
    const x = xArm;
    const midY = (fy + ty) / 2;
    let d;
    if (type === 'twoway') {
      const y1 = fy + (ty - fy) / 3;
      const y2 = fy + (ty - fy) * 2 / 3;
      d = `M ${x-h} ${y1+s} L ${x} ${y1} L ${x+h} ${y1+s} ` +
          `M ${x-h} ${y2-s} L ${x} ${y2} L ${x+h} ${y2-s}`;
    } else {
      d = `M ${x-h} ${midY - dir*s} L ${x} ${midY} L ${x+h} ${midY - dir*s}`;
    }
    const chevron = document.createElementNS(SVG_NS, 'path');
    chevron.setAttribute('d', d);
    chevron.setAttribute('class', 'connection-arrow' + (isActive ? ' conn-active' : ''));
    svg.appendChild(chevron);
  }
}

function drawPadToRowConnection(svg, padEl, rowEl, boardRect, type, isActive = false) {
  const pr = getButtonRect(padEl);
  const rr = rowEl.getBoundingClientRect();
  const px = pr.left + pr.width / 2 - boardRect.left;
  const py_bottom = pr.bottom - boardRect.top;
  const ry = rr.top  - boardRect.top - 2;

  const sy = py_bottom + 5;
  const ey = ry;

  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', px); line.setAttribute('y1', sy);
  line.setAttribute('x2', px); line.setAttribute('y2', ey);
  line.setAttribute('class', 'connection-line' + (isActive ? ' conn-active' : ''));
  svg.appendChild(line);

  drawArrowhead(svg, px, ey, 0, 1, isActive);
  if (type === 'twoway') drawArrowhead(svg, px, sy, 0, -1, isActive);
}

function drawRowToPadConnection(svg, rowEl, padEl, boardRect, type, isActive = false) {
  const rr = rowEl.getBoundingClientRect();
  const pr = getButtonRect(padEl);
  const px = pr.left + pr.width / 2 - boardRect.left;
  const rowCy = rr.top + rr.height / 2;
  const padCy = pr.top + pr.height / 2;
  let sy, ey, dir;
  if (rowCy < padCy) {
    sy = rr.bottom - boardRect.top + 2;
    ey = pr.top    - boardRect.top - 5;
    dir = 1;
  } else {
    sy = rr.top    - boardRect.top - 2;
    ey = pr.bottom - boardRect.top + 5;
    dir = -1;
  }
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', px); line.setAttribute('y1', sy);
  line.setAttribute('x2', px); line.setAttribute('y2', ey);
  line.setAttribute('class', 'connection-line' + (isActive ? ' conn-active' : ''));
  svg.appendChild(line);
  drawArrowhead(svg, px, ey, 0, dir, isActive);
}

function drawConnections() {
  const board = document.querySelector(`[data-board="${state.currentTemplate}"]`);
  if (!board) return;
  let svg = board.querySelector('.connections-svg');
  if (!svg) {
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'connections-svg');
    board.appendChild(svg);
  }
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // Clear previous group highlights
  board.querySelectorAll('.conn-active').forEach(el => el.classList.remove('conn-active'));

  const boardRect = board.getBoundingClientRect();
  if (boardRect.width === 0 || boardRect.height === 0) return;
  svg.setAttribute('viewBox', `0 0 ${boardRect.width} ${boardRect.height}`);
  svg.setAttribute('width', boardRect.width);
  svg.setAttribute('height', boardRect.height);

  const conns = CONNECTIONS[state.currentTemplate] || [];
  conns.forEach(conn => {
    if (conn.fromRow && conn.toRow) {
      const fromEl = board.querySelector(conn.fromRow);
      const toEl   = board.querySelector(conn.toRow);
      if (!fromEl || !toEl) return;
      const isActive = !!fromEl.querySelector('.pad.active');
      if (isActive) { fromEl.classList.add('conn-active'); toEl.classList.add('conn-active'); }
      drawRowConnection(svg, fromEl, toEl, boardRect, conn.type, conn.fromYFraction, isActive);
      return;
    }
    if (conn.fromRow && conn.toPad) {
      const rowEl = board.querySelector(conn.fromRow);
      const padEl = document.getElementById(conn.toPad);
      if (!rowEl || !padEl) return;
      const isActive = !!rowEl.querySelector('.pad.active');
      if (isActive) rowEl.classList.add('conn-active');
      drawRowToPadConnection(svg, rowEl, padEl, boardRect, conn.type, isActive);
      return;
    }
    if (conn.fromPad) {
      const padEl = document.getElementById(conn.fromPad);
      const rowEl = board.querySelector(conn.toRow);
      if (!padEl || !rowEl) return;
      const isActive = padEl.classList.contains('active') ||
        (conn.type === 'twoway' && !!rowEl.querySelector('.pad.active'));
      if (isActive) rowEl.classList.add('conn-active');
      drawPadToRowConnection(svg, padEl, rowEl, boardRect, conn.type, isActive);
      return;
    }
    const fromEl = document.getElementById(conn.from);
    const toEl = document.getElementById(conn.to);
    if (!fromEl || !toEl) return;
    const isActive = fromEl.classList.contains('active');
    const fr = getButtonRect(fromEl);
    const tr = getButtonRect(toEl);
    const fx = fr.left + fr.width/2 - boardRect.left;
    const fy = fr.top + fr.height/2 - boardRect.top;
    const tx = tr.left + tr.width/2 - boardRect.left;
    const ty = tr.top + tr.height/2 - boardRect.top;
    drawConnection(svg, fx, fy, tx, ty,
                   fr.width/2, fr.height/2,
                   tr.width/2, tr.height/2,
                   conn.type, isActive);
  });
}

function drawConnection(svg, x1, y1, x2, y2, w1h, h1h, w2h, h2h, type, isActive = false) {
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.sqrt(dx*dx + dy*dy);
  if (dist < 1) return;
  const ux = dx / dist, uy = dy / dist;
  const startEdge = (Math.abs(ux) < 0.001) ? h1h
                  : (Math.abs(uy) < 0.001) ? w1h
                  : Math.min(Math.abs(w1h/ux), Math.abs(h1h/uy));
  const endEdge = (Math.abs(ux) < 0.001) ? h2h
                : (Math.abs(uy) < 0.001) ? w2h
                : Math.min(Math.abs(w2h/ux), Math.abs(h2h/uy));
  const margin = 5;
  const sx = x1 + ux * (startEdge + margin);
  const sy = y1 + uy * (startEdge + margin);
  const ex = x2 - ux * (endEdge + margin);
  const ey = y2 - uy * (endEdge + margin);
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', sx); line.setAttribute('y1', sy);
  line.setAttribute('x2', ex); line.setAttribute('y2', ey);
  line.setAttribute('class', 'connection-line' + (isActive ? ' conn-active' : ''));
  svg.appendChild(line);
  drawArrowhead(svg, ex, ey, ux, uy, isActive);
  if (type === 'twoway') drawArrowhead(svg, sx, sy, -ux, -uy, isActive);
}

function drawArrowhead(svg, x, y, ux, uy, isActive = false) {
  const size = 6, halfBase = 4;
  const px = -uy, py = ux;
  const baseX = x - ux * size, baseY = y - uy * size;
  const lx = baseX + px * halfBase, ly = baseY + py * halfBase;
  const rx = baseX - px * halfBase, ry = baseY - py * halfBase;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', `M ${lx} ${ly} L ${x} ${y} L ${rx} ${ry}`);
  path.setAttribute('class', 'connection-arrow' + (isActive ? ' conn-active' : ''));
  svg.appendChild(path);
}

let drawScheduled = null;
let keyChangeDir = 0; // +1 = up (higher pitch), -1 = down, 0 = no animation
function scheduleDraw() {
  if (drawScheduled) cancelAnimationFrame(drawScheduled);
  drawScheduled = requestAnimationFrame(() => {
    drawScheduled = null;
    drawConnections();
  });
}

function rebuildBoard() {
  releaseAll();

  if (keyChangeDir !== 0) {
    const dir = keyChangeDir;
    keyChangeDir = 0;
    const tpl = state.currentTemplate;
    const board = document.querySelector(`[data-board="${tpl}"]`);

    // Exit: slide current chord (name + quality) out in the roll direction
    const exitY = dir > 0 ? '-210%' : '210%';
    board.querySelectorAll('.pad-chord').forEach(el => {
      el.style.transition = 'transform 0.1s ease-in, opacity 0.09s ease-in';
      el.style.transform  = `translateY(${exitY})`;
      el.style.opacity    = '0';
    });

    setTimeout(() => {
      if (tpl !== state.currentTemplate) return; // tab changed during animation
      if (tpl === 'major-harmony') buildMajorHarmonyBoard();
      else if (tpl === 'minor-harmony') { buildMinorHarmonyBoard(); updateNeapolitanSplit(); }
      else if (tpl === 'scale-chords') buildScaleChordsBoard();
      else if (tpl === 'chord-library') buildChordLibraryBoard();
      scheduleDraw();
      const enterCls = dir > 0 ? 'key-rolling-up' : 'key-rolling-down';
      document.querySelectorAll(`[data-board="${tpl}"] .pad-chord`).forEach(el => {
        el.classList.add(enterCls);
        el.addEventListener('animationend', () => el.classList.remove(enterCls), { once: true });
      });
    }, 100);
  } else {
    if (state.currentTemplate === 'major-harmony') buildMajorHarmonyBoard();
    else if (state.currentTemplate === 'minor-harmony') { buildMinorHarmonyBoard(); updateNeapolitanSplit(); }
    else if (state.currentTemplate === 'scale-chords') buildScaleChordsBoard();
    else if (state.currentTemplate === 'chord-library') buildChordLibraryBoard();
    scheduleDraw();
  }
}
