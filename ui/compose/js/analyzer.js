// ============================================================
// CHORD ANALYZER
// ============================================================
//
// Live chord-name detection from notes currently held on the keyboard
// (visual click OR external MIDI input — both routed through
// kbNoteOn / kbNoteOff which populate kbActive).
//
// Cross-file dependencies (resolved at runtime via window scope):
//   chord-pad.js: CHORD_INTERVALS, QUALITY_GLYPH, formatChordRoot,
//                 qualityToHTML
//   kbinput.js:   kbActive (Map<midi, audioNode> of currently-held keys)
//
// Public surface (called from kbinput.js):
//   updateChordAnalyzer()  — read kbActive, detect, render

const PC_NAMES_FLAT  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const PC_NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

// Reverse lookup: sorted-deduped-mod-12 interval set → list of
// qualities. Built lazily on first detection. Common roots/triads end
// up with multiple qualities mapped to the same key (e.g. a fully-
// diminished 7 = '0,3,6,9' = four enharmonic dim7 spellings).
let _CHORD_REVERSE_MAP = null;
function _buildChordReverseMap() {
  if (_CHORD_REVERSE_MAP) return _CHORD_REVERSE_MAP;
  const map = {};
  if (typeof CHORD_INTERVALS !== 'object') return map;
  for (const [q, ivs] of Object.entries(CHORD_INTERVALS)) {
    const pcs = [...new Set(ivs.map(i => ((i % 12) + 12) % 12))].sort((a, b) => a - b);
    const key = pcs.join(',');
    if (!map[key]) map[key] = [];
    map[key].push(q);
  }
  _CHORD_REVERSE_MAP = map;
  return map;
}

// Identify every (root, quality) pair whose pitch-class footprint
// matches the given MIDI notes. The same set of notes may map to
// multiple interpretations — e.g. C-E-G-B♭-D = C9, but also Em7♭5
// inversions etc.; the analyzer surfaces the first as primary and
// the rest as synonyms.
function detectChords(midiNotes) {
  if (!midiNotes || midiNotes.length === 0) return [];
  const pcSet = [...new Set(midiNotes.map(n => ((n % 12) + 12) % 12))].sort((a, b) => a - b);
  const map = _buildChordReverseMap();
  // The pitch class of the LOWEST sounding note — strong hint that
  // it's the chord's root. Used to rank interpretations below.
  const bassPc = ((Math.min(...midiNotes) % 12) + 12) % 12;
  const results = [];
  for (const root of pcSet) {
    const intervals = pcSet.map(pc => (pc - root + 12) % 12).sort((a, b) => a - b);
    const key = intervals.join(',');
    const qs = map[key];
    if (qs) for (const q of qs) results.push({ root, quality: q });
  }
  // Rank interpretations:
  //  1. Bass note == root → much more likely the user's intended reading.
  //  2. Simpler glyph (shorter string) wins among equals.
  results.sort((a, b) => {
    const ba = a.root === bassPc ? 0 : 1;
    const bb = b.root === bassPc ? 0 : 1;
    if (ba !== bb) return ba - bb;
    const ga = (QUALITY_GLYPH[a.quality] || '').length;
    const gb = (QUALITY_GLYPH[b.quality] || '').length;
    return ga - gb;
  });
  return results;
}

// Black keys: roots where the sharp and flat name differ
// (D♯ = E♭, etc.). For those we show both spellings as "D♯/E♭…".
const _BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
// Build the chord label HTML the way the pads do — root name (with
// proper flat/sharp glyph) + quality glyph passed through qualityToHTML
// so °/+/ø render as SVG.
function _renderChordLabel(root, quality) {
  const fmt = (typeof formatChordRoot === 'function') ? formatChordRoot : (s => s);
  let formattedRoot;
  if (_BLACK_KEYS.has(root)) {
    formattedRoot = fmt(PC_NAMES_SHARP[root]) + '/' + fmt(PC_NAMES_FLAT[root]);
  } else {
    formattedRoot = fmt(PC_NAMES_SHARP[root]);
  }
  const glyph = QUALITY_GLYPH[quality] || quality;
  const qHTML = (typeof qualityToHTML === 'function') ? qualityToHTML(glyph) : glyph;
  return formattedRoot + qHTML;
}

function _renderNoteList(midiNotes) {
  if (!midiNotes.length) return '';
  const names = midiNotes.slice().sort((a, b) => a - b).map(n => {
    const pc  = ((n % 12) + 12) % 12;
    const oct = Math.floor(n / 12) - 1;
    const nm  = PC_NAMES_FLAT[pc];
    const formatted = (typeof formatChordRoot === 'function') ? formatChordRoot(nm) : nm;
    return formatted + '<sub>' + oct + '</sub>';
  });
  return names.join(' · ');
}

// Read the currently-held keys from kbActive, run detection, write
// the result into the .chord-analyzer DOM nodes. Called whenever a
// keyboard key goes down or up.
function updateChordAnalyzer() {
  const notesEl = document.getElementById('chord-analyzer-notes');
  const mainEl  = document.getElementById('chord-analyzer-main');
  const altsEl  = document.getElementById('chord-analyzer-alts');
  const arrowEl = document.getElementById('chord-analyzer-arrow');
  if (!mainEl || !altsEl) return;
  const held = (typeof kbActive !== 'undefined') ? [...kbActive.keys()] : [];
  if (notesEl) notesEl.innerHTML = _renderNoteList(held);
  if (held.length < 2) {
    mainEl.innerHTML = '';
    altsEl.innerHTML = '';
    if (arrowEl) arrowEl.textContent = '';
    return;
  }
  const results = detectChords(held);
  if (results.length === 0) {
    if (arrowEl) arrowEl.textContent = '→';
    mainEl.innerHTML = '<span class="chord-analyzer-unknown">—</span>';
    altsEl.innerHTML = '';
    return;
  }
  if (arrowEl) arrowEl.textContent = '→';
  const [primary, ...rest] = results;
  mainEl.innerHTML = _renderChordLabel(primary.root, primary.quality);
  altsEl.innerHTML = rest.length
    ? ' · ' + rest.slice(0, 5).map(r => _renderChordLabel(r.root, r.quality)).join(' · ')
    : '';
}
