// Block browser touch interference (context menus, text selection popups)
document.addEventListener('contextmenu', e => { if (e.pointerType === 'touch') e.preventDefault(); });
document.addEventListener('selectstart', e => { if (e.target.closest('.app')) e.preventDefault(); });

// ============================================================
// CONSTANTS
// ============================================================
const SVG_NS = 'http://www.w3.org/2000/svg';
const KEY_DISPLAY       = ['C','D♭','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];
const MINOR_KEY_DISPLAY = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','B♭','B'];

// Per-key chromatic spelling support
const LETTER_SEQUENCE = ['C','D','E','F','G','A','B'];
const LETTER_PITCH = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
// Tonic spelling for each major key root (chromatic 0-11)
const MAJOR_KEY_TONICS = ['C','D♭','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];

function trySpelling(letter, targetPitch) {
  const acc = ((targetPitch - LETTER_PITCH[letter]) % 12 + 12) % 12;
  if (acc === 0) return letter;
  if (acc === 1) return letter + '♯';
  if (acc === 11) return letter + '♭';
  return null; // double accidental
}

const SPELLING_CACHE = {};
function buildSpelling(rootIdx, mode) {
  const cacheKey = `${rootIdx}-${mode}`;
  if (SPELLING_CACHE[cacheKey]) return SPELLING_CACHE[cacheKey];

  const majorRoot = (mode === 'minor' || mode === 'harmonic-minor') ? (rootIdx + 3) % 12 : rootIdx;
  const tonicLetter = MAJOR_KEY_TONICS[majorRoot][0];
  const tonicLetterIdx = LETTER_SEQUENCE.indexOf(tonicLetter);
  const majorScale = [0, 2, 4, 5, 7, 9, 11];
  const spelling = new Array(12).fill(null);

  // Diatonic notes
  for (let d = 0; d < 7; d++) {
    const letter = LETTER_SEQUENCE[(tonicLetterIdx + d) % 7];
    const pitch = (majorRoot + majorScale[d]) % 12;
    const name = trySpelling(letter, pitch);
    if (name !== null) spelling[pitch] = name;
  }

  // Chromatic conventions: [semitones, preferred scale degree, fallback degree]
  // Minor keys prefer sharps (G# not Ab, D# not Eb, C# not Db), except bVII stays Bb
  const conventions = (mode === 'minor' || mode === 'harmonic-minor')
    ? [[1,0,1],[3,1,2],[6,3,4],[8,4,5],[10,6,5]]
    : [[1,1,0],[3,2,1],[6,3,4],[8,5,4],[10,6,5]];
  for (const [semitones, preferredDeg, fallbackDeg] of conventions) {
    const pitch = (majorRoot + semitones) % 12;
    if (spelling[pitch] !== null) continue;
    let name = null;
    for (const deg of [preferredDeg, fallbackDeg]) {
      const letter = LETTER_SEQUENCE[(tonicLetterIdx + deg) % 7];
      name = trySpelling(letter, pitch);
      if (name !== null) break;
    }
    spelling[pitch] = name;
  }

  SPELLING_CACHE[cacheKey] = spelling;
  return spelling;
}

const CHORD_INTERVALS = {
  'maj':     [0, 4, 7],
  'min':     [0, 3, 7],
  'dim':     [0, 3, 6],
  'aug':     [0, 4, 8],
  'sus2':    [0, 2, 7],
  'sus4':    [0, 5, 7],
  'dom7':    [0, 4, 7, 10],
  'maj7':    [0, 4, 7, 11],
  'min7':    [0, 3, 7, 10],
  'mmaj7':   [0, 3, 7, 11],
  'm7b5':    [0, 3, 6, 10],
  'dim7':    [0, 3, 6, 9],
  'augmaj7': [0, 4, 8, 11],
  'aug7':    [0, 4, 8, 10],
  'power':   [0, 7],
  'sus24':   [0, 2, 5, 7],
  'maj6':    [0, 4, 7, 9],
  'min6':    [0, 3, 7, 9],
  '7sus2':   [0, 2, 7, 10],
  '7sus4':   [0, 5, 7, 10],
  'dom9':    [0, 4, 7, 10, 14],
  'maj9':    [0, 4, 7, 11, 14],
  'min9':    [0, 3, 7, 10, 14],
  'dom11':   [0, 4, 7, 10, 14, 17],
  'maj11':   [0, 4, 7, 11, 14, 17],
  'min11':   [0, 3, 7, 10, 14, 17],
  'majadd2': [0, 2, 4, 7],
  'minadd2': [0, 2, 3, 7],
  'majadd4': [0, 4, 5, 7],
  'minadd4': [0, 3, 5, 7],
  'maj6add9':[0, 2, 4, 7, 9],
  'dom13':   [0, 4, 7, 10, 14, 21],
  'maj13':   [0, 4, 7, 11, 14, 21],
  'min13':   [0, 3, 7, 10, 14, 17, 21],
  '7b5':     [0, 4, 6, 10],
  '7b9':     [0, 1, 4, 7, 10],
  '7s9':     [0, 3, 4, 7, 10],
  '7s11':    [0, 4, 6, 7, 10, 14],
  '7b13':    [0, 4, 7, 8, 10, 14],
  '7alt':    [0, 1, 3, 4, 8, 10],
};

// Average interval per chord type — used to center the chord's midpoint on the key root
const CHORD_AVG_IV = Object.fromEntries(
  Object.entries(CHORD_INTERVALS).map(([q, ivs]) => [q, ivs.reduce((a, b) => a + b, 0) / ivs.length])
);

const CHORD_SUFFIX = {
  'maj': '', 'min': 'm', 'dim': '°', 'aug': '+',
  'sus2': 'sus2', 'sus4': 'sus4',
  'dom7': '7', 'maj7': 'maj7', 'min7': 'm7', 'mmaj7': 'mmaj7',
  'm7b5': 'ø', 'dim7': '°7', 'augmaj7': 'maj7+', 'aug7': '7+',
  'power': '5', 'sus24': 'sus24',
  'maj6': '6', 'min6': 'm6',
  '7sus2': '7sus2', '7sus4': '7sus4',
  'dom9': '9', 'maj9': 'maj9', 'min9': 'm9',
  'dom11': '11', 'maj11': 'maj11', 'min11': 'm11',
  'majadd2': 'add2', 'minadd2': 'madd2',
  'majadd4': 'add4', 'minadd4': 'madd4',
  'maj6add9': '6/9',
  'dom13': '13', 'maj13': 'maj13', 'min13': 'm13',
  '7b5': '7♭5', '7b9': '7♭9', '7s9': '7♯9', '7s11': '7♯11', '7b13': '7♭13', '7alt': '7alt',
};

const QUALITY_GLYPH = {
  'maj': '', 'min': 'm', 'dim': '°', 'aug': '+',
  'sus2': 'sus2', 'sus4': 'sus4',
  'dom7': '7', 'maj7': 'maj7', 'min7': 'm7', 'mmaj7': 'mmaj7',
  'm7b5': 'ø', 'dim7': '°7', 'augmaj7': 'maj7+', 'aug7': '7+',
  'power': '5', 'sus24': 'sus24',
  'maj6': '6', 'min6': 'm6',
  '7sus2': '7sus2', '7sus4': '7sus4',
  'dom9': '9', 'maj9': 'maj9', 'min9': 'm9',
  'dom11': '11', 'maj11': 'maj11', 'min11': 'm11',
  'majadd2': 'add2', 'minadd2': 'madd2',
  'majadd4': 'add4', 'minadd4': 'madd4',
  'maj6add9': '6/9',
  'dom13': '13', 'maj13': 'maj13', 'min13': 'm13',
  '7b5': '7♭5', '7b9': '7♭9', '7s9': '7♯9', '7s11': '7♯11', '7b13': '7♭13', '7alt': '7alt',
};

// SVG icons for flow labels
const ICON_LOOP = `<svg class="icon" viewBox="0 0 16 16"><path d="M 3.5 6.5 A 4.5 4.5 0 1 1 3.5 9.5" /><polyline points="2.5 9 4 11 5.5 9" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
const ICON_NOLOOP = `<svg class="icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" /><line x1="3.5" y1="3.5" x2="12.5" y2="12.5" stroke-linecap="round"/></svg>`;
const ICON_DOWN = `<svg class="icon" viewBox="0 0 16 16"><line x1="8" y1="2.5" x2="8" y2="13" stroke-linecap="round"/><polyline points="4.5 9.5 8 13 11.5 9.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
const ICON_UP = `<svg class="icon" viewBox="0 0 16 16"><line x1="8" y1="13.5" x2="8" y2="3" stroke-linecap="round"/><polyline points="4.5 6.5 8 3 11.5 6.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

// ============================================================
// TEMPLATES
// ============================================================
const TEMPLATES = {
  'major-harmony': {
    name: 'Major Harmony',
    defaultKey: 0,
    keyMode: 'major',
    sections: [
      {
        id: 'secdom',
        flowIcon: ICON_NOLOOP,
        flowText: "DON'T MIX CHORDS",
        label: 'Secondary Dominants',
        chords: [
          {roman:'V<sub>I</sub>',   interval:7,  q:'dom7', pianoScale:[0,2,4,5,7,9,10]},
          {roman:'V<sub>vi</sub>',  interval:4,  q:'dom7', pianoScale:[0,1,4,5,7,8,10]},
          {roman:'V<sub>IV</sub>',  interval:0,  q:'dom7', pianoScale:[0,2,4,5,7,9,10]},
          {roman:'V<sub>ii</sub>',  interval:9,  q:'dom7', pianoScale:[0,1,4,5,7,8,10]},
          {roman:'V<sub>V</sub>',   interval:2,  q:'dom7', pianoScale:[0,2,4,5,7,9,10]},
          {roman:'V<sub>iii</sub>', interval:11, q:'dom7', pianoScale:[0,1,4,5,7,8,10]},
        ]
      },
      {
        id: 'main',
        flowIcon: ICON_DOWN,
        flowText: 'START HERE · MIX CHORDS',
        label: 'Main Chords',
        chords: [
          {roman:'I',   interval:0, q:'maj'},
          {roman:'vi',  interval:9, q:'min'},
          {roman:'IV',  interval:5, q:'maj'},
          {roman:'ii',  interval:2, q:'min'},
          {roman:'V',   interval:7, q:'maj'},
          {roman:'iii', interval:4, q:'min'},
        ]
      },
      {
        id: 'modal',
        flowIcon: ICON_LOOP,
        flowText: 'MIX CHORDS',
        label: 'Modal Interchange',
        chords: [
          {roman:'bIII', interval:3,  q:'maj'},
          null,
          {roman:'bVI',  interval:8,  q:'maj'},
          {roman:'iv',   interval:5,  q:'min'},
          {roman:'bVII', interval:10, q:'maj'},
          null,
        ]
      },
    ],
    keymap: {
      '1':['secdom',0], '2':['secdom',1], '3':['secdom',2], '4':['secdom',3], '5':['secdom',4], '6':['secdom',5],
      'q':['main',0], 'w':['main',1], 'e':['main',2], 'r':['main',3], 't':['main',4], 'y':['main',5],
      'a':['modal',0], 'd':['modal',2], 'f':['modal',3], 'g':['modal',4],
    }
  },
  'minor-harmony': {
    name: 'Minor Harmony',
    defaultKey: 9,
    keyMode: 'harmonic-minor',
    sections: [
      {
        id: 'sd_v',
        flowIcon: ICON_LOOP,
        flowText: 'MIX CHORDS',
        label: 'Secondary Diminished V',
        chords: [
          {roman:'vii°<sub>V</sub>', interval:6, q:'dim'},
          {roman:'vii°<sub>V</sub>', interval:9, q:'dim'},
          {roman:'vii°<sub>V</sub>', interval:0, q:'dim'},
          {roman:'vii°<sub>V</sub>', interval:3, q:'dim'},
        ],
        neapolitan: {roman:'bII', interval:1, q:'maj'}
      },
      {
        id: 'main',
        flowIcon: ICON_DOWN,
        flowText: 'MIX CHORDS',
        label: 'Main Chords',
        chords: [
          {roman:'i',     interval:0,  q:'min'},
          {roman:'bIII+', interval:3,  q:'aug'},
          {roman:'iv',    interval:5,  q:'min'},
          {roman:'bVI',   interval:8,  q:'maj'},
          {roman:'V<sup>(7)</sup>',     interval:7, q:'dom7', qDisplay:'(7)'},
          {roman:'#vii°', interval:11, q:'dim'},
          {roman:'ii°',   interval:2,  q:'dim'},
        ]
      },
      {
        id: 'sd_iv',
        flowIcon: ICON_LOOP,
        flowText: 'MIX CHORDS',
        label: 'Secondary Diminished iv, bVI',
        chords: [
          {roman:'vii°<sub>iv</sub>', interval:10, q:'dim'},
          {roman:'vii°<sub>iv</sub>', interval:1,  q:'dim'},
          {roman:'vii°<sub>iv</sub>', interval:4,  q:'dim'},
          {roman:'vii°<sub>iv</sub>', interval:7,  q:'dim'},
        ]
      }
    ],
    keymap: {
      '1':['sd_v',0],'2':['sd_v',1],'3':['sd_v',2],'4':['sd_v',3],
      '5':['neapolitan',0],
      'q':['main',0],'w':['main',1],'e':['main',2],'r':['main',3],
      't':['main',4],'y':['main',5],'u':['main',6],
      'a':['sd_iv',0],'s':['sd_iv',1],'d':['sd_iv',2],'f':['sd_iv',3],
    }
  },
  'scale-chords': {
    name: 'Scale Chords',
    defaultKey: 0,
    keyMode: 'major',
    sections: [],
    keymap: {},
  },
  'chord-library': {
    name: 'Chord Library',
    defaultKey: 0,
    keyMode: 'major',
    sections: [],
    keymap: {},
  },
};

const V2_SECTIONS = {
  'major-harmony': [
    {
      id: 'secdom', flowIcon: ICON_NOLOOP, flowText: "DON'T MIX CHORDS", label: 'Secondary Dominants',
      chords: [
        {roman:'V<sub>I</sub>',   interval:7,  q:'dom7', pianoScale:[0,2,4,5,7,9,10]},
        {roman:'V<sub>vi</sub>',  interval:4,  q:'dom7', pianoScale:[0,1,4,5,7,8,10]},
        {roman:'V<sub>IV</sub>',  interval:0,  q:'dom7', pianoScale:[0,2,4,5,7,9,10]},
        {roman:'V<sub>ii</sub>',  interval:9,  q:'dom7', pianoScale:[0,1,4,5,7,8,10]},
        {roman:'V<sub>V</sub>',   interval:2,  q:'dom7', pianoScale:[0,2,4,5,7,9,10]},
        {roman:'V<sub>iii</sub>', interval:11, q:'dom7', pianoScale:[0,1,4,5,7,8,10]},
      ]
    },
    {
      id: 'main', flowIcon: ICON_DOWN, flowText: 'START HERE · MIX CHORDS', label: 'Main Chords',
      chords: [
        {roman:'I',    interval:0,  q:'maj', ext:'maj7'},
        {roman:'vi',   interval:9,  q:'min', ext:'7'},
        {roman:'IV',   interval:5,  q:'maj', ext:'maj7'},
        {roman:'ii',   interval:2,  q:'min', ext:'7'},
        {roman:'V',    interval:7,  q:'maj', ext:'7'},
        {roman:'iii',  interval:4,  q:'min', ext:'7'},
        {roman:'vii°', interval:11, q:'dim', ext:'ø'},
      ]
    },
    {
      id: 'modal', flowIcon: ICON_LOOP, flowText: 'MIX CHORDS', label: 'Modal Interchange',
      chords: [
        {roman:'bIII', interval:3,  q:'maj', ext:'maj7', pianoScale:[0,2,4,5,7,9,11]},
        {roman:'bVI',  interval:8,  q:'maj', ext:'maj7', pianoScale:[0,2,4,6,7,9,11]},
        {roman:'iv',   interval:5,  q:'min', ext:'7',    pianoScale:[0,2,3,5,7,9,10]},
        {roman:'bVII', interval:10, q:'maj', ext:'7',    pianoScale:[0,2,4,5,7,9,10]},
        {roman:'ii°',  interval:2,  q:'dim', ext:'ø',    pianoScale:[0,1,3,5,6,8,10]},
      ]
    },
  ],
  'minor-harmony': [
    {
      id: 'sd_v', flowIcon: ICON_LOOP, flowText: 'MIX CHORDS', label: 'Secondary Diminished V',
      chords: [
        {roman:'vii°<sub>V</sub>', interval:6, q:'dim', ext:'7'},
        {roman:'vii°<sub>V</sub>', interval:9, q:'dim', ext:'7'},
        {roman:'vii°<sub>V</sub>', interval:0, q:'dim', ext:'7'},
        {roman:'vii°<sub>V</sub>', interval:3, q:'dim', ext:'7'},
      ],
      neapolitan: {roman:'bII', interval:1, q:'maj', bassInterval:5, ext:'maj7', pianoScale:[0,2,4,6,7,9,11]}
    },
    {
      id: 'main', flowIcon: ICON_DOWN, flowText: 'MIX CHORDS', label: 'Main Chords',
      chords: [
        {roman:'i',     interval:0,  q:'min', ext:'maj7'},
        {roman:'bIII+', interval:3,  q:'aug', ext:'maj7'},
        {roman:'iv',    interval:5,  q:'min', ext:'7'},
        {roman:'bVI',   interval:8,  q:'maj', ext:'maj7'},
        {roman:'V',     interval:7,  q:'dom7'},
        {roman:'#vii°', interval:11, q:'dim', ext:'7'},
        {roman:'ii°',   interval:2,  q:'dim', ext:'ø'},
      ]
    },
    {
      id: 'sd_iv', flowIcon: ICON_LOOP, flowText: 'MIX CHORDS', label: 'Secondary Diminished iv, bVI',
      chords: [
        {roman:'vii°<sub>iv</sub>', interval:10, q:'dim', ext:'7'},
        {roman:'vii°<sub>iv</sub>', interval:1,  q:'dim', ext:'7'},
        {roman:'vii°<sub>iv</sub>', interval:4,  q:'dim', ext:'7'},
        {roman:'vii°<sub>iv</sub>', interval:7,  q:'dim', ext:'7'},
      ]
    },
  ],
};

const V2_KEYMAPS = {
  'major-harmony': {
    '1':['secdom',0],'2':['secdom',1],'3':['secdom',2],'4':['secdom',3],'5':['secdom',4],'6':['secdom',5],
    'q':['main',0],'w':['main',1],'e':['main',2],'r':['main',3],'t':['main',4],'y':['main',5],'u':['main',6],
    'a':['modal',0],'s':['modal',1],'d':['modal',2],'f':['modal',3],'g':['modal',4],
  },
  'minor-harmony': {
    '1':['sd_v',0],'2':['sd_v',1],'3':['sd_v',2],'4':['sd_v',3],
    '5':['neapolitan',0],
    'q':['main',0],'w':['main',1],'e':['main',2],'r':['main',3],
    't':['main',4],'y':['main',5],'u':['main',6],
    'a':['sd_iv',0],'s':['sd_iv',1],'d':['sd_iv',2],'f':['sd_iv',3],
  },
};

// ============================================================
// STATE
// ============================================================
const state = {
  currentTemplate: 'major-harmony',
  keys: { 'major-harmony': 0, 'minor-harmony': 9, 'scale-chords': 0, 'chord-library': 0 },
  scaleType: 'major',
  octave: 4,
  velocity: 100,
  channel: 0,
  midiEnabled: false,
  midiAccess: null,
  output: null,
  inputPort: null,
  activeChords: new Map(),
  sustain: false,
  audioEnabled: true,
  audioVolume: 0.70,
  // Per-GM-category gain compensation so e.g. bass isn't 6 dB softer than
  // piano. Toggleable from the header. See sf2CategoryGain() for the table.
  volumeBalance: true,
  // Chord-pad output routing: 'instrument' plays the in-app voice, 'midi'
  // sends external MIDI on padChannel and skips the in-app voice. Mirrors
  // the per-track output toggle.
  padOutput: 'instrument',
  padChannel: 0,
  // ID of the MIDI output port the chord-pad sends to in MIDI mode. Empty
  // string = use the global default (state.output).
  padMidiPortId: '',
  // MIDI clock source: if midiClockEnabled, the selected input port drives
  // the master tempo + transport (start/stop). Empty id = none.
  midiClockPortId: '',
  midiClockEnabled: false,
  pitchBendCents: 0,
  instrument: 'epiano',
  bassEnabled: true,
  showScaleTones: false,
  visibleRows: new Set(['sus2', 'triad', 'sus4', 'seventh']),
  rowOrder: ['power','sus2','triad','sus4','sus24','sixth','7sus2','seventh','7sus4','ninth','eleventh','add2','add4'],
  combineParallel: false,
  voicing: 'auto',
  playStyle: 'off',
  tempo: 120,
  beatsPerBar: 4,
  bassOctave: 2,
  showPianoHover: false,
  synth: {
    waveform:      'sine',
    attack:        0.15,
    decay:         0.3,
    sustain:       0.45,
    release:       1.99,
    filterFreq:    880,
    filterQ:       5,
    overtones:     0.55,
    reverb:        0.5,
    detune:        12,
    vibratoRate:   5,
    vibratoDepth:  0,
    tremoloRate:   4,
    tremoloDepth:  0,
    delayTime:     0.3,
    delayFeedback: 0.3,
    delayWet:      0,
    filterLfoDepth: 0,
  },
};

// Virtual "track" for the on-screen keyboard — gives kbinput its own
// instrument + synth + FX, separate from the chord-pad voice. Opened
// via the settings cog on the keyboard panel using openTrackFxModal.
// Persisted in the UI-prefs blob, not the project snapshot.
state.keyboardTrack = {
  id: 'kb',
  kind: 'free',
  name: 'Keyboard',
  instrument: 'epiano',
  channel: 0,
  output: 'instrument',
  midiPortId: '',
  volume: 1,
  muted: false,
  soloed: false,
  synth: {
    waveform: 'sine',
    attack: 0.01, decay: 0.4, sustain: 0.7, release: 0.4,
    filterFreq: 8000, filterQ: 0.5,
    overtones: 0.2, detune: 0,
    reverb: 0.3,
    vibratoRate: 5, vibratoDepth: 0,
    tremoloRate: 4, tremoloDepth: 0,
    delayTime: 0.3, delayFeedback: 0.3, delayWet: 0,
    filterLfoDepth: 0,
  },
  items: [],
};

// ============================================================
// HELPERS
// ============================================================
const ENHARMONIC = { 'C♭':'B', 'F♭':'E', 'E♯':'F', 'B♯':'C' };
function chordRootName(keyRoot, interval) {
  const tpl = TEMPLATES[state.currentTemplate];
  const spelling = buildSpelling(keyRoot, tpl.keyMode);
  const name = spelling[(keyRoot + interval) % 12];
  return ENHARMONIC[name] ?? name;
}
function chordDisplayName(keyRoot, interval, q) { return chordRootName(keyRoot, interval) + CHORD_SUFFIX[q]; }
function midiNoteName(n) {
  const tpl = TEMPLATES[state.currentTemplate];
  const keyRoot = state.keys[state.currentTemplate];
  const spelling = buildSpelling(keyRoot, tpl.keyMode);
  return spelling[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}
function chordToMidiNotes(keyRoot, octave, interval, q, voicingOverride) {
  const center = 12 * (octave + 1) + keyRoot;
  const pitchClass = (keyRoot + interval) % 12;
  const ivs = CHORD_INTERVALS[q];
  const n = ivs.length;

  // Anchor root octave using average-centering as a starting point
  const baseRoot = pitchClass + Math.round((center - CHORD_AVG_IV[q] - pitchClass) / 12) * 12;
  // Per-call override (sequenced chord items carry their voicing at
  // drop time so they're not affected by the live pad voicing knob).
  const voicing = voicingOverride ?? state.voicing;

  if (voicing === 'root') {
    const root = pitchClass + Math.round((center - pitchClass) / 12) * 12;
    return ivs.map(iv => root + iv);
  }

  // auto1/auto2 = auto mode with a preference for a specific inversion.
  // Implemented as a distance discount in the loop below so the chosen
  // inversion still respects the key center, just biased.
  const preferMatch = /^auto(\d+)$/.exec(voicing);
  const preferInv = preferMatch ? (parseInt(preferMatch[1], 10) % n) : -1;

  // For high/low, shift the target center; auto uses the original center
  const target = voicing === 'high' ? center + 7
               : voicing === 'low'  ? center - 7
               : center;

  // Try all inversions across ±1 octave; pick the voicing whose average is closest to target
  let best = null;
  let bestDist = Infinity;

  for (let oct = -1; oct <= 1; oct++) {
    const root = baseRoot + oct * 12;
    for (let inv = 0; inv < n; inv++) {
      const notes = [root + ivs[inv]];
      for (let i = 1; i < n; i++) {
        const pc = ((root + ivs[(inv + i) % n]) % 12 + 12) % 12;
        let note = pc;
        while (note <= notes[notes.length - 1]) note += 12;
        notes.push(note);
      }
      const avg = notes.reduce((a, b) => a + b, 0) / n;
      let dist = Math.abs(avg - target);
      if (inv === preferInv) dist -= 6;
      if (dist < bestDist) { bestDist = dist; best = notes; }
    }
  }

  if (voicing === 'spread' && best.length >= 3) {
    // Drop 2: lower the second-highest note by an octave for an open voicing
    const dropped = [...best];
    dropped[dropped.length - 2] -= 12;
    dropped.sort((a, b) => a - b);
    return dropped;
  }

  return best;
}
function formatChordRoot(name) {
  return name.replace(/([♭♯])/g, '<span class="acc">$1</span>');
}
function qualityToHTML(glyph) {
  return glyph
    .replace(/°/g, '<svg class="q-dim" viewBox="0 0 10 10" width="0.75em" height="0.75em" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="5" r="3.5"/></svg>')
    .replace(/ø/g, '<svg class="q-halfdim" viewBox="0 0 10 10" width="0.75em" height="0.75em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5" cy="5" r="3.5"/><line x1="1.5" y1="8.5" x2="8.5" y2="1.5"/></svg>')
    .replace(/\+/g, '<svg class="q-aug" viewBox="0 0 10 10" width="0.75em" height="0.75em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="5" y1="1.5" x2="5" y2="8.5"/><line x1="1.5" y1="5" x2="8.5" y2="5"/></svg>');
}


// ============================================================
// NEXT-CHORD SUGGESTIONS
// ============================================================
function getNextChords(currentPadId) {
  if (!currentPadId) return [];

  if (state.currentTemplate === 'major-harmony') {
    const m = currentPadId.match(/^major-pad-(\w+)-(\d+)$/);
    if (!m) return [];
    const [, section, idxStr] = m;
    const idx = parseInt(idxStr, 10);

    if (section === 'main') {
      const mainCount = 7;
      const result = [];
      for (let i = 0; i < mainCount; i++) {
        if (i !== idx) result.push(`major-pad-main-${i}`);
      }
      for (let i = 0; i < 6; i++) result.push(`major-pad-secdom-${i}`);
      // DOWN: I (0), IV (2), V (4) → any modal chord
      if (idx === 0 || idx === 2 || idx === 4) {
        for (let i = 0; i < 5; i++) result.push(`major-pad-modal-${i}`);
      }
      return result;
    }
    if (section === 'secdom') return [`major-pad-main-${idx}`];
    if (section === 'modal') {
      // UP: any modal → I (0), IV (2), V (4)
      const result = ['major-pad-main-0', 'major-pad-main-2', 'major-pad-main-4'];
      for (let i = 0; i < 5; i++) {
        if (i !== idx) result.push(`major-pad-modal-${i}`);
      }
      return result;
    }
  }

  if (state.currentTemplate === 'minor-harmony') {
    if (currentPadId === 'minor-pad-neapolitan-0') {
      const result = ['minor-pad-main-4'];
      for (let i = 0; i < 4; i++) result.push(`minor-pad-sd_v-${i}`);
      return result;
    }
    const m = currentPadId.match(/^minor-pad-(\w+)-(\d+)$/);
    if (!m) return [];
    const [, section, idxStr] = m;
    const idx = parseInt(idxStr, 10);

    if (section === 'main') {
      const result = [];
      for (let i = 0; i < 7; i++) {
        if (i !== idx) result.push(`minor-pad-main-${i}`);
      }
      for (let i = 0; i < 4; i++) {
        result.push(`minor-pad-sd_v-${i}`);
        result.push(`minor-pad-sd_iv-${i}`);
      }
      result.push('minor-pad-neapolitan-0');
      return result;
    }
    if (section === 'sd_iv') {
      const result = ['minor-pad-main-2', 'minor-pad-main-3'];
      for (let i = 0; i < 4; i++) {
        if (i !== idx) result.push(`minor-pad-sd_iv-${i}`);
      }
      return result;
    }
    if (section === 'sd_v') {
      const result = ['minor-pad-main-4', 'minor-pad-neapolitan-0'];
      for (let i = 0; i < 4; i++) {
        if (i !== idx) result.push(`minor-pad-sd_v-${i}`);
      }
      return result;
    }
  }

  return [];
}

function updateSuggestions() {
  document.querySelectorAll('.pad.suggested').forEach(p => p.classList.remove('suggested'));
  if (state.activeChords.size === 0) { scheduleDraw(); return; }
  // Show suggestions for the most recently added active chord
  const keys = Array.from(state.activeChords.keys());
  const lastPadId = keys[keys.length - 1];
  getNextChords(lastPadId).forEach(padId => {
    document.getElementById(padId)?.classList.add('suggested');
  });
  scheduleDraw();
}

// ============================================================
// CHORD PLAY / RELEASE
// ============================================================
function bassNoteForChord(interval) {
  const keyRoot = state.keys[state.currentTemplate];
  return (state.bassOctave + 1) * 12 + (keyRoot + interval) % 12;
}

const _padKeyRef = new Map();
function _markPadKeys(midis, on) {
  if (!midis || !midis.length) return;
  for (const m of midis) {
    const cur = _padKeyRef.get(m) || 0;
    const next = cur + (on ? 1 : -1);
    const el = document.querySelector('.kb-key[data-midi="' + m + '"]');
    if (next <= 0) {
      _padKeyRef.delete(m);
      el?.classList.remove('pad-active');
    } else {
      _padKeyRef.set(m, next);
      el?.classList.add('pad-active');
    }
  }
}

function playChord(padId, interval, quality, bassInterval) {
  if (state.activeChords.has(padId)) {
    if (state.sustain) {
      const chord = state.activeChords.get(padId);
      const portR = midiPortById(state.padMidiPortId);
      if (state.padOutput === 'midi') chord.notes.forEach(n => sendNoteOff(n, state.padChannel, portR));
      chord.audioNodes.forEach(stopAudioNote);
      if (chord.bassNote !== null) {
        if (state.padOutput === 'midi') sendNoteOff(chord.bassNote, state.padChannel, portR);
        stopAudioNote(chord.bassAudioNode);
      }
      _markPadKeys(chord.kbHighlight, false);
      state.activeChords.delete(padId);
      document.getElementById(padId)?.classList.remove('active');
      updateNowPlaying();
      updateSuggestions();
    }
    return;
  }
  if (state.sustain) {
    state.activeChords.forEach((chord, pid) => {
      chord.notes.forEach(n => sendNoteOff(n));
      chord.audioNodes.forEach(stopAudioNote);
      if (chord.bassNote !== null) { sendNoteOff(chord.bassNote); stopAudioNote(chord.bassAudioNode); }
      _markPadKeys(chord.kbHighlight, false);
      document.getElementById(pid)?.classList.remove('active');
    });
    state.activeChords.clear();
  }

  const keyRoot = state.keys[state.currentTemplate];
  const notes = chordToMidiNotes(keyRoot, state.octave, interval, quality);
  const label = chordDisplayName(keyRoot, interval, quality);
  const useInst = state.padOutput !== 'midi';
  const useMidi = state.padOutput === 'midi';
  const padPort = useMidi ? midiPortById(state.padMidiPortId) : null;
  if (useMidi) notes.forEach(n => sendNoteOn(n, state.velocity, state.padChannel, padPort));
  let audioNodes = [];
  if (useInst && state.audioEnabled) {
    if (state.playStyle === 'strum-up' || state.playStyle === 'strum-down') {
      audioNodes = playStrum(notes, state.velocity, state.playStyle === 'strum-down' ? 'down' : 'up');
    } else if (state.playStyle !== 'off' && psStart(padId, notes)) {
      // scheduler handles audio
    } else {
      audioNodes = notes.map(n => startAudioNote(n, state.velocity));
    }
  }

  let bassNote = null, bassAudioNode = null;
  if (state.bassEnabled) {
    bassNote = bassNoteForChord(bassInterval !== undefined ? bassInterval : interval);
    if (useMidi) sendNoteOn(bassNote, state.velocity, state.padChannel, padPort);
    if (useInst && state.audioEnabled) bassAudioNode = startBassNote(bassNote);
  }

  const kbHighlight = bassNote !== null ? notes.concat([bassNote]) : notes.slice();
  _markPadKeys(kbHighlight, true);
  state.activeChords.set(padId, { notes, label, audioNodes, bassNote, bassAudioNode, kbHighlight });
  document.getElementById(padId)?.classList.add('active');
  updateNowPlaying();
  updateSuggestions();
  if (REC.active) {
    const rawBeat = Math.round(recCurrentBeat() * 2) / 2;
    const startBeat = SEQ.loop ? rawBeat % SEQ.loopEnd : rawBeat;
    REC.pendingChords.set(padId, { interval, q: quality, bassInterval, label,
      keyRoot: state.keys[state.currentTemplate], template: state.currentTemplate,
      voicing: state.voicing, octave: state.octave,
      bassEnabled: state.bassEnabled, bassOctave: state.bassOctave,
      startBeat });
  }
}

function releaseChord(padId) {
  if (state.sustain) return;
  psStop(padId);
  const chord = state.activeChords.get(padId);
  if (!chord) return;
  const portR = midiPortById(state.padMidiPortId);
  if (state.padOutput === 'midi') chord.notes.forEach(n => sendNoteOff(n, state.padChannel, portR));
  chord.audioNodes.forEach(stopAudioNote);
  if (chord.bassNote !== null) {
    if (state.padOutput === 'midi') sendNoteOff(chord.bassNote, state.padChannel, portR);
    stopAudioNote(chord.bassAudioNode);
  }
  _markPadKeys(chord.kbHighlight, false);
  state.activeChords.delete(padId);
  document.getElementById(padId)?.classList.remove('active');
  updateNowPlaying();
  updateSuggestions();
  if (REC.active && REC.pendingChords.has(padId)) {
    const p = REC.pendingChords.get(padId);
    const beats = Math.max(0.5, Math.round(recCurrentBeat() * 2) / 2 - p.startBeat) || 0.5;
    const trk = ensureTrackOfKind('chord');
    trk.items.push({ interval: p.interval, q: p.q, bassInterval: p.bassInterval,
      label: p.label, beats, start: p.startBeat, keyRoot: p.keyRoot, template: p.template,
      voicing: p.voicing, octave: p.octave,
      bassEnabled: p.bassEnabled, bassOctave: p.bassOctave });
    trk.items.sort((a, b) => a.start - b.start);
    // Loop bounds are user-controlled; placing a chord (via REC) must
    // never widen the loop range.
    seqRenderTrack(trk);
    seqResyncTrack(trk);
    REC.pendingChords.delete(padId);
  }
}

function releaseAll() {
  Array.from(state.activeChords.keys()).forEach(psStop);
  const portR = midiPortById(state.padMidiPortId);
  Array.from(state.activeChords.entries()).forEach(([padId, chord]) => {
    if (state.padOutput === 'midi') chord.notes.forEach(n => sendNoteOff(n, state.padChannel, portR));
    chord.audioNodes.forEach(stopAudioNote);
    if (chord.bassNote !== null) {
      if (state.padOutput === 'midi') sendNoteOff(chord.bassNote, state.padChannel, portR);
      stopAudioNote(chord.bassAudioNode);
    }
    document.getElementById(padId)?.classList.remove('active');
  });
  state.activeChords.clear();
  updateNowPlaying();
  updateSuggestions();
}

function updateNowPlaying() {
  const all = Array.from(state.activeChords.values());
  const display = document.getElementById('now-playing-notes');
  if (!display) return; // "Playing" footer was removed
  display.textContent = all.length === 0 ? '—'
    : all.map(c => c.label + ' [' + c.notes.map(midiNoteName).join(' · ') + ']').join('   +   ');
}


// ============================================================
// KEY SELECTOR
// ============================================================
function buildKeyTracks() {
  ['major-harmony', 'minor-harmony', 'scale-chords', 'chord-library'].forEach(tplId => {
    const track = document.querySelector(`[data-key-track="${tplId}"]`);
    track.innerHTML = '';
    const isMinor = ['minor', 'harmonic-minor'].includes(TEMPLATES[tplId].keyMode);
    const display = isMinor ? MINOR_KEY_DISPLAY : KEY_DISPLAY;
    display.forEach((noteLabel, i) => {
      const btn = document.createElement('button');
      btn.className = 'key-btn';
      btn.dataset.template = tplId;
      btn.dataset.keyIdx = i;
      btn.innerHTML = isMinor
        ? formatChordRoot(noteLabel) + 'm'
        : formatChordRoot(noteLabel);
      btn.addEventListener('click', () => setKey(tplId, i));
      track.appendChild(btn);
    });
  });
  updateKeySelectors();
}

function updateKeySelectors() {
  ['major-harmony', 'minor-harmony', 'scale-chords', 'chord-library'].forEach(tplId => {
    const currentKey = state.keys[tplId];
    document.querySelectorAll(`[data-key-track="${tplId}"] .key-btn`).forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.keyIdx, 10) === currentKey);
    });
  });
}

function setKey(tplId, keyIdx) {
  const oldKey = state.keys[tplId];
  const diff = (keyIdx - oldKey + 12) % 12;
  keyChangeDir = diff === 0 ? 0 : diff <= 6 ? 1 : -1;
  state.keys[tplId] = keyIdx;
  updateKeySelectors();
  if (state.currentTemplate === tplId) rebuildBoard();
  if (typeof uiPrefsSave === 'function') uiPrefsSave();
}

// ============================================================
// TABS
// ============================================================
function setActiveTab(tabId) {
  releaseAll();
  state.currentTemplate = tabId;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.dataset.page === tabId));
  rebuildBoard();
  if (typeof uiPrefsSave === 'function') uiPrefsSave();
}
document.querySelectorAll('.tab').forEach(tab => {
  // Skip tabs without a data-tab (e.g. the gear-icon settings button — it
  // has its own click handler and shouldn't switch templates).
  if (!tab.dataset.tab) return;
  tab.addEventListener('click', () => setActiveTab(tab.dataset.tab));
});

document.querySelectorAll('.scale-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.scaleType = btn.dataset.scale;
    document.querySelectorAll('.scale-btn').forEach(b => b.classList.toggle('active', b === btn));
    // Update key track labels to reflect major/minor spelling
    const mode = (state.scaleType === 'minor' || state.scaleType === 'harmonic-minor') ? 'minor' : 'major';
    TEMPLATES['scale-chords'].keyMode = mode;
    buildKeyTracks();
    if (state.currentTemplate === 'scale-chords') buildScaleChordsBoard();
  });
});

// ============================================================
// ROWS CONFIG DROPDOWN
// ============================================================
const rowsConfigBtn      = document.getElementById('rows-config-btn');
const rowsConfigDropdown = document.createElement('div');
rowsConfigDropdown.className = 'rows-config-dropdown';
rowsConfigDropdown.id = 'rows-config-dropdown';
document.body.appendChild(rowsConfigDropdown);

function renderRowsDropdown() {
  rowsConfigDropdown.innerHTML = '';
  let dragSrc = null;

  state.rowOrder.forEach(rowId => {
    const labels = {
      power:'5 (Power)', sus2:'Sus2', triad:'Triad', sus4:'Sus4', sus24:'Sus24',
      sixth:'6', '7sus2':'7sus2', seventh:'7ths', '7sus4':'7sus4',
      ninth:'9', eleventh:'11', add2:'Add2/Add9', add4:'Add4/Add11',
    };
    const item = document.createElement('div');
    item.className = 'row-config-item';
    item.draggable = true;
    item.dataset.row = rowId;
    item.innerHTML = `<span class="drag-handle"><i data-lucide="grip-vertical"></i></span><label><input type="checkbox" ${state.visibleRows.has(rowId) ? 'checked' : ''}> ${labels[rowId]}</label>`;

    item.querySelector('input').addEventListener('change', e => {
      if (e.target.checked) state.visibleRows.add(rowId);
      else                  state.visibleRows.delete(rowId);
      if (state.currentTemplate === 'scale-chords') buildScaleChordsBoard();
    });

    item.addEventListener('dragstart', e => {
      dragSrc = item;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => item.classList.add('dragging'), 0);
    });
    item.addEventListener('dragend', () => {
      rowsConfigDropdown.querySelectorAll('.row-config-item').forEach(i => i.classList.remove('dragging', 'drag-over'));
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      rowsConfigDropdown.querySelectorAll('.row-config-item').forEach(i => i.classList.remove('drag-over'));
      if (item !== dragSrc) item.classList.add('drag-over');
    });
    item.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragSrc || dragSrc === item) return;
      const from = state.rowOrder.indexOf(dragSrc.dataset.row);
      const to   = state.rowOrder.indexOf(rowId);
      state.rowOrder.splice(from, 1);
      state.rowOrder.splice(to, 0, dragSrc.dataset.row);
      renderRowsDropdown();
      if (state.currentTemplate === 'scale-chords') buildScaleChordsBoard();
    });

    rowsConfigDropdown.appendChild(item);
  });

  // Combine major/minor separator + toggle
  const sep = document.createElement('div');
  sep.style.cssText = 'border-top:1px solid rgba(255,255,255,0.1);margin:6px 0';
  rowsConfigDropdown.appendChild(sep);

  const combineItem = document.createElement('div');
  combineItem.className = 'row-config-item';
  combineItem.innerHTML = `<label style="color:rgba(255,255,255,0.55)"><input type="checkbox" id="combine-parallel-cb" ${state.combineParallel ? 'checked' : ''}> Major + Minor</label>`;
  combineItem.querySelector('input').addEventListener('change', e => {
    state.combineParallel = e.target.checked;
    if (state.currentTemplate === 'scale-chords') buildScaleChordsBoard();
  });
  rowsConfigDropdown.appendChild(combineItem);
}

rowsConfigBtn.addEventListener('click', e => {
  e.stopPropagation();
  const isOpen = rowsConfigDropdown.classList.toggle('open');
  if (isOpen) {
    const r = rowsConfigBtn.getBoundingClientRect();
    rowsConfigDropdown.style.top  = (r.bottom + 6) + 'px';
    rowsConfigDropdown.style.right = (window.innerWidth - r.right) + 'px';
  }
});
document.addEventListener('click', () => rowsConfigDropdown.classList.remove('open'));
rowsConfigDropdown.addEventListener('click', e => e.stopPropagation());

renderRowsDropdown();

// ============================================================
// CONTROLS
// ============================================================
function updateControlDisplays() {
  document.getElementById('ctrl-oct').textContent = state.octave;
}

// (Out-port dropdown removed — port selection is now per-track / per-chord-pad
// in their FX modals. state.output is set in refreshOutputs() as the fallback.)
// (In-port dropdown removed — MIDI input is configured per-track.)
document.getElementById('oct-down').addEventListener('click', () => {
  state.octave = Math.max(0, state.octave - 1); updateControlDisplays(); rebuildBoard();
});
document.getElementById('oct-up').addEventListener('click', () => {
  state.octave = Math.min(8, state.octave + 1); updateControlDisplays(); rebuildBoard();
});

// Which voice the Instrument panel is editing: chord-pad ('pad') or one
// of the sequencer tracks. Reads/writes route to the corresponding synth
// config + instrument slot.
state.synthEditTarget = 'pad';
function editTargetSynth() {
  return state.synthEditTarget === 'pad' ? state.synth : SEQ.tracks[state.synthEditTarget].synth;
}
function editTargetInstrument() {
  return state.synthEditTarget === 'pad' ? state.instrument : SEQ.tracks[state.synthEditTarget].instrument;
}
function setEditTargetInstrument(v) {
  if (state.synthEditTarget === 'pad') state.instrument = v;
  else SEQ.tracks[state.synthEditTarget].instrument = v;
}

document.getElementById('synth-waveform').addEventListener('change', (e) => {
  editTargetSynth().waveform = e.target.value;
});
function updateSynthOnlyVisibility() {
  const isSynth = editTargetInstrument() === 'synth';
  document.querySelectorAll('.synth-param.synth-only').forEach(el => {
    el.classList.toggle('visible', isSynth);
  });
}

document.getElementById('synth-instrument').addEventListener('change', async (e) => {
  const prev = editTargetInstrument();
  const next = e.target.value;
  savedPresets[prev] = { ...editTargetSynth() };
  setEditTargetInstrument(next);
  // Drop any ADSR/Filter overrides when switching instrument so the new
  // preset shows up unmodified until the user touches a slider again.
  editTargetSynth()._override = {};
  updateSynthOnlyVisibility();
  // Chord-pad voice == chords track. Keep the track header dropdown in sync.
  if (state.synthEditTarget === 'pad') {
    const chordHdr = document.querySelector('.seq-track-label[data-track="chords"] .seq-th-inst');
    if (chordHdr) chordHdr.value = next;
  }
  if (next !== 'synth') {
    // Generic baseline first so any slider missing from a more specific
    // source still has a value.
    const baseline = INSTRUMENT_PRESETS[next] || INSTRUMENT_PRESETS.default;
    if (baseline) applySynthPreset(baseline);
    if (INSTRUMENT_TO_SF2[next] != null) {
      await loadSf2('fluid');
      const fluid = SF2_FILES.fluid.sf2;
      if (fluid) prewarmSf2Preset(fluid, INSTRUMENT_TO_SF2[next]);
      // Read the SF2's own envelope/filter generators and reflect them
      // on the sliders — knobs now mirror what the instrument actually
      // plays (overrides were already cleared above so nothing stacks).
      const sf2Defs = fluid ? readSf2Defaults(fluid, INSTRUMENT_TO_SF2[next]) : null;
      if (sf2Defs) applySynthPreset(sf2Defs);
    } else {
      await preloadSamples(next);
    }
  } else if (savedPresets.synth) {
    applySynthPreset(savedPresets.synth);
  }
});
updateSynthOnlyVisibility();

function setSynthEditTarget(target) {
  state.synthEditTarget = target;
  document.querySelectorAll('.synth-target-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.target === target);
  });
  // Reflect the target's instrument in the dropdown (no-op for waveform if
  // not synth) and seed all sliders from the target's stored synth values.
  const inst = editTargetInstrument();
  const dd   = document.getElementById('synth-instrument');
  if (dd) dd.value = inst;
  const wf = document.getElementById('synth-waveform');
  if (wf && editTargetSynth().waveform) wf.value = editTargetSynth().waveform;
  applySynthPreset(editTargetSynth());
  updateSynthOnlyVisibility();
}
document.querySelectorAll('.synth-target-btn').forEach(btn => {
  btn.addEventListener('click', () => setSynthEditTarget(btn.dataset.target));
});
// Chord-pad settings modal — opens via the gear-icon tab next to the
// harmony/library tabs. Same modal pattern as track-fx-modal.
(function _initChordPadModal() {
  const modal = document.getElementById('chord-pad-modal');
  const btn   = document.getElementById('chord-pad-settings-btn');
  const close = document.getElementById('chord-pad-modal-close');
  const backdrop = modal?.querySelector('[data-close-cp-modal]');
  if (!modal || !btn) return;
  const outToggle = modal.querySelector('.cp-modal-output-toggle');
  const chWrap    = modal.querySelector('.cp-modal-ch-inline');
  const chInp     = document.getElementById('cp-modal-channel');
  const instPicker = document.getElementById('cp-modal-inst-picker');
  const knobsEl   = document.getElementById('cp-modal-knobs');
  const instRow   = modal.querySelector('.cp-modal-inst-row');
  const soundRow  = modal.querySelector('.cp-modal-sound-row');

  // Build the categorized GM instrument dropdown — same DOM structure as
  // the track-fx modal so all the existing .track-fx-inst-* styles apply.
  function buildInstrumentPicker() {
    if (!instPicker) return;
    instPicker.innerHTML = `
      <button type="button" class="track-fx-inst-btn">
        <span class="track-fx-inst-label">${escapeHtml(instrumentDisplayName(state.instrument))}</span>
        <span class="track-fx-inst-chev">▾</span>
      </button>
      <div class="track-fx-inst-menu" hidden>
        <button type="button" class="track-fx-inst-item" data-inst="synth">
          <span class="track-fx-inst-item-name">Synth</span>
        </button>
        ${GM_CATEGORIES.map(cat => `
          <div class="track-fx-inst-cat">
            <button type="button" class="track-fx-inst-cat-btn">
              <span>${escapeHtml(cat.name)}</span>
              <span class="track-fx-inst-cat-chev">›</span>
            </button>
            <div class="track-fx-inst-submenu" hidden>
              ${cat.presets.map(p => {
                const id = SF2_PRESET_TO_SHORT[p.n] || ('gm' + p.n);
                return `<button type="button" class="track-fx-inst-item" data-inst="${id}">
                  <span class="track-fx-inst-item-name">${escapeHtml(p.name)}</span>
                </button>`;
              }).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `;
    const instBtn   = instPicker.querySelector('.track-fx-inst-btn');
    const instMenu  = instPicker.querySelector('.track-fx-inst-menu');
    const instLabel = instPicker.querySelector('.track-fx-inst-label');
    const closeMenu = () => {
      instMenu.hidden = true;
      document.querySelectorAll('.track-fx-inst-submenu').forEach(sm => sm.hidden = true);
    };
    instBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      instMenu.hidden = !instMenu.hidden;
      if (instMenu.hidden) { closeMenu(); return; }
      // Mark current selection.
      document.querySelectorAll('.track-fx-inst-item.selected').forEach(el => el.classList.remove('selected'));
      document.querySelectorAll(`.track-fx-inst-item[data-inst="${state.instrument}"]`).forEach(el => el.classList.add('selected'));
      const curItem = document.querySelector(`.track-fx-inst-item[data-inst="${state.instrument}"]`);
      if (curItem) {
        let ownerCat = curItem.closest('.track-fx-inst-cat');
        if (!ownerCat) {
          instMenu.querySelectorAll('.track-fx-inst-cat').forEach(c => {
            if (c._submenu && c._submenu.contains(curItem)) ownerCat = c;
          });
        }
        if (ownerCat) {
          ownerCat.scrollIntoView({ block: 'nearest' });
          const subm = ownerCat._submenu;
          if (subm) {
            hideOtherSubmenus(subm);
            positionSubmenu(ownerCat, subm);
            subm.hidden = false;
            curItem.scrollIntoView({ block: 'nearest' });
          }
        } else {
          curItem.scrollIntoView({ block: 'nearest' });
        }
      }
    });
    const positionSubmenu = (catEl, submenu) => {
      if (submenu.parentElement !== document.body) document.body.appendChild(submenu);
      const menuRect = instMenu.getBoundingClientRect();
      const catRect  = catEl.getBoundingClientRect();
      const subW = 170;
      let left = menuRect.right + 2;
      if (left + subW > window.innerWidth - 8) {
        left = Math.max(8, menuRect.left - subW - 2);
      }
      submenu.style.left = left + 'px';
      submenu.style.top  = catRect.top + 'px';
    };
    instMenu.querySelectorAll('.track-fx-inst-cat').forEach(cat => {
      cat._submenu = cat.querySelector('.track-fx-inst-submenu');
    });
    const hideOtherSubmenus = (keep) => {
      document.querySelectorAll('.track-fx-inst-submenu').forEach(sm => {
        if (sm !== keep) sm.hidden = true;
      });
    };
    instMenu.querySelectorAll(':scope > .track-fx-inst-item').forEach(item => {
      item.addEventListener('mouseenter', () => hideOtherSubmenus(null));
    });
    instMenu.querySelectorAll('.track-fx-inst-cat-btn').forEach(btn => {
      const cat = btn.closest('.track-fx-inst-cat');
      const submenu = cat._submenu;
      cat.addEventListener('mouseenter', () => {
        hideOtherSubmenus(submenu);
        positionSubmenu(cat, submenu);
        submenu.hidden = false;
      });
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (submenu.hidden) { hideOtherSubmenus(submenu); positionSubmenu(cat, submenu); submenu.hidden = false; }
        else submenu.hidden = true;
      });
      submenu.addEventListener('mouseenter', () => { hideOtherSubmenus(submenu); submenu.hidden = false; });
    });
    instMenu.addEventListener('mouseleave', () => {
      setTimeout(() => {
        document.querySelectorAll('.track-fx-inst-submenu').forEach(sm => {
          if (!sm.matches(':hover')) sm.hidden = true;
        });
      }, 100);
    });
    setTimeout(() => {
      document.addEventListener('mousedown', function _outside(ev) {
        const inSubmenu = ev.target.closest && ev.target.closest('.track-fx-inst-submenu');
        if (!instPicker.contains(ev.target) && !inSubmenu) {
          closeMenu();
          document.removeEventListener('mousedown', _outside);
        }
      });
    }, 0);
    instMenu.querySelectorAll('.track-fx-inst-item').forEach(item => {
      item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeMenu();
        const nextInst = item.dataset.inst;
        instLabel.textContent = item.querySelector('.track-fx-inst-item-name').textContent;
        // Hand the change off to the existing #synth-instrument change
        // handler so sample-loading + state.synth reset run as usual.
        const sel = document.getElementById('synth-instrument');
        if (sel) {
          // The hidden select may not have an option for every GM short-id;
          // add one on the fly so .value = nextInst sticks.
          if (!Array.from(sel.options).some(o => o.value === nextInst)) {
            const opt = document.createElement('option');
            opt.value = nextInst;
            opt.textContent = instrumentDisplayName(nextInst);
            sel.appendChild(opt);
          }
          sel.value = nextInst;
          sel.dispatchEvent(new Event('change'));
        } else {
          state.instrument = nextInst;
        }
        rebuildSound();
      });
    });
  }
  const portRow   = modal.querySelector('.cp-modal-port-row');
  const portSel   = document.getElementById('cp-modal-port');
  function rebuildPortList() {
    if (!portSel) return;
    const ports = state.midiAccess ? Array.from(state.midiAccess.outputs.values()) : [];
    portSel.innerHTML = '<option value="">— default —</option>'
      + ports.map(p => `<option value="${p.id}"${p.id === (state.padMidiPortId || '') ? ' selected' : ''}>${p.name}</option>`).join('');
  }
  portSel?.addEventListener('change', () => {
    state.padMidiPortId = portSel.value;
    seqSave();
  });
  // Refresh port list when devices come/go (e.g. starting loopMIDI mid-session).
  document.addEventListener('chordpad:midi-ports-changed', () => {
    if (!modal.hidden) rebuildPortList();
    // Also re-render the per-track FX modal if it's open — its port lists
    // are built once inside openTrackFxModal so the easiest refresh is a
    // full rebuild keyed off the visible track.
    const tfx = document.getElementById('track-fx-modal');
    if (tfx && !tfx.hidden) {
      const id = tfx.dataset.trackId;
      const trk = id ? trackById(id) : null;
      if (trk) openTrackFxModal(trk);
    }
  });

  // Build one sound-param knob bound to state.synth. Mirrors the per-track
  // makeFxKnob but uses the chord-pad's global state.synth.
  function makeCpKnob(key) {
    const fieldMap = Object.fromEntries(TRACK_FX_FIELDS.map(f => [f[0], f]));
    const [, label, min, max, curve, fmt, synthOnly, sync] = fieldMap[key];
    const cur = (state.synth[key] !== undefined) ? state.synth[key] : min;
    const cell = document.createElement('div');
    cell.className = 'track-fx-knob-cell';
    const overridable = OVERRIDE_KEYS.has(key);
    const knobTitle = overridable ? 'Double-click to clear override' : '';
    cell.innerHTML = `
      <span class="track-fx-knob-val">${fmt(cur)}</span>
      <span class="track-fx-knob"${knobTitle ? ` title="${knobTitle}"` : ''}><span class="track-fx-knob-ind"></span></span>
      <span class="track-fx-knob-label">${label.replace(/ /g, '<br>')}${sync ? '<button class="track-fx-sync" title="Snap to tempo"><i data-lucide="refresh-cw"></i></button>' : ''}</span>
    `;
    const knob  = cell.querySelector('.track-fx-knob');
    const valEl = cell.querySelector('.track-fx-knob-val');
    const apply = (v) => {
      v = Math.max(min, Math.min(max, v));
      state.synth[key] = v;
      valEl.textContent = fmt(v);
      const norm = Math.pow((v - min) / (max - min || 1), 1 / curve);
      knob.style.setProperty('--ang', (-135 + norm * 270) + 'deg');
      if (overridable) {
        const isSf2 = INSTRUMENT_TO_SF2?.[state.instrument] != null;
        cell.classList.toggle('is-override', !!(isSf2 && state.synth._override?.[key]));
      }
    };
    const setOverride = (on) => {
      if (!overridable) return;
      if (!state.synth._override) state.synth._override = {};
      if (on) state.synth._override[key] = true;
      else delete state.synth._override[key];
    };
    apply(cur);
    knob.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      knob.setPointerCapture(e.pointerId);
      const startX = e.clientX, startY = e.clientY;
      const startNorm = Math.pow((state.synth[key] - min) / (max - min || 1), 1 / curve);
      setOverride(true);
      const onMove = (ev) => {
        const speed = ev.shiftKey ? 4 : 1;
        const delta = ((startY - ev.clientY) + (ev.clientX - startX)) / speed;
        const norm  = Math.max(0, Math.min(1, startNorm + delta / 200));
        apply(min + (max - min) * Math.pow(norm, curve));
      };
      const onUp = () => {
        knob.removeEventListener('pointermove', onMove);
        knob.removeEventListener('pointerup', onUp);
      };
      knob.addEventListener('pointermove', onMove);
      knob.addEventListener('pointerup', onUp);
    });
    knob.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      setOverride(false);
      const preset = INSTRUMENT_PRESETS?.[state.instrument];
      if (preset?.[key] === undefined) return;
      apply(preset[key]);
    });
    knob.addEventListener('wheel', (e) => {
      e.preventDefault();
      setOverride(true);
      const norm = Math.pow((state.synth[key] - min) / (max - min || 1), 1 / curve);
      const step = e.shiftKey ? 0.005 : 0.02;
      const next = Math.max(0, Math.min(1, norm - Math.sign(e.deltaY) * step));
      apply(min + (max - min) * Math.pow(next, curve));
    }, { passive: false });
    if (sync) {
      cell.querySelector('.track-fx-sync')?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        apply(fxTempoSnap(sync, state.synth[key]));
      });
    }
    return { cell, key, synthOnly };
  }

  function rebuildSound() {
    if (!knobsEl) return;
    knobsEl.innerHTML = '';
    const isSynth = state.instrument === 'synth';
    // Show waveform picker only for the synth voice.
    const wfRow = document.getElementById('cp-modal-waveform-row');
    const wfSel = document.getElementById('cp-modal-waveform');
    if (wfRow) wfRow.style.display = isSynth ? '' : 'none';
    if (wfSel && isSynth) {
      wfSel.value = state.synth.waveform || 'sine';
      if (!wfSel.dataset.bound) {
        wfSel.dataset.bound = '1';
        wfSel.addEventListener('change', () => {
          state.synth.waveform = wfSel.value;
          // Mirror the change to the hidden #synth-waveform if present.
          const sw = document.getElementById('synth-waveform');
          if (sw) { sw.value = wfSel.value; sw.dispatchEvent(new Event('change')); }
        });
      }
    }
    let _fxHdrInserted = false;
    for (const [key, , , , , , synthOnly] of TRACK_FX_FIELDS) {
      if (synthOnly && !isSynth) continue;
      if (!_fxHdrInserted && (key === 'delayWet' || key === 'reverb')) {
        const hdr = document.createElement('div');
        hdr.className = 'cp-modal-fx-divider';
        hdr.textContent = 'Send FX';
        knobsEl.appendChild(hdr);
        _fxHdrInserted = true;
      }
      knobsEl.appendChild(makeCpKnob(key).cell);
    }
    const rb = document.getElementById('cp-modal-reset');
    if (rb) rb.textContent = `Reset to ${instrumentDisplayName(state.instrument)} defaults`;
    refreshLucide();
  }
  function syncOutput() {
    if (!outToggle) return;
    outToggle.querySelectorAll('.track-fx-out-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.out === state.padOutput);
    });
    const midi = state.padOutput === 'midi';
    // The .hidden class wins over inline display because of CSS specificity;
    // toggle the class explicitly so the channel input actually shows in
    // MIDI mode.
    if (chWrap) chWrap.classList.toggle('hidden', !midi);
    if (chInp)  chInp.value = String((state.padChannel ?? 0) + 1);
    if (portRow) portRow.classList.toggle('hidden', !midi);
    if (instRow)  instRow.style.display  = midi ? 'none' : '';
    if (soundRow) soundRow.style.display = midi ? 'none' : '';
    const wfRow    = document.getElementById('cp-modal-waveform-row');
    const resetRow = document.getElementById('cp-modal-reset-row');
    if (wfRow)    wfRow.style.display    = (midi || state.instrument !== 'synth') ? 'none' : '';
    if (resetRow) resetRow.style.display = midi ? 'none' : '';
  }
  outToggle?.querySelectorAll('.track-fx-out-btn').forEach(b => {
    b.addEventListener('click', () => {
      if (b.dataset.out === state.padOutput) return;
      state.padOutput = b.dataset.out;
      syncOutput();
      seqSave();
      // Mirror to the synth-controls panel toggle if present.
      document.querySelectorAll('.synth-output-toggle .track-fx-out-btn').forEach(s => {
        s.classList.toggle('active', s.dataset.out === state.padOutput);
      });
    });
  });
  chInp?.addEventListener('change', () => {
    const v = Math.max(1, Math.min(16, parseInt(chInp.value, 10) || 1));
    chInp.value = v;
    state.padChannel = v - 1;
    seqSave();
  });
  // Reset-to-preset wiring (one-time).
  const resetBtn = document.getElementById('cp-modal-reset');
  if (resetBtn && !resetBtn.dataset.bound) {
    resetBtn.dataset.bound = '1';
    resetBtn.addEventListener('click', () => {
      const preset = INSTRUMENT_PRESETS?.[state.instrument] || INSTRUMENT_PRESETS?.default;
      if (!preset) return;
      state.synth._override = {};
      // Reset state.synth params; mirror through the existing
      // applySynthPreset which also updates the hidden synth-* inputs.
      applySynthPreset(preset);
      if (state.instrument === 'synth' && preset.waveform) {
        state.synth.waveform = preset.waveform;
        const wfSel = document.getElementById('cp-modal-waveform');
        if (wfSel) wfSel.value = preset.waveform;
      }
      rebuildSound();
    });
  }

  const open = () => {
    buildInstrumentPicker();
    rebuildPortList();
    syncOutput();
    rebuildSound();
    // Update reset-button label to reflect current instrument.
    if (resetBtn) resetBtn.textContent = `Reset to ${instrumentDisplayName(state.instrument)} defaults`;
    modal.hidden = false;
    refreshLucide();
  };
  const shut = () => { modal.hidden = true; };
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); open(); });
  close?.addEventListener('click', shut);
  backdrop?.addEventListener('click', shut);
  document.addEventListener('keydown', (e) => {
    if (!modal.hidden && e.key === 'Escape') shut();
  });
})();

// Chord-pad Output toggle (Instrument | MIDI) + Channel input. Mirrors the
// per-track output toggle. State persisted via the same SEQ_KEY blob below.
(function _initPadOutputToggle() {
  const row    = document.getElementById('synth-output-row');
  if (!row) return;
  const toggle = row.querySelector('.synth-output-toggle');
  const chWrap = row.querySelector('.synth-ch-inline');
  const chInp  = document.getElementById('pad-channel');
  const sync = () => {
    toggle.querySelectorAll('.track-fx-out-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.out === state.padOutput);
    });
    chWrap?.classList.toggle('hidden', state.padOutput !== 'midi');
    if (chInp) chInp.value = String((state.padChannel ?? 0) + 1);
  };
  sync();
  toggle.querySelectorAll('.track-fx-out-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.out;
      if (next === state.padOutput) return;
      state.padOutput = next;
      sync();
      seqSave();
    });
  });
  chInp?.addEventListener('change', () => {
    const v = Math.max(1, Math.min(16, parseInt(chInp.value, 10) || 1));
    chInp.value = v;
    state.padChannel = v - 1;
    seqSave();
  });
})();


(function _initSectionToggles() {
  const KEY = 'chordpad.hiddenSections';
  let hidden = {};
  try { hidden = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { hidden = {}; }
  // The "settings" section behaves as a popover (gear → dropdown), not an
  // inline panel like the others. Default it to hidden so the popover is
  // closed on load.
  if (hidden.settings === undefined) hidden.settings = true;
  const apply = () => {
    Object.entries(hidden).forEach(([sec, hide]) => {
      document.body.classList.toggle('hide-' + sec, !!hide);
    });
    document.querySelectorAll('.header-section-toggle[data-section]').forEach(btn => {
      const sec = btn.dataset.section;
      btn.classList.toggle('active', !hidden[sec]);
    });
    // Position the settings popover under its gear button each time it opens.
    const setBtn  = document.querySelector('.header-section-toggle[data-section="settings"]');
    const setPan  = document.getElementById('settings-panel');
    if (setBtn && setPan && !hidden.settings) {
      const r = setBtn.getBoundingClientRect();
      setPan.style.top  = (r.bottom + 4) + 'px';
      setPan.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    }
  };
  apply();
  document.querySelectorAll('.header-section-toggle[data-section]').forEach(btn => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (ev) => {
      const sec = btn.dataset.section;
      hidden[sec] = !hidden[sec];
      apply();
      try { localStorage.setItem(KEY, JSON.stringify(hidden)); } catch (_) {}
      if (sec === 'settings' && !hidden.settings) ev.stopPropagation();
    });
  });
  // Compact floating toolbar — mirrors the header section toggles so the
  // user can flip panels without scrolling back up. Built once from the
  // existing buttons; active-state is synced via apply() below.
  (function _initSectionMiniToolbar() {
    const mini = document.getElementById('section-mini-toolbar');
    const header = document.querySelector('header.header');
    if (!mini || !header) return;
    document.querySelectorAll('.header-section-toggle[data-section]').forEach(src => {
      const clone = src.cloneNode(true);
      clone.removeAttribute('id');
      clone.classList.remove('header-section-toggle');
      clone.addEventListener('mousedown', (e) => e.preventDefault());
      clone.addEventListener('click', (ev) => {
        ev.stopPropagation();
        src.click();
      });
      mini.appendChild(clone);
    });
    const syncActive = () => {
      document.querySelectorAll('.header-section-toggle[data-section]').forEach((src, i) => {
        const tgt = mini.children[i];
        if (tgt) tgt.classList.toggle('active', src.classList.contains('active'));
      });
    };
    // The header toggle handler above swaps `.active` synchronously, so a
    // MutationObserver keeps the mirror in sync without polling.
    const obs = new MutationObserver(syncActive);
    document.querySelectorAll('.header-section-toggle[data-section]').forEach(src =>
      obs.observe(src, { attributes: true, attributeFilter: ['class'] })
    );
    syncActive();
    // Visibility — show once the header scrolls past the top of the
    // viewport. Use rAF throttling so the scroll handler is cheap.
    let scheduled = false;
    const update = () => {
      scheduled = false;
      const r = header.getBoundingClientRect();
      mini.classList.toggle('visible', r.bottom <= 4);
    };
    window.addEventListener('scroll', () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(update);
    }, { passive: true });
    update();
    if (typeof refreshLucide === 'function') refreshLucide();
  })();
  // Click outside the settings popover closes it (only when open).
  document.addEventListener('mousedown', (ev) => {
    if (hidden.settings) return;
    const pan = document.getElementById('settings-panel');
    const btn = document.querySelector('.header-section-toggle[data-section="settings"]');
    if (!pan || !btn) return;
    if (pan.contains(ev.target) || btn.contains(ev.target)) return;
    hidden.settings = true;
    apply();
    try { localStorage.setItem(KEY, JSON.stringify(hidden)); } catch (_) {}
  });
})();

// Reset Chord Pad: triple-click the brand logo. Three clicks within 600ms
// total opens a custom-styled confirm dialog (same component as deleteTrack)
// — protects against accidental triggers while staying discoverable via the
// title tooltip.
(function _initLogoReset() {
  const brand = document.getElementById('brand-logo');
  if (!brand) return;
  let clicks = 0;
  let timer = null;
  brand.addEventListener('click', () => {
    clicks += 1;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { clicks = 0; }, 600);
    if (clicks < 3) return;
    clicks = 0;
    showConfirm({
      title: 'Reset Chord Pad',
      message: 'This clears all saved state — tracks, settings, everything. Cannot be undone.',
      confirmLabel: 'Reset',
      danger: true,
      onConfirm: () => {
        try { localStorage.clear(); } catch (_) {}
        const url = new URL(window.location.href);
        url.searchParams.set('_t', Date.now().toString());
        window.location.replace(url.toString());
      },
    });
  });
})();
// Volume-balance toggle: per-GM-category makeup gain so e.g. bass isn't
// drowned out by piano. Persisted via seqSave().
(function _initVolBalance() {
  const btn = document.getElementById('vol-balance-toggle');
  if (!btn) return;
  const sync = () => {
    const on = !!state.volumeBalance;
    btn.classList.toggle('active', on);
    btn.textContent = on ? 'ON' : 'OFF';
  };
  sync();
  btn.addEventListener('click', () => {
    state.volumeBalance = !state.volumeBalance;
    sync();
    if (typeof seqSave === 'function') seqSave();
  });
  setTimeout(sync, 0);
})();
// Voicing has TWO selects: one in the cp-modal sound panel and one
// inline in the tab row for quick access. Keep them in sync.
const _voicingSelects = [
  document.getElementById('voicing-select'),
  document.getElementById('tab-voicing-select'),
].filter(Boolean);
_voicingSelects.forEach(sel => {
  sel.value = state.voicing;
  sel.addEventListener('change', () => {
    state.voicing = sel.value;
    _voicingSelects.forEach(s => { if (s !== sel) s.value = state.voicing; });
    if (typeof seqSave === 'function') seqSave();
  });
});
const sustainBtn = document.getElementById('sustain-toggle');
sustainBtn.addEventListener('click', () => {
  state.sustain = !state.sustain;
  sustainBtn.textContent = state.sustain ? 'ON' : 'OFF';
  sustainBtn.classList.toggle('active', state.sustain);
  if (!state.sustain) releaseAll();
});

const audioToggleBtn = document.getElementById('audio-toggle');
audioToggleBtn.addEventListener('click', () => {
  state.audioEnabled = !state.audioEnabled;
  audioToggleBtn.textContent = state.audioEnabled ? 'ON' : 'OFF';
  audioToggleBtn.classList.toggle('active', state.audioEnabled);
});

const audioVolumeLabel  = document.getElementById('audio-volume-val');
(function _initMasterVolKnob() {
  const knob = document.getElementById('master-vol-knob');
  if (!knob) return;
  const VOL_MIN = 0, VOL_MAX = 2; // 0%–200%
  const apply = (v) => {
    v = Math.max(VOL_MIN, Math.min(VOL_MAX, v));
    state.audioVolume = v;
    if (audioVolumeLabel) audioVolumeLabel.textContent = Math.round(v * 100) + '%';
    const frac = (v - VOL_MIN) / (VOL_MAX - VOL_MIN);
    knob.style.setProperty('--ang', (-135 + frac * 270) + 'deg');
  };
  apply(state.audioVolume);
  knob.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    knob.setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const startV = state.audioVolume;
    const onMove = (ev) => {
      const speed = ev.shiftKey ? 4 : 1;
      const delta = ((startY - ev.clientY) + (ev.clientX - startX)) / speed;
      apply(startV + (delta / 200) * (VOL_MAX - VOL_MIN));
    };
    const onUp = () => {
      knob.removeEventListener('pointermove', onMove);
      knob.removeEventListener('pointerup', onUp);
    };
    knob.addEventListener('pointermove', onMove);
    knob.addEventListener('pointerup', onUp);
  });
  knob.addEventListener('dblclick', () => apply(1.0));
  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = e.shiftKey ? 0.01 : 0.05;
    apply(state.audioVolume - Math.sign(e.deltaY) * step);
  }, { passive: false });
})();


const scaleTonesToggleBtn = document.getElementById('scale-tones-toggle');
scaleTonesToggleBtn.addEventListener('click', () => {
  state.showScaleTones = !state.showScaleTones;
  scaleTonesToggleBtn.textContent = state.showScaleTones ? 'ON' : 'OFF';
  scaleTonesToggleBtn.classList.toggle('active', state.showScaleTones);
});

const pianoHoverToggleBtn = document.getElementById('piano-hover-toggle');
const scaleTonesControl = document.getElementById('scale-tones-control');
pianoHoverToggleBtn.addEventListener('click', () => {
  state.showPianoHover = !state.showPianoHover;
  pianoHoverToggleBtn.textContent = state.showPianoHover ? 'ON' : 'OFF';
  pianoHoverToggleBtn.classList.toggle('active', state.showPianoHover);
  scaleTonesControl.style.display = state.showPianoHover ? '' : 'none';
});

const bassToggleBtn = document.getElementById('bass-toggle');
bassToggleBtn.addEventListener('click', () => {
  state.bassEnabled = !state.bassEnabled;
  bassToggleBtn.textContent = state.bassEnabled ? 'ON' : 'OFF';
  bassToggleBtn.classList.toggle('active', state.bassEnabled);
});
document.getElementById('bass-oct-down').addEventListener('click', () => {
  if (state.bassOctave <= 1) return;
  state.bassOctave--;
  document.getElementById('ctrl-bass-oct').textContent = state.bassOctave;
});
document.getElementById('bass-oct-up').addEventListener('click', () => {
  if (state.bassOctave >= 4) return;
  state.bassOctave++;
  document.getElementById('ctrl-bass-oct').textContent = state.bassOctave;
});

// ============================================================
// SYNTH SLIDERS
// ============================================================
function sliderToAttack(v)   { return 0.002 + Math.pow(v / 100, 2.5) * 0.998; } // 2ms–1s
function sliderToRelease(v)  { return 0.05  + Math.pow(v / 100, 2)   * 3.95;  } // 50ms–4s
function sliderToTone(v)     { return 200   * Math.pow(60, v / 100);           } // 200Hz–12kHz log
function sliderToRes(v)      { return 0.1   + Math.pow(v / 100, 1.8) * 9.9;   } // 0.1–10
function sliderToDecay(v)   { return 0.05 + Math.pow(v / 100, 2) * 2.95; } // 50ms–3s
function sliderToSustain(v) { return v / 100; }
function sliderToOvertones(v){ return v / 100; }
function sliderToReverb(v)    { return v / 100; }
function sliderToDetune(v)    { return v * 0.3; }
function sliderToVibratoRate(v) { return 0.5 + v / 100 * 9.5; }
function sliderToVibratoDepth(v){ return v * 0.5; }
function sliderToTremoloRate(v) { return 0.5 + v / 100 * 9.5; }
function sliderToTremoloDepth(v){ return v / 100; }
function sliderToDelayTime(v)   { return 0.05 + v / 100 * 0.95; }
function sliderToDelayFeedback(v){ return v / 100 * 0.85; }
function sliderToDelayWet(v)    { return v / 100; }
function sliderToFilterLfo(v)   { return v / 100 * 800; }

// Inverse slider mappings (value → slider position 0-100)
function invAttack(v)    { return Math.round(100 * Math.pow(Math.max(0,(v-0.002)/0.998), 1/2.5)); }
function invDecay(v)     { return Math.round(100 * Math.pow(Math.max(0,(v-0.05)/2.95),   0.5)); }
function invSustain(v)   { return Math.round(v * 100); }
function invRelease(v)   { return Math.round(100 * Math.pow(Math.max(0,(v-0.05)/3.95),   0.5)); }
function invTone(v)      { return Math.round(100 * Math.log(v/200) / Math.log(60)); }
function invRes(v)       { return Math.round(100 * Math.pow(Math.max(0,(v-0.1)/9.9), 1/1.8)); }
function invOvertones(v) { return Math.round(v * 100); }
function invReverb(v)    { return Math.round(v * 100); }
function invDetune(v)    { return Math.round(v / 0.3); }
function invVibRate(v)   { return Math.round((v-0.5)/9.5*100); }
function invVibDepth(v)  { return Math.round(v / 0.5); }
function invTremRate(v)  { return Math.round((v-0.5)/9.5*100); }
function invTremDepth(v) { return Math.round(v * 100); }
function invDlyTime(v)   { return Math.round((v-0.05)/0.95*100); }
function invDlyFb(v)     { return Math.round(v/0.85*100); }
function invDlyWet(v)    { return Math.round(v * 100); }
function invFlfo(v)      { return Math.round(v / 8); }

const INSTRUMENT_PRESETS = {
  // Neutral fallback for GM presets that don't ship with their own entry.
  // All app-level effects (tremolo, vibrato, delay, filter-LFO) are zero so
  // we don't accidentally smother an instrument in a Rhodes-style wobble.
  default: { attack:0.01,  decay:0.4,  sustain:0.7,  release:0.4,  filterFreq:8000, filterQ:0.5, overtones:0.2, reverb:0.3,  detune:0, vibratoRate:5, vibratoDepth:0, tremoloRate:4, tremoloDepth:0,    delayTime:0.3, delayFeedback:0.3, delayWet:0, filterLfoDepth:0, waveform:'sine' },
  piano:   { attack:0.005, decay:0.8,  sustain:0.2,  release:2.0,  filterFreq:5000, filterQ:0.5, overtones:0.2, reverb:0.4,  detune:0, vibratoRate:5, vibratoDepth:0, tremoloRate:4, tremoloDepth:0,    delayTime:0.3, delayFeedback:0.3, delayWet:0, filterLfoDepth:0, waveform:'sine' },
  epiano:  { attack:0.004, decay:1.8,  sustain:0.28, release:0.9,  filterFreq:3800, filterQ:0.9, overtones:0.2, reverb:0.30, detune:0, vibratoRate:5, vibratoDepth:0, tremoloRate:4, tremoloDepth:0.35, delayTime:0.3, delayFeedback:0.3, delayWet:0, filterLfoDepth:0, waveform:'sine' },
  epiano2: { attack:0.008, decay:0.4,  sustain:0.4,  release:1.2,  filterFreq:3500, filterQ:1.0, overtones:0.2, reverb:0.3,  detune:0, vibratoRate:5, vibratoDepth:0, tremoloRate:4, tremoloDepth:0,    delayTime:0.3, delayFeedback:0.3, delayWet:0, filterLfoDepth:0, waveform:'sine' },
  organ:   { attack:0.02,  decay:0.1,  sustain:0.9,  release:0.08, filterFreq:4000, filterQ:0.5, overtones:0.2, reverb:0.3,  detune:0, vibratoRate:5, vibratoDepth:0, tremoloRate:6, tremoloDepth:0.1,  delayTime:0.3, delayFeedback:0.3, delayWet:0, filterLfoDepth:0, waveform:'sine' },
  strings: { attack:0.4,   decay:0.3,  sustain:0.8,  release:1.5,  filterFreq:3000, filterQ:1.0, overtones:0.2, reverb:0.6,  detune:0, vibratoRate:5, vibratoDepth:0, tremoloRate:4, tremoloDepth:0,    delayTime:0.3, delayFeedback:0.3, delayWet:0, filterLfoDepth:0, waveform:'sine' },
  choir:   { attack:0.35,  decay:0.3,  sustain:0.75, release:1.2,  filterFreq:3500, filterQ:1.0, overtones:0.2, reverb:0.65, detune:0, vibratoRate:5, vibratoDepth:0, tremoloRate:4, tremoloDepth:0,    delayTime:0.3, delayFeedback:0.3, delayWet:0, filterLfoDepth:0, waveform:'sine' },
  vibes:   { attack:0.005, decay:1.2,  sustain:0.1,  release:1.8,  filterFreq:6000, filterQ:0.5, overtones:0.2, reverb:0.5,  detune:0, vibratoRate:5, vibratoDepth:0, tremoloRate:4, tremoloDepth:0,    delayTime:0.3, delayFeedback:0.3, delayWet:0, filterLfoDepth:0, waveform:'sine' },
  pad:     { attack:0.5,   decay:0.3,  sustain:0.85, release:2.0,  filterFreq:2500, filterQ:1.5, overtones:0.2, reverb:0.7,  detune:0, vibratoRate:5, vibratoDepth:0, tremoloRate:4, tremoloDepth:0,    delayTime:0.3, delayFeedback:0.3, delayWet:0, filterLfoDepth:0, waveform:'sine' },
};
const savedPresets = Object.fromEntries(Object.keys(SAMPLE_DEFS).concat(['synth']).map(k => [k, null]));

function applySynthPreset(preset) {
  const set = (id, raw) => {
    const el = document.getElementById(id);
    if (el) { el.value = Math.max(0, Math.min(100, raw)); el.dispatchEvent(new Event('input')); }
  };
  if (preset.attack        !== undefined) set('synth-attack',     invAttack(preset.attack));
  if (preset.decay         !== undefined) set('synth-decay',      invDecay(preset.decay));
  if (preset.sustain       !== undefined) set('synth-sustain',    invSustain(preset.sustain));
  if (preset.release       !== undefined) set('synth-release',    invRelease(preset.release));
  if (preset.filterFreq    !== undefined) set('synth-tone',       invTone(preset.filterFreq));
  if (preset.filterQ       !== undefined) set('synth-res',        invRes(preset.filterQ));
  if (preset.overtones     !== undefined) set('synth-overtones',  invOvertones(preset.overtones));
  if (preset.reverb        !== undefined) set('synth-reverb',     invReverb(preset.reverb));
  if (preset.detune        !== undefined) set('synth-detune',     invDetune(preset.detune));
  if (preset.vibratoRate   !== undefined) set('synth-vib-rate',   invVibRate(preset.vibratoRate));
  if (preset.vibratoDepth  !== undefined) set('synth-vib-depth',  invVibDepth(preset.vibratoDepth));
  if (preset.tremoloRate   !== undefined) set('synth-trem-rate',  invTremRate(preset.tremoloRate));
  if (preset.tremoloDepth  !== undefined) set('synth-trem-depth', invTremDepth(preset.tremoloDepth));
  if (preset.delayTime     !== undefined) set('synth-dly-time',   invDlyTime(preset.delayTime));
  if (preset.delayFeedback !== undefined) set('synth-dly-fb',     invDlyFb(preset.delayFeedback));
  if (preset.delayWet      !== undefined) set('synth-dly-wet',    invDlyWet(preset.delayWet));
  if (preset.filterLfoDepth!== undefined) set('synth-flfo',       invFlfo(preset.filterLfoDepth));
  if (preset.waveform      !== undefined) {
    state.synth.waveform = preset.waveform;
    const el = document.getElementById('synth-waveform');
    if (el) el.value = preset.waveform;
  }
}

function fmtMs(s) {
  return s < 1 ? Math.round(s * 1000) + 'ms' : s.toFixed(2) + 's';
}
function fmtHz(hz) {
  return hz >= 1000 ? (hz / 1000).toFixed(1) + 'kHz' : Math.round(hz) + 'Hz';
}

(function initSynthSliders() {
  const defs = [
    { id: 'synth-attack',   valId: 'synth-attack-val',   key: 'attack',     fn: sliderToAttack,    fmt: fmtMs },
    { id: 'synth-decay',    valId: 'synth-decay-val',    key: 'decay',      fn: sliderToDecay,     fmt: fmtMs },
    { id: 'synth-sustain',  valId: 'synth-sustain-val',  key: 'sustain',    fn: sliderToSustain,   fmt: v => Math.round(v * 100) + '%' },
    { id: 'synth-release',  valId: 'synth-release-val',  key: 'release',    fn: sliderToRelease,   fmt: fmtMs },
    { id: 'synth-tone',     valId: 'synth-tone-val',     key: 'filterFreq', fn: sliderToTone,      fmt: fmtHz },
    { id: 'synth-res',      valId: 'synth-res-val',      key: 'filterQ',    fn: sliderToRes,       fmt: v => v.toFixed(1) },
    { id: 'synth-overtones',valId: 'synth-overtones-val',key: 'overtones',  fn: sliderToOvertones, fmt: v => Math.round(v * 100) + '%' },
    { id: 'synth-reverb',    valId: 'synth-reverb-val',    key: 'reverb',        fn: sliderToReverb,       fmt: v => Math.round(v * 100) + '%',
      side: val => { if (audioCtx?._reverbWet) audioCtx._reverbWet.gain.value = val; } },
    { id: 'synth-detune',    valId: 'synth-detune-val',    key: 'detune',        fn: sliderToDetune,       fmt: v => Math.round(v) + '¢' },
    { id: 'synth-vib-rate',  valId: 'synth-vib-rate-val',  key: 'vibratoRate',   fn: sliderToVibratoRate,  fmt: v => v.toFixed(1) + 'Hz' },
    { id: 'synth-vib-depth', valId: 'synth-vib-depth-val', key: 'vibratoDepth',  fn: sliderToVibratoDepth, fmt: v => Math.round(v) + '¢' },
    { id: 'synth-trem-rate', valId: 'synth-trem-rate-val', key: 'tremoloRate',   fn: sliderToTremoloRate,  fmt: v => v.toFixed(1) + 'Hz' },
    { id: 'synth-trem-depth',valId: 'synth-trem-depth-val',key: 'tremoloDepth',  fn: sliderToTremoloDepth, fmt: v => Math.round(v * 100) + '%' },
    { id: 'synth-dly-time',  valId: 'synth-dly-time-val',  key: 'delayTime',     fn: sliderToDelayTime,    fmt: fmtMs,
      side: val => { if (audioCtx?._delay) audioCtx._delay.delayTime.value = val; } },
    { id: 'synth-dly-fb',    valId: 'synth-dly-fb-val',    key: 'delayFeedback', fn: sliderToDelayFeedback,fmt: v => Math.round(v * 100) + '%',
      side: val => { if (audioCtx?._delayFb) audioCtx._delayFb.gain.value = val; } },
    { id: 'synth-dly-wet',   valId: 'synth-dly-wet-val',   key: 'delayWet',      fn: sliderToDelayWet,     fmt: v => Math.round(v * 100) + '%',
      side: val => { if (audioCtx?._delayWet) audioCtx._delayWet.gain.value = val; } },
    { id: 'synth-flfo',      valId: 'synth-flfo-val',      key: 'filterLfoDepth',fn: sliderToFilterLfo,    fmt: v => Math.round(v) + 'Hz' },
  ];
  defs.forEach(({ id, valId, key, fn, fmt, side }) => {
    const el = document.getElementById(id);
    const lbl = document.getElementById(valId);
    const update = () => {
      const val = fn(parseInt(el.value, 10));
      editTargetSynth()[key] = val;
      lbl.textContent = fmt(val);
      // Side-effects on the live audio bus (reverb wet, delay time, ...)
      // only make sense when we're editing the chord-pad voice. For tracks
      // those values get baked into the next note's chain via withSynth.
      if (side && state.synthEditTarget === 'pad') side(val);
    };
    el.addEventListener('input', update);
    update(); // set initial label
  });
})();


// ============================================================
// PIANO TOOLTIP
// ============================================================
const pianoTooltipEl = document.getElementById('piano-tooltip');

function currentScaleAbsolute() {
  const tpl = state.currentTemplate;
  const key = state.keys[tpl];
  let intervals;
  if (tpl === 'scale-chords') {
    intervals = SCALE_DEFS[state.scaleType];
  } else if (TEMPLATES[tpl].keyMode === 'harmonic-minor') {
    intervals = SCALE_DEFS['harmonic-minor'];
  } else if (TEMPLATES[tpl].keyMode === 'minor') {
    intervals = SCALE_DEFS['minor'];
  } else {
    intervals = [0, 2, 4, 5, 7, 9, 11];
  }
  return new Set(intervals.map(i => (key + i) % 12));
}

function buildPianoSVG(rootPitch, chordQ, scaleOverride, scale = 1) {
  const W = 22, H = 68, BW = 12, BH = 40, TOP = 14;
  // white key layout: [pitchClass, xLeft]
  const whites = [[0,0],[2,22],[4,44],[5,66],[7,88],[9,110],[11,132]];
  // black key layout: centered on white-key boundaries (22,44,88,110,132)
  const blacks = [[1,16],[3,38],[6,82],[8,104],[10,126]];
  const totalW = 7 * W;
  const totalH = H + TOP;

  const DIM_SCALE = [0, 2, 3, 5, 6, 8, 9, 11]; // whole-half diminished
  const scaleTones = state.showScaleTones
    ? scaleOverride
      ? new Set(scaleOverride.map(i => (rootPitch + i) % 12))
      : chordQ === 'dim7'
        ? new Set(DIM_SCALE.map(i => (rootPitch + i) % 12))
        : currentScaleAbsolute()
    : new Set();
  const chordTones  = new Set(CHORD_INTERVALS[chordQ].map(i => (rootPitch + i) % 12));

  const spelling = buildSpelling(rootPitch, 'major');
  const labelFor = (pc) => {
    if (pc === rootPitch)   return { name: spelling[pc], color: '#ffffff' };
    if (chordTones.has(pc)) return { name: spelling[pc], color: '#ffaa33' };
    return null;
  };

  function dotAttrs(pc, isBlack) {
    if (pc === rootPitch)     return `fill="#ffffff"`;
    if (chordTones.has(pc))   return `fill="#ffaa33"`;
    if (scaleTones.has(pc))   return `fill="#bee067"`;
    return null;
  }

  let s = `<svg width="${Math.round(totalW * scale)}" height="${Math.round(totalH * scale)}" viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg" style="display:block">
  <defs><filter id="ds"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#000" flood-opacity="0.35"/></filter></defs>`;

  // Note labels above keys (chord tones + root)
  const labelEsc = (n) => n.replace(/♯/g,'&#9839;').replace(/♭/g,'&#9837;');
  whites.forEach(([pc, x]) => {
    const lab = labelFor(pc);
    if (lab) s += `<text x="${x + W/2}" y="${TOP - 4}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600" fill="${lab.color}">${labelEsc(lab.name)}</text>`;
  });
  blacks.forEach(([pc, x]) => {
    const lab = labelFor(pc);
    if (lab) s += `<text x="${x + BW/2}" y="${TOP - 4}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600" fill="${lab.color}">${labelEsc(lab.name)}</text>`;
  });

  // White keys
  whites.forEach(([pc, x]) => {
    s += `<rect x="${x+0.5}" y="${TOP+0.5}" width="${W-1}" height="${H-1}" fill="#f0ece4" rx="2" stroke="#888" stroke-width="0.5"/>`;
  });
  // Black keys
  blacks.forEach(([pc, x]) => {
    s += `<rect x="${x}" y="${TOP}" width="${BW}" height="${BH}" fill="#1a1a1a" rx="2"/>`;
  });
  // Dots on white keys
  whites.forEach(([pc, x]) => {
    const a = dotAttrs(pc, false);
    if (a) s += `<circle cx="${x + W/2}" cy="${TOP + H - 9}" r="4.5" ${a} filter="url(#ds)"/>`;
  });
  // Dots on black keys
  blacks.forEach(([pc, x]) => {
    const a = dotAttrs(pc, true);
    if (a) s += `<circle cx="${x + BW/2}" cy="${TOP + BH - 8}" r="4.5" ${a}/>`;
  });

  s += '</svg>';
  return s;
}

function showPianoTooltip(padEl, rootPitch, chordQ, scaleOverride) {
  if (!state.showPianoHover) return;
  const scale = window.matchMedia('(hover: none)').matches ? 0.5 : 1;
  pianoTooltipEl.innerHTML = buildPianoSVG(rootPitch, chordQ, scaleOverride, scale);
  pianoTooltipEl.style.display = 'block';
  const r  = padEl.getBoundingClientRect();
  const tw = pianoTooltipEl.offsetWidth;
  const th = pianoTooltipEl.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  let top  = r.top - th - 8;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  if (top < 8) top = r.bottom + 8;
  pianoTooltipEl.style.left = left + 'px';
  pianoTooltipEl.style.top  = top + 'px';
}

function hidePianoTooltip() {
  pianoTooltipEl.style.display = 'none';
}

// ============================================================
// PLAY STYLE — strum + pattern scheduler
// ============================================================
function playStrum(notes, velocity, direction) {
  const ctx = getAudioCtx();
  const spread = 0.022;
  return notes.map((n, i) => {
    const offset = direction === 'down' ? (notes.length - 1 - i) * spread : i * spread;
    return startAudioNote(n, velocity, ctx.currentTime + offset);
  });
}

const PS = {
  timer: null,
  active: new Map(),  // padId → { notes, pattern, step, nextTime }
  LOOKAHEAD: 0.12,
  TICK_MS: 25,
};

function psStepDur() { return 60 / state.tempo / 2; }

function psBuildPattern(style, noteCount) {
  const all = Array.from({ length: noteCount }, (_, i) => i);
  switch (style) {
    case 'arp-up':
      return { steps: Array.from({ length: noteCount }, (_, i) => [i]), dur: 0.85 };
    case 'arp-down':
      return { steps: Array.from({ length: noteCount }, (_, i) => [noteCount - 1 - i]), dur: 0.85 };
    case 'arp-up-down': {
      const up   = Array.from({ length: noteCount }, (_, i) => [i]);
      const down = noteCount > 2 ? Array.from({ length: noteCount - 2 }, (_, i) => [noteCount - 2 - i]) : [];
      return { steps: [...up, ...down], dur: 0.85 };
    }
    case 'beat':    return { steps: [all, null, all, null],               dur: 1.75 };
    case 'offbeat': return { steps: [null, all, null, all],               dur: 1.75 };
    case 'waltz':   return { steps: [all, null, null, all, null, null],   dur: 1.75 };
    default: return null;
  }
}

function psTick() {
  const ctx     = getAudioCtx();
  const now     = ctx.currentTime;
  const horizon = now + PS.LOOKAHEAD;
  const stepDur = psStepDur();
  PS.active.forEach(entry => {
    while (entry.nextTime < horizon) {
      const step    = entry.step % entry.pattern.steps.length;
      const indices = entry.pattern.steps[step];
      if (indices !== null) {
        const dur = stepDur * entry.pattern.dur;
        indices.forEach(idx => {
          if (idx < entry.notes.length)
            startAudioNote(entry.notes[idx], state.velocity, entry.nextTime, dur);
        });
      }
      entry.step++;
      entry.nextTime += stepDur;
    }
  });
}

function psStart(padId, notes) {
  const pattern = psBuildPattern(state.playStyle, notes.length);
  if (!pattern) return false;
  const ctx = getAudioCtx();
  PS.active.set(padId, { notes, pattern, step: 0, nextTime: ctx.currentTime });
  if (!PS.timer) PS.timer = setInterval(psTick, PS.TICK_MS);
  return true;
}

function psStop(padId) {
  PS.active.delete(padId);
  if (PS.active.size === 0 && PS.timer) { clearInterval(PS.timer); PS.timer = null; }
}


// ============================================================
// RECORD
// ============================================================
const REC = {
  active: false,
  armed: false,
  startTime: 0,
  rafId: null,
  _precountRaf: null,
  pendingChords: new Map(), // padId → {interval, q, bassInterval, label, keyRoot, template, startBeat}
  pendingNotes:  new Map(), // midi  → {label, startBeat}
  pendingMidi:   new Map(), // midi  → {label, startBeat}  (from external MIDI input)
};

const PRECOUNT = { enabled: true };

function midiNoteLabel(midi) {
  return ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][midi % 12] + (Math.floor(midi / 12) - 1);
}

function recCurrentBeat() {
  const elapsed = getAudioCtx().currentTime - REC.startTime;
  const raw = elapsed / seqBeatDur();
  if (!SEQ.loop) return raw;
  const total = SEQ.loopEnd - SEQ.loopStart;
  return SEQ.loopStart + ((raw % total) + total) % total;
}

function recAnimateBeat() {
  if (!REC.active) return;
  document.getElementById('seq-rec-beat').textContent = (Math.floor(recCurrentBeat()) + 1);
  REC.rafId = requestAnimationFrame(recAnimateBeat);
}

function recArm() {
  REC.armed = true;
  document.getElementById('seq-rec-btn').classList.add('armed');
}

function recDisarm() {
  REC.armed = false;
  document.getElementById('seq-rec-btn').classList.remove('armed');
}

function recActivate(t0) {
  REC.armed = false;
  REC.active = true;
  REC.startTime = t0;
  document.getElementById('seq-rec-btn').classList.remove('armed');
  document.getElementById('seq-rec-btn').classList.add('active');
  recAnimateBeat();
}

function recStop() {
  REC.active = false;
  REC.armed = false;
  REC.pendingChords.clear();
  REC.pendingNotes.clear();
  REC.pendingMidi.clear();
  if (typeof clearAllPerTrackRecPending === 'function') clearAllPerTrackRecPending();
  // Drop the per-track arm flag too — fresh session each recording.
  for (const t of SEQ.tracksList) t.armed = false;
  document.querySelectorAll('.seq-th-arm.armed').forEach(b => b.classList.remove('armed'));
  if (REC.rafId) { cancelAnimationFrame(REC.rafId); REC.rafId = null; }
  if (!SEQ.playing) metroHalt();
  document.getElementById('seq-rec-btn').classList.remove('active');
  document.getElementById('seq-rec-btn').classList.remove('armed');
  document.getElementById('seq-rec-beat').textContent = '';
}

// ============================================================
// METRONOME
// ============================================================
const METRO = {
  enabled: false,        // user toggle
  timer: null,           // only runs during play or rec
  nextTickTime: 0,       // next click scheduled audio time
  nextBeatMusical: 0,    // music beat for next click (integer)
  cycleStart: 0,         // audio time of current cycle's loopStart
  TICK_MS: 25,
  LOOKAHEAD: 0.1,
};

function scheduleMetroClick(time, accent) {
  const ctx = getAudioCtx();
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = accent ? 1200 : 800;
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(accent ? 0.35 : 0.2, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(time);
  osc.stop(time + 0.06);
}

function metroTick() {
  if (!METRO.enabled || !SEQ.playing) return;
  const ctx = getAudioCtx();
  const bd  = seqBeatDur();
  const horizon = ctx.currentTime + METRO.LOOKAHEAD;
  while (METRO.nextTickTime < horizon) {
    // Accent on absolute bar downbeats (beat % beatsPerBar === 0). A loop
    // that starts mid-bar therefore opens with a LOW tick — the accents
    // remain anchored to the musical bar grid, not to the loop boundary.
    const accent = (METRO.nextBeatMusical % state.beatsPerBar) === 0;
    scheduleMetroClick(METRO.nextTickTime, accent);
    METRO.nextTickTime += bd;
    METRO.nextBeatMusical += 1;
    // When the loop wraps, restart the metronome from the first integer
    // beat inside the new cycle (= ceil(loopStart) relative to loop).
    if (SEQ.loop && METRO.nextBeatMusical >= SEQ.loopEnd) {
      const firstBeat   = Math.ceil(SEQ.loopStart - 1e-9);
      const offsetBeats = firstBeat - SEQ.loopStart;
      const cycleLen    = (SEQ.loopEnd - SEQ.loopStart) * bd;
      METRO.cycleStart += cycleLen;
      METRO.nextBeatMusical = firstBeat;
      METRO.nextTickTime    = METRO.cycleStart + offsetBeats * bd;
    }
  }
}

function metroRun(startAudioTime, startMusicBeat) {
  if (!METRO.enabled || METRO.timer) return;
  const bd = seqBeatDur();
  // Audio time of loopStart music-beat in the *current* cycle. Lets the wrap
  // logic later add full cycle lengths cleanly.
  METRO.cycleStart = startAudioTime - (startMusicBeat - SEQ.loopStart) * bd;
  // First click lands at the next whole beat ≥ startMusicBeat.
  const firstBeat = Math.ceil(startMusicBeat - 1e-9);
  METRO.nextBeatMusical = firstBeat;
  METRO.nextTickTime    = startAudioTime + (firstBeat - startMusicBeat) * bd;
  metroTick();
  METRO.timer = setInterval(metroTick, METRO.TICK_MS);
}

function metroRunSynced() {
  if (!METRO.enabled || METRO.timer) return;
  const ctx = getAudioCtx();
  // SEQ.animBeat is the latency-compensated VISUAL playhead — using it
  // as the music-beat reference at ctx.currentTime makes the first
  // click fire ~30-50 ms (one outputLatency) off the actual beat grid.
  // Use the scheduler's playStartTime anchor instead so the metro lines
  // up with the scheduled note events.
  const bd = seqBeatDur();
  const tRef = (typeof SEQ.playStartTime === 'number') ? SEQ.playStartTime + 0.05 : ctx.currentTime;
  let beat = (ctx.currentTime - tRef) / bd + SEQ.loopStart;
  if (SEQ.loop) {
    const len = Math.max(0.001, SEQ.loopEnd - SEQ.loopStart);
    beat = SEQ.loopStart + ((beat - SEQ.loopStart) % len + len) % len;
  }
  metroRun(ctx.currentTime, beat);
}

function metroHalt() {
  if (METRO.timer) { clearInterval(METRO.timer); METRO.timer = null; }
}

// ============================================================
// INIT
// ============================================================
buildKeyTracks();
rebuildBoard();
updateControlDisplays();

const midiLed = document.getElementById('midi-led');
// MIDI is always-on now (global toggle removed). Initialize Web MIDI access
// on load so per-track input/output port selectors find devices straight away.
state.midiEnabled = true;
if (midiLed) midiLed.style.display = '';
document.getElementById('hint-panic')?.style.setProperty('display', '');
if (navigator.requestMIDIAccess) {
  initMIDI().catch(() => {/* user can still use the app without MIDI */});
}

document.getElementById('play-style-select').addEventListener('change', (e) => {
  state.playStyle = e.target.value;
  const hasPattern = !['off', 'strum-up', 'strum-down'].includes(state.playStyle);
  document.getElementById('tempo-control').style.display = hasPattern ? '' : 'none';
});
function applyTempoChange() {
  document.getElementById('seq-tempo-val').value = state.tempo;
  document.getElementById('ctrl-tempo').value    = state.tempo;
  if (!SEQ.playing) return;

  // Re-anchor + reschedule under the new tempo. Without re-anchoring, the
  // scheduler treats the entire elapsed time as if it ran at the new tempo
  // — wrong, and you get phase jumps / overlapping notes.
  const ctx = getAudioCtx();
  SEQ.activeNodes.forEach(n => stopAudioNote(n));
  SEQ.activeNodes.clear();
  panic();
  seqHighlight(-1);
  seqHighlightNote(-1);
  seqLoopBaseChangedResync();

  // Re-align visual cursor to audio scheduling time. Mirrors what we do at
  // play-start (animLastTime = t0): each rAF subtracts `lat` from `now`, so
  // the `lat` term must NOT be baked into animLastTime — otherwise it
  // cancels and visualLatencyMs stops compensating. The result was the
  // cursor pulling ahead of audio after a tempo change (worse at higher
  // tempo, because the cancelled-out lag is a constant ms and bigger
  // relative to a smaller beat).
  SEQ.animLastTime = ctx.currentTime;
  seqSave();
}

document.getElementById('tempo-down').addEventListener('click', () => {
  state.tempo = Math.max(40, state.tempo - 5);
  applyTempoChange();
});
document.getElementById('tempo-up').addEventListener('click', () => {
  state.tempo = Math.min(240, state.tempo + 5);
  applyTempoChange();
});



// Trem Rate tempo sync
document.getElementById('trem-sync').addEventListener('click', () => {
  const T = state.tempo;
  const candidates = [T/240, T/120, T/80, T/60, T/40, T/30, T/20, T/15];
  const current = state.synth.tremoloRate;
  const nearest = candidates.reduce((best, c) =>
    Math.abs(c - current) < Math.abs(best - current) ? c : best
  );
  const el = document.getElementById('synth-trem-rate');
  el.value = Math.max(0, Math.min(100, invTremRate(nearest)));
  el.dispatchEvent(new Event('input'));
});

// Vib Rate tempo sync
document.getElementById('vib-rate-sync').addEventListener('click', () => {
  const T = state.tempo;
  const candidates = [T/240, T/120, T/80, T/60, T/40, T/30, T/20, T/15];
  const current = state.synth.vibratoRate;
  const nearest = candidates.reduce((best, c) =>
    Math.abs(c - current) < Math.abs(best - current) ? c : best
  );
  const el = document.getElementById('synth-vib-rate');
  el.value = Math.max(0, Math.min(100, invVibRate(nearest)));
  el.dispatchEvent(new Event('input'));
});

// Dly Time tempo sync
document.getElementById('dly-time-sync').addEventListener('click', () => {
  const T = state.tempo;
  // half, dotted-quarter, quarter, dotted-eighth, quarter-triplet, eighth, eighth-triplet, 16th
  const candidates = [120/T, 90/T, 60/T, 45/T, 40/T, 30/T, 20/T, 15/T].filter(v => v >= 0.05 && v <= 1.0);
  const current = state.synth.delayTime;
  const nearest = candidates.reduce((best, c) =>
    Math.abs(c - current) < Math.abs(best - current) ? c : best
  );
  const el = document.getElementById('synth-dly-time');
  el.value = Math.max(0, Math.min(100, invDlyTime(nearest)));
  el.dispatchEvent(new Event('input'));
});

// Sequencer controls

document.getElementById('seq-play-btn').addEventListener('click', () => {
  if (!SEQ.playing) seqPlay();
});
document.getElementById('seq-stop-btn')?.addEventListener('click', () => {
  if (SEQ.playing) seqStop();
});

document.getElementById('seq-rec-btn').addEventListener('click', () => {
  if (REC.active) recStop();
  else if (REC.armed) recDisarm();
  else if (SEQ.playing) recActivate(SEQ.playStartTime + 0.05);
  else recArm();
});

document.getElementById('seq-metro-btn').addEventListener('click', () => {
  METRO.enabled = !METRO.enabled;
  document.getElementById('seq-metro-btn').classList.toggle('active', METRO.enabled);
  if (!METRO.enabled) {
    metroHalt();
  } else if (SEQ.playing || REC.active) {
    metroRunSynced();
  }
});

function seqUpdateBarLine() {
  document.documentElement.style.setProperty('--bar-px',  (state.beatsPerBar * BEAT_PX) + 'px');
  document.documentElement.style.setProperty('--beat-px', BEAT_PX + 'px');
  prUpdateGridVars();
  seqRenderRuler();
}

function seqRenderRuler() {
  const ruler = document.getElementById('seq-ruler');
  if (!ruler) return;
  // Extend the ruler well past the visible area so panning to the right
  // never reveals "blank" territory without bar markers / lane canvas.
  const wrap = document.getElementById('seq-lane-wrap');
  const visibleW = wrap ? wrap.clientWidth : 0;
  let trackMax = 0;
  for (const tr of SEQ.tracksList) trackMax = Math.max(trackMax, seqLaneWidth(tr.items));
  const bpb = state.beatsPerBar;
  const extraBars = 32; // empty pannable territory after the last clip
  const chordItems = firstTrackOfKind('chord')?.items || [];
  const freeItems  = firstTrackOfKind('free')?.items || [];
  const rawWidth = Math.max(
    trackMax + extraBars * bpb * BEAT_PX,
    seqLaneWidth(chordItems),
    seqLaneWidth(freeItems),
    visibleW + extraBars * bpb * BEAT_PX,
    4 * BEAT_PX + 64
  );
  // Round up to a full bar so the grid pattern's rightmost bar-line lands
  // exactly at the lane edge (instead of being clipped off mid-tile).
  const totalBars = Math.ceil(rawWidth / (bpb * BEAT_PX));
  const widthPx   = totalBars * bpb * BEAT_PX;
  ruler.style.width = widthPx + 'px';
  // Stretch the tracks-inner container so every lane fills the full ruler
  // width, otherwise panning past the last clip shows empty/half-rendered
  // territory beyond the lane's bottom border.
  const innerEl = document.getElementById('seq-tracks-inner');
  if (innerEl) innerEl.style.minWidth = widthPx + 'px';
  let html = '';
  for (let bar = 0; bar < totalBars; bar++) {
    const left = bar * bpb * BEAT_PX;
    html += `<div class="seq-ruler-bar" style="left:${left}px"><span>${bar + 1}</span></div>`;
    for (let b = 1; b < bpb; b++) {
      html += `<div class="seq-ruler-beat" style="left:${left + b * BEAT_PX}px"></div>`;
    }
  }
  ruler.innerHTML = html;
  _appendRulerLoopHandles();
  if (!ruler.dataset.clickInit) {
    ruler.dataset.clickInit = '1';
    let downX = null, downY = null, downTarget = null;
    ruler.addEventListener('pointerdown', (e) => {
      downX = e.clientX; downY = e.clientY; downTarget = e.target;
    });
    ruler.addEventListener('pointerup', (e) => {
      if (downX == null) return;
      const dx = Math.abs(e.clientX - downX);
      const dy = Math.abs(e.clientY - downY);
      const target = downTarget; downX = downY = null; downTarget = null;
      if (dx > 3 || dy > 3) return; // it was a drag — ignore
      if (target?.classList?.contains('seq-loop-bar-left') ||
          target?.classList?.contains('seq-loop-bar-right')) return;
      const rect = ruler.getBoundingClientRect();
      const beat = Math.max(0, Math.round((e.clientX - rect.left) / BEAT_PX * 2) / 2);
      // Use seqJumpToBeat so playback cancels in-flight notes + re-
      // anchors the scheduler. Manually setting startBeat/animBeat
      // only updates the visual cursor — the audio kept running from
      // the old position.
      seqJumpToBeat(beat);
    });
  }
}

// Scroll-on-hover: cycle through the time-signature <option>s with the wheel.
(function _initTimesigWheel() {
  const sel = document.getElementById('seq-timesig');
  if (!sel) return;
  sel.addEventListener('wheel', (e) => {
    e.preventDefault();
    const opts = sel.options;
    const dir = Math.sign(e.deltaY) > 0 ? -1 : 1;
    const next = Math.max(0, Math.min(opts.length - 1, sel.selectedIndex + dir));
    if (next !== sel.selectedIndex) {
      sel.selectedIndex = next;
      sel.dispatchEvent(new Event('change'));
    }
  }, { passive: false });
})();
// Scroll-on-hover for the two tempo inputs (header settings + track toolbar).
// MIDI Clock sync controls (toggle + port select next to tempo).
(function _initMidiClockSync() {
  const toggle = document.getElementById('seq-clock-toggle');
  const sel    = document.getElementById('seq-clock-port');
  if (!toggle || !sel) return;
  const sync = () => {
    const active = !!state.midiClockEnabled;
    const present = typeof midiClockIsActive === 'function' && midiClockIsActive();
    toggle.classList.toggle('clock-locked', active);
    toggle.classList.toggle('clock-present', present && !active);
    const tempoInputs = document.querySelectorAll('#ctrl-tempo, #seq-tempo-val');
    tempoInputs.forEach(el => el.disabled = active);
    sel.value = state.midiClockPortId || '';
  };
  // 5 Hz watchdog: drops "clock present" after the F8 stream stops, and
  // keeps the lock-state in sync if the user changes follow elsewhere.
  setInterval(sync, 200);
  // Beat heartbeat: flash the icon to accent on every detected beat,
  // whether or not the user is following — so they can see "there's a
  // pulse coming in" before deciding to sync.
  if (typeof onMidiClockBeat === 'function') {
    onMidiClockBeat(() => {
      toggle.classList.add('beat');
      setTimeout(() => toggle.classList.remove('beat'), 110);
    });
  }
  const rebuild = () => {
    const inputs = state.midiAccess ? Array.from(state.midiAccess.inputs.values()) : [];
    sel.innerHTML = '<option value="">— none —</option>'
      + inputs.map(p => `<option value="${p.id}"${p.id === (state.midiClockPortId || '') ? ' selected' : ''}>${p.name}</option>`).join('');
    sync();
  };
  rebuild();
  document.addEventListener('chordpad:midi-ports-changed', rebuild);
  toggle.addEventListener('click', () => {
    state.midiClockEnabled = !state.midiClockEnabled;
    if (state.midiClockEnabled && !state.midiClockPortId) {
      // Auto-pick the first available input if none chosen yet.
      const first = state.midiAccess ? state.midiAccess.inputs.values().next().value : null;
      if (first) state.midiClockPortId = first.id;
    }
    attachMidiInput();
    // If we just enabled follow and clock is already streaming, apply
    // the current rolling-average BPM immediately — otherwise the user
    // has to wait for the next significant tempo change on the source
    // before the displayed BPM catches up.
    if (state.midiClockEnabled && _midiClock.intervals.length >= 3) {
      const avg = _midiClock.intervals.reduce((s, v) => s + v, 0) / _midiClock.intervals.length;
      const bpm = Math.round(60000 / (avg * 24));
      if (bpm >= 40 && bpm <= 240) {
        _midiClock.lastAppliedBpm = bpm;
        state.tempo = bpm;
        const tEl1 = document.getElementById('seq-tempo-val');
        const tEl2 = document.getElementById('ctrl-tempo');
        if (tEl1) tEl1.value = bpm;
        if (tEl2) tEl2.value = bpm;
      }
    }
    sync();
    seqSave();
  });
  sel.addEventListener('change', () => {
    state.midiClockPortId = sel.value;
    _midiClock.intervals.length = 0; _midiClock.lastTickAt = 0;
    attachMidiInput();
    seqSave();
  });
})();

// Keyboard MIDI input — global port that plays through the chord-pad
// keyboard (audibly via state.instrument), highlights the visual
// keys, and feeds the chord analyzer. If the same port is already
// assigned to a track, attachMidiInput skips the keyboard route on
// that port so notes don't sound twice.
(function _initKeyboardMidiPort() {
  const sel = document.getElementById('keyboard-midi-port');
  if (!sel) return;
  const rebuild = () => {
    const inputs = state.midiAccess ? Array.from(state.midiAccess.inputs.values()) : [];
    sel.innerHTML = '<option value="">— none —</option>'
      + inputs.map(p => `<option value="${p.id}"${p.id === (state.keyboardMidiPortId || '') ? ' selected' : ''}>${p.name}</option>`).join('');
    sel.value = state.keyboardMidiPortId || '';
  };
  rebuild();
  document.addEventListener('chordpad:midi-ports-changed', rebuild);
  sel.addEventListener('change', () => {
    state.keyboardMidiPortId = sel.value;
    attachMidiInput();
    seqSave();
  });
})();

(function _initTempoWheel() {
  const ids = ['ctrl-tempo', 'seq-tempo-val'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = e.shiftKey ? 1 : 5;
      const dir = Math.sign(e.deltaY) > 0 ? -1 : 1;
      const cur = parseInt(el.value, 10) || state.tempo;
      const next = Math.max(40, Math.min(240, cur + dir * step));
      if (next !== cur) {
        state.tempo = next;
        applyTempoChange();
      }
    }, { passive: false });
  }
})();
document.getElementById('seq-timesig').addEventListener('change', (e) => {
  state.beatsPerBar = parseInt(e.target.value);
  seqUpdateBarLine();
  const _chord = firstTrackOfKind('chord');
  const _free  = firstTrackOfKind('free');
  if (!_chord?.items?.length && !_free?.items?.length) {
    SEQ.loopStart = 0;
    SEQ.loopEnd   = state.beatsPerBar;
    seqUpdateLoopStart();
    seqUpdateLoopEnd();
  }
  seqSave();
});

document.getElementById('seq-loop-btn').addEventListener('click', () => {
  SEQ.loop = !SEQ.loop;
  document.getElementById('seq-loop-btn').classList.toggle('active', SEQ.loop);
  seqUpdateLoopVisible();
  if (SEQ.chordViewOpen && typeof renderChordView === 'function') renderChordView();
  seqSave();

  // Refresh per-track scheduling so playback either picks up the loop right
  // away (turning ON) or stops repeating at the loop end (turning OFF).
  // Without this, tracks whose pendingTime was Infinity (= "done playing")
  // stay silent when loop is enabled mid-session.
  if (SEQ.playing) seqLoopBaseChangedResync();
});


document.getElementById('seq-clear-btn')?.addEventListener('click', () => {
  seqStop();
  const _chord = firstTrackOfKind('chord');
  const _free  = firstTrackOfKind('free');
  if (_chord?.items?.length || _free?.items?.length) seqCheckpoint();
  if (_chord) _chord.items.length = 0;
  if (_free)  _free.items.length  = 0;
  seqRenderAll();
});

document.getElementById('seq-tempo-down').addEventListener('click', () => {
  state.tempo = Math.max(40, state.tempo - 5);
  applyTempoChange();
});
document.getElementById('seq-tempo-up').addEventListener('click', () => {
  state.tempo = Math.min(240, state.tempo + 5);
  applyTempoChange();
});

function handleTempoInput(el) {
  el.addEventListener('change', () => {
    const v = parseInt(el.value, 10);
    if (!isNaN(v)) { state.tempo = Math.max(40, Math.min(240, v)); applyTempoChange(); }
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
}
handleTempoInput(document.getElementById('seq-tempo-val'));
handleTempoInput(document.getElementById('ctrl-tempo'));

// Apply default instrument preset and sync dropdown
document.getElementById('synth-instrument').value = state.instrument;
if (state.instrument !== 'synth') {
  applySynthPreset(INSTRUMENT_PRESETS[state.instrument]);
  preloadSamplesOnGesture(state.instrument);
}
updateSynthOnlyVisibility();
// Prewarm the SF2 preset for the default instrument + every track that
// runs on an SF2-backed instrument. Without this, on a cold refresh
// the first few seconds of playback decode samples lazily (one decode
// per first-played note) — audible as soft volume / a small stutter
// for the first ~3 bars. Fires after the SF2 file finishes loading.
(async function _prewarmDefaultInstruments() {
  await loadSf2('fluid');
  const fluid = SF2_FILES.fluid.sf2;
  if (!fluid) return;
  const seen = new Set();
  const tryPrewarm = (inst) => {
    if (!inst || seen.has(inst)) return;
    seen.add(inst);
    const preset = INSTRUMENT_TO_SF2[inst];
    if (preset != null) prewarmSf2Preset(fluid, preset);
  };
  tryPrewarm(state.instrument);
  if (typeof SEQ !== 'undefined' && Array.isArray(SEQ.tracksList)) {
    for (const t of SEQ.tracksList) tryPrewarm(t.instrument);
  }
})();

buildKeyboard();
initKbDragStrip();
initTouchGlide();
initMidiLaneResize();
initSeqLanePan();
initSeqPinchZoom();
seqLoad();
uiPrefsLoad();
// Apply restored template + key. setActiveTab also calls rebuildBoard;
// for the default template we still need to refresh pads with the loaded
// key.
if (state.currentTemplate && state.currentTemplate !== 'major-harmony') {
  setActiveTab(state.currentTemplate);
} else if (typeof rebuildBoard === 'function') {
  rebuildBoard();
}
if (typeof updateKeySelectors === 'function') updateKeySelectors();
// Tracks may have midiInPortId configured; re-attach now that they exist.
if (state.midiAccess) attachMidiInput();
// Push initial CC#7 to every MIDI-routed track so receivers start at the
// stored volume rather than the synth default.
function _initialCcSyncWhenReady() {
  if (!state.midiAccess) { setTimeout(_initialCcSyncWhenReady, 200); return; }
  for (const t of SEQ.tracksList) if (t.output === 'midi') sendTrackChannelVolume(t);
}
_initialCcSyncWhenReady();
seqInitTrackSynths();
rebuildTracksUI();
seqUpdateBarLine();
seqUpdateLoopStart();
document.getElementById('seq-timesig').value  = String(state.beatsPerBar);
document.getElementById('seq-tempo-val').value = state.tempo;
document.getElementById('ctrl-tempo').value    = state.tempo;
document.getElementById('seq-loop-btn').classList.toggle('active', SEQ.loop);
seqRenderAll();
syncTrackLabelHeights();
refreshLucide();
requestAnimationFrame(seqUpdateHints);

// Find or create the lane DOM element for a track.
// Per-track instrument-settings modal. Sliders bind directly to track.synth
// so each track keeps its own ADSR / filter / FX values, even if multiple
// tracks share the same instrument preset.
// curve: 1 = linear; >1 = log-like (most of slider = short, top = long)
// synthOnly: only show this slider when track.instrument === 'synth'
// sync: 'rate' (Hz, snaps to tempo subdivision) | 'time' (seconds) | undefined
// Params where the user's slider OVERRIDES the SF2 generator value (ADSR
// + filter). When the slider differs from the instrument-preset default
// the knob shows an override indicator; double-click clears it.
const OVERRIDE_KEYS = new Set(['attack','decay','sustain','release','filterFreq','filterQ']);
const TRACK_FX_FIELDS = [
  // [key, label, min, max, curve, format, synthOnly, sync]
  ['attack',         'Attack',          0,    15,    3,   v => v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(2) + 's'],
  ['decay',          'Decay',           0,    30,    3,   v => v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(2) + 's'],
  ['sustain',        'Sustain',         0,    1,     1,   v => Math.round(v * 100) + '%'],
  ['release',        'Release',         0,    30,    3,   v => v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(2) + 's'],
  ['filterFreq',     'Tone',          100,    15000, 2.5, v => Math.round(v) + 'Hz'],
  ['filterQ',        'Resonance',       0.1, 20,     2,   v => v.toFixed(1)],
  ['filterLfoDepth', 'Filter LFO',      0,    2000,  2,   v => Math.round(v) + 'c',                            true],
  ['overtones',      'Overtones',       0,    1,     1,   v => Math.round(v * 100) + '%',                      true],
  ['detune',         'Detune',          0,    50,    1,   v => v.toFixed(1) + 'c',                             true],
  ['vibratoRate',    'Vibrato rate',    0.1, 12,     1,   v => v.toFixed(1) + 'Hz',                            false, 'rate'],
  ['vibratoDepth',   'Vibrato depth',   0,    100,   1,   v => Math.round(v) + 'c'],
  ['tremoloRate',    'Tremolo rate',    0.1, 12,     1,   v => v.toFixed(1) + 'Hz',                            false, 'rate'],
  ['tremoloDepth',   'Tremolo depth',   0,    1,     1,   v => Math.round(v * 100) + '%'],
  ['delayWet',       'Delay mix',       0,    1,     1,   v => Math.round(v * 100) + '%'],
  ['delayTime',      'Delay time',      0,    1.5,   1,   v => v.toFixed(2) + 's',                             false, 'time'],
  ['delayFeedback',  'Delay feedback',  0,    0.95,  1,   v => Math.round(v * 100) + '%'],
  ['reverb',         'Reverb',          0,    1,     1,   v => Math.round(v * 100) + '%'],
];

// Snap to musical durations of [1/4, 1/2, 1, 2, 3, 4] beats. For rate
// sliders that's frequency = 1 / (beats * secPerBeat); for time sliders
// it's seconds = beats * secPerBeat.
function fxTempoSnap(kind, current) {
  const T = state.tempo;
  const secPerBeat = 60 / T;
  const beatVals = [0.25, 0.5, 1, 2, 3, 4];
  if (kind === 'rate') {
    const candidates = beatVals.map(b => 1 / (b * secPerBeat));
    return candidates.reduce((best, c) => Math.abs(c - current) < Math.abs(best - current) ? c : best);
  } else if (kind === 'time') {
    const candidates = beatVals.map(b => b * secPerBeat);
    return candidates.reduce((best, c) => Math.abs(c - current) < Math.abs(best - current) ? c : best);
  }
  return current;
}
// Convert between normalized [0..1000] slider position and actual value via
// the field's curve exponent (1 = linear, >1 = log-like).
function fxSliderToVal(min, max, curve, slider) {
  const norm = Math.max(0, Math.min(1, slider / 1000));
  return min + (max - min) * Math.pow(norm, curve);
}
function fxValToSlider(min, max, curve, value) {
  const v = Math.max(min, Math.min(max, value));
  if (max === min) return 0;
  const norm = Math.pow((v - min) / (max - min), 1 / curve);
  return Math.round(norm * 1000);
}
document.getElementById('kb-settings-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.blur();
  openTrackFxModal(state.keyboardTrack);
});

function openTrackFxModal(track) {
  const modal = document.getElementById('track-fx-modal');
  const body  = document.getElementById('track-fx-body');
  const title = document.getElementById('track-fx-title');
  if (!modal || !body || !title) return;
  modal.dataset.trackId = track.id;
  // Show the modal up front. (Used to be at the end of the function, but the
  // MIDI-output branch returns early before that line, which left the modal
  // invisible the first time you opened it on a MIDI-routed track.)
  modal.hidden = false;
  // Clean up any submenus that were hoisted to body in a previous open.
  document.querySelectorAll('body > .track-fx-inst-submenu').forEach(sm => sm.remove());
  // Ensure the track has its own synth dict (pad-linked first-chord may be null)
  if (!track.synth) track.synth = { ...state.synth };
  title.textContent = track.name + ' · settings';
  body.innerHTML = '';
  const preset = INSTRUMENT_PRESETS?.[track.instrument] || INSTRUMENT_PRESETS?.default;
  const sliderEls = {};
  // Tiny ADSR diagram in the modal header — recalculated on every A/D/S/R
  // change so the curve mirrors the slider state.
  const adsrPath = document.getElementById('track-fx-adsr-path');
  const adsrDividers = document.getElementById('track-fx-adsr-dividers');
  const adsrLabels   = document.getElementById('track-fx-adsr-labels');
  const updateAdsr = () => {
    if (!adsrPath) return;
    const W = 60, H = 40;
    const TOP = 10; // reserved for letters
    // Visual scaling uses "typical" maxes so common values fill the diagram
    // nicely. Actual slider ranges go higher (15s/30s) but those would make
    // the curve look unbalanced if normalised to full range.
    const a = Math.min(track.synth.attack  ?? 0.1, 4)  / 4;
    const d = Math.min(track.synth.decay   ?? 0.5, 8)  / 8;
    const s = Math.max(0, Math.min(track.synth.sustain ?? 0.4, 1));
    const r = Math.min(track.synth.release ?? 1,   6)  / 6;
    const total = a + d + 1 + r;
    const aPx = (a / total) * W;
    const dPx = (d / total) * W;
    const sPx = (1 / total) * W;
    const rPx = (r / total) * W;
    const peakY    = TOP + 2;
    const baseY    = H - 2;
    const sustainY = baseY - (baseY - peakY) * s;
    const x0 = 0;
    const x1 = x0 + aPx;
    const x2 = x1 + dPx;
    const x3 = x2 + sPx;
    const x4 = x3 + rPx;
    const stroked =
      `M ${x0} ${baseY}` +
      ` L ${x1} ${peakY}` +
      ` Q ${x1} ${sustainY} ${x2} ${sustainY}` +
      ` L ${x3} ${sustainY}` +
      ` Q ${x3} ${baseY} ${x4} ${baseY}`;
    adsrPath.setAttribute('d', stroked);
    const fillEl = document.getElementById('track-fx-adsr-fill');
    if (fillEl) fillEl.setAttribute('d', stroked + ' Z');
    // Dividers
    if (adsrDividers) {
      adsrDividers.innerHTML = [x1, x2, x3].map(x =>
        `<line x1="${x}" y1="${TOP}" x2="${x}" y2="${baseY}" stroke="rgba(255,255,255,0.18)" stroke-width="0.5" stroke-dasharray="1 1"/>`
      ).join('');
    }
    // Section labels — placed at section midpoints, but pushed apart so they
    // never overlap. Each letter keeps its ideal position when there's room.
    if (adsrLabels) {
      const letters = ['A', 'D', 'S', 'R'];
      const ideals = [(x0 + x1) / 2, (x1 + x2) / 2, (x2 + x3) / 2, (x3 + x4) / 2];
      const letterW = 5; // approx glyph width at font-size 9
      const minGap  = letterW;
      const positions = [];
      // Left → right pass: each label is at least minGap right of previous
      for (let i = 0; i < ideals.length; i++) {
        const minX = i === 0 ? letterW / 2 : positions[i - 1] + minGap;
        positions[i] = Math.max(ideals[i], minX);
      }
      // Right → left pass: clamp from the right so labels don't fall off-edge
      for (let i = ideals.length - 1; i >= 0; i--) {
        const maxX = i === ideals.length - 1 ? W - letterW / 2 : positions[i + 1] - minGap;
        positions[i] = Math.min(positions[i], maxX);
      }
      adsrLabels.innerHTML = letters.map((letter, i) =>
        `<text x="${positions[i]}" y="8" text-anchor="middle" fill="rgba(255,255,255,0.55)" font-size="9" font-family="JetBrains Mono, monospace">${letter}</text>`
      ).join('');
    }
  };
  // Output row — toggle between in-app instrument and external MIDI. When
  // MIDI is selected, a small "Ch [n]" textfield appears inline next to the
  // toggle for the channel number. No in-app synth params follow in MIDI mode.
  const outRow = document.createElement('div');
  outRow.className = 'track-fx-row track-fx-row-select';
  outRow.innerHTML = `
    <label class="track-fx-label">Output</label>
    <div class="track-fx-output-toggle">
      <button class="track-fx-out-btn${track.output !== 'midi' ? ' active' : ''}" data-out="instrument">Instrument</button>
      <button class="track-fx-out-btn${track.output === 'midi' ? ' active' : ''}" data-out="midi">MIDI</button>
    </div>
  `;
  // MIDI output port selector — second row under Output when MIDI mode.
  const portRow = document.createElement('div');
  portRow.className = 'track-fx-row track-fx-row-select track-fx-port-row';
  if (track.output !== 'midi') portRow.classList.add('hidden');
  const ports = state.midiAccess ? Array.from(state.midiAccess.outputs.values()) : [];
  portRow.innerHTML = `
    <label class="track-fx-label">MIDI out</label>
    <select class="track-fx-select track-fx-port-select" style="flex:1; width:100%">
      <option value="">— default —</option>
      ${ports.map(p => `<option value="${escapeHtml(p.id)}"${p.id === (track.midiPortId || '') ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
    </select>
    <label class="track-fx-ch-inline">
      <span>Ch</span>
      <input type="text" inputmode="numeric" pattern="[0-9]*" class="track-fx-ch-input" maxlength="2" value="${track.channel + 1}">
    </label>
  `;
  // Channel input lives on the port row now; wire it.
  portRow.querySelector('.track-fx-ch-input')?.addEventListener('change', (e) => {
    seqCheckpoint();
    const v = Math.max(1, Math.min(16, parseInt(e.target.value, 10) || 1));
    e.target.value = v;
    track.channel = v - 1;
    seqSave();
  });
  portRow.querySelector('select').addEventListener('change', (e) => {
    seqCheckpoint();
    track.midiPortId = e.target.value;
    seqSave();
  });
  // MIDI input port selector — always shown, lets the track play live from
  // an external keyboard through its own instrument. Empty = no input.
  const inRow = document.createElement('div');
  inRow.className = 'track-fx-row track-fx-row-select track-fx-in-port-row';
  if (track.output !== 'midi') inRow.classList.add('hidden');
  const inputs = state.midiAccess ? Array.from(state.midiAccess.inputs.values()) : [];
  inRow.innerHTML = `
    <label class="track-fx-label">MIDI in</label>
    <select class="track-fx-select track-fx-port-select" style="flex:1; width:100%">
      <option value="">— none —</option>
      ${inputs.map(p => `<option value="${escapeHtml(p.id)}"${p.id === (track.midiInPortId || '') ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
    </select>
    <span class="track-fx-val"></span>
  `;
  inRow.querySelector('select').addEventListener('change', (e) => {
    seqCheckpoint();
    track.midiInPortId = e.target.value;
    attachMidiInput();
    seqSave();
  });
  outRow.querySelectorAll('.track-fx-out-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.out;
      if (next === track.output) return;
      seqCheckpoint();
      track.output = next;
      if (next === 'midi') sendTrackChannelVolume(track);
      seqSave();
      openTrackFxModal(track);   // rebuild with new conditional layout
      seqRenderTrack(track);     // header doesn't show output anymore, but keep things fresh
    });
  });
  body.appendChild(outRow);
  body.appendChild(portRow);
  body.appendChild(inRow);

  // ADSR graph is only meaningful for the in-app synth; hide for MIDI output.
  const adsrEl = document.getElementById('track-fx-adsr');
  if (adsrEl) adsrEl.classList.toggle('hidden', track.output === 'midi');

  if (track.output === 'midi') {
    refreshLucide();
    return;
  }

  // Instrument picker at the top of the modal — same dropdown options as
  // were in the sidebar header. For the pad-linked first chord track this
  // Each track has its own instrument selection — chord-pad widget voice
  // and chord-track voice are independent.
  const instRow = document.createElement('div');
  instRow.className = 'track-fx-row track-fx-row-select';
  const curInst = seqTrackInstrument(track);
  instRow.innerHTML = `
    <label class="track-fx-label">Instrument</label>
    <div class="track-fx-inst-picker">
      <button type="button" class="track-fx-inst-btn">
        <span class="track-fx-inst-label">${escapeHtml(instrumentDisplayName(curInst))}</span>
        <span class="track-fx-inst-chev">▾</span>
      </button>
      <div class="track-fx-inst-menu" hidden>
        <button type="button" class="track-fx-inst-item" data-inst="synth">
          <span class="track-fx-inst-item-name">Synth</span>
        </button>
        ${GM_CATEGORIES.map(cat => `
          <div class="track-fx-inst-cat">
            <button type="button" class="track-fx-inst-cat-btn">
              <span>${cat.name}</span>
              <span class="track-fx-inst-cat-chev">›</span>
            </button>
            <div class="track-fx-inst-submenu" hidden>
              ${cat.presets.map(p => {
                const id = SF2_PRESET_TO_SHORT[p.n] || ('gm' + p.n);
                return `<button type="button" class="track-fx-inst-item" data-inst="${id}">
                  <span class="track-fx-inst-item-name">${escapeHtml(p.name)}</span>
                </button>`;
              }).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
    <span class="track-fx-val"></span>
  `;
  const instBtn   = instRow.querySelector('.track-fx-inst-btn');
  const instMenu  = instRow.querySelector('.track-fx-inst-menu');
  const instLabel = instRow.querySelector('.track-fx-inst-label');
  const closeMenu = () => {
    instMenu.hidden = true;
    // Collect ALL submenus, including ones we hoisted to body.
    document.querySelectorAll('.track-fx-inst-submenu').forEach(sm => sm.hidden = true);
  };
  instBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    instMenu.hidden = !instMenu.hidden;
    if (instMenu.hidden) { closeMenu(); return; }
    // On open, scroll the menu so the category containing the current
    // instrument is visible, and expand its submenu next to it.
    const curId = seqTrackInstrument(track);
    // Mark current selection across all items (including body-hoisted submenus).
    document.querySelectorAll('.track-fx-inst-item.selected').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll(`.track-fx-inst-item[data-inst="${curId}"]`).forEach(el => el.classList.add('selected'));
    const curItem = document.querySelector(`.track-fx-inst-item[data-inst="${curId}"]`);
    if (curItem) {
      const cat = curItem.closest('.track-fx-inst-cat')
                 || instMenu.querySelector('.track-fx-inst-cat:has([data-inst="' + curId + '"])');
      // If item belongs to a category submenu, find that cat via stored ref.
      let ownerCat = cat;
      if (!ownerCat) {
        instMenu.querySelectorAll('.track-fx-inst-cat').forEach(c => {
          if (c._submenu && c._submenu.contains(curItem)) ownerCat = c;
        });
      }
      if (ownerCat) {
        ownerCat.scrollIntoView({ block: 'nearest' });
        const subm = ownerCat._submenu;
        if (subm) {
          hideOtherSubmenus(subm);
          positionSubmenu(ownerCat, subm);
          subm.hidden = false;
          curItem.scrollIntoView({ block: 'nearest' });
        }
      } else {
        curItem.scrollIntoView({ block: 'nearest' });
      }
    }
  });
  // Hover (and focus via click) on a category opens its submenu. The
  // submenu is position:fixed so it can escape the menu's scroll/overflow.
  const positionSubmenu = (catEl, submenu) => {
    // Hoist submenu to the body so it's not clipped or shifted by the
    // scrolling/transformed parent menu.
    if (submenu.parentElement !== document.body) document.body.appendChild(submenu);
    const menuRect = instMenu.getBoundingClientRect();
    const catRect  = catEl.getBoundingClientRect();
    const subW = 170;
    let left = menuRect.right + 2;
    if (left + subW > window.innerWidth - 8) {
      left = Math.max(8, menuRect.left - subW - 2);
    }
    submenu.style.left = left + 'px';
    submenu.style.top  = catRect.top + 'px';
  };
  // Remember each category's submenu by reference (it may be hoisted to body).
  instMenu.querySelectorAll('.track-fx-inst-cat').forEach(cat => {
    cat._submenu = cat.querySelector('.track-fx-inst-submenu');
  });
  const hideOtherSubmenus = (keep) => {
    document.querySelectorAll('.track-fx-inst-submenu').forEach(sm => {
      if (sm !== keep) sm.hidden = true;
    });
  };
  // Hovering a non-category top-level item (e.g. "Synth") closes any open submenu.
  instMenu.querySelectorAll(':scope > .track-fx-inst-item').forEach(item => {
    item.addEventListener('mouseenter', () => hideOtherSubmenus(null));
  });
  instMenu.querySelectorAll('.track-fx-inst-cat-btn').forEach(btn => {
    const cat = btn.closest('.track-fx-inst-cat');
    const submenu = cat._submenu;
    cat.addEventListener('mouseenter', () => {
      hideOtherSubmenus(submenu);
      positionSubmenu(cat, submenu);
      submenu.hidden = false;
    });
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (submenu.hidden) { hideOtherSubmenus(submenu); positionSubmenu(cat, submenu); submenu.hidden = false; }
      else submenu.hidden = true;
    });
    // Keep submenu open while pointer is over it
    submenu.addEventListener('mouseenter', () => { hideOtherSubmenus(submenu); submenu.hidden = false; });
  });
  // Close all submenus when leaving the dropdown area entirely.
  instMenu.addEventListener('mouseleave', () => {
    setTimeout(() => {
      document.querySelectorAll('.track-fx-inst-submenu').forEach(sm => {
        if (!sm.matches(':hover')) sm.hidden = true;
      });
    }, 100);
  });
  // Outside-click closes
  setTimeout(() => {
    document.addEventListener('mousedown', function _outside(ev) {
      // Body-hoisted submenus live outside instRow; treat them as inside too.
      const inSubmenu = ev.target.closest && ev.target.closest('.track-fx-inst-submenu');
      if (!instRow.contains(ev.target) && !inSubmenu) {
        closeMenu();
        document.removeEventListener('mousedown', _outside);
      }
    });
  }, 0);
  const handleInstChange = (nextInst) => {
    seqCheckpoint();
    track.instrument = nextInst;
    // Match the original behavior: only swap track.synth wholesale when
    // the new instrument has its own named preset. For GM (`gm<N>`)
    // entries we leave track.synth alone so previously-tuned values and
    // (further down) the SF2-generator overlay are the only things that
    // touch it.
    const newPreset = INSTRUMENT_PRESETS?.[nextInst];
    if (newPreset) track.synth = { ...newPreset };
    seqSave();
    if (INSTRUMENT_TO_SF2[nextInst] != null) {
      loadSf2('fluid').then(() => {
        const fluid = SF2_FILES.fluid.sf2;
        if (!fluid) return;
        prewarmSf2Preset(fluid, INSTRUMENT_TO_SF2[nextInst]);
        const sf2Defs = readSf2Defaults(fluid, INSTRUMENT_TO_SF2[nextInst]);
        if (sf2Defs) {
          if (!track.synth) track.synth = { ...INSTRUMENT_PRESETS.default };
          Object.assign(track.synth, sf2Defs);
          track.synth._override = {};
          openTrackFxModal(track);
        }
      });
    } else if (nextInst !== 'synth') {
      preloadSamples(nextInst);
    }
    // Reopen modal so the synth-only sliders refresh for the new instrument.
    openTrackFxModal(track);
  };
  // Wire menu items to call handleInstChange with their data-inst id.
  instMenu.querySelectorAll('.track-fx-inst-item').forEach(item => {
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      instLabel.textContent = item.querySelector('.track-fx-inst-item-name').textContent;
      handleInstChange(item.dataset.inst);
    });
  });
  body.appendChild(instRow);

  const isSynth = track.instrument === 'synth';
  // Waveform picker (synth only) at the top of the body
  if (isSynth) {
    const row = document.createElement('div');
    row.className = 'track-fx-row track-fx-row-select';
    const cur = track.synth.waveform || preset?.waveform || 'sine';
    row.innerHTML = `
      <label class="track-fx-label">Waveform</label>
      <select class="track-fx-select">
        <option value="sine"${cur === 'sine' ? ' selected' : ''}>Sine</option>
        <option value="triangle"${cur === 'triangle' ? ' selected' : ''}>Triangle</option>
        <option value="sawtooth"${cur === 'sawtooth' ? ' selected' : ''}>Sawtooth</option>
        <option value="square"${cur === 'square' ? ' selected' : ''}>Square</option>
      </select>
      <span class="track-fx-val"></span>
    `;
    const sel = row.querySelector('select');
    sel.addEventListener('change', () => { seqCheckpoint(); track.synth.waveform = sel.value; });
    sliderEls.waveform = { select: sel };
    body.appendChild(row);
  }
  // Build a knob (matches the volume knob in the sidebar) for one FX field.
  // Drag (X + Y axes, like the volume knob), wheel-scroll, dblclick-reset.
  // Returns { setValue, valEl } refs so reset-to-preset can update everything.
  const fieldMap = Object.fromEntries(TRACK_FX_FIELDS.map(f => [f[0], f]));
  function makeFxKnob(key) {
    const [, label, min, max, curve, fmt, , sync] = fieldMap[key];
    const cur = (track.synth[key] !== undefined) ? track.synth[key] : (preset?.[key] ?? min);
    const cell = document.createElement('div');
    cell.className = 'track-fx-knob-cell';
    const overridable = OVERRIDE_KEYS.has(key);
    const knobTitle = overridable ? 'Double-click to clear override' : '';
    cell.innerHTML = `
      <span class="track-fx-knob-val">${fmt(cur)}</span>
      <span class="track-fx-knob"${knobTitle ? ` title="${knobTitle}"` : ''}><span class="track-fx-knob-ind"></span></span>
      <span class="track-fx-knob-label">${label.replace(/ /g, '<br>')}${sync ? '<button class="track-fx-sync" title="Snap to tempo"><i data-lucide="refresh-cw"></i></button>' : ''}</span>
    `;
    const knob   = cell.querySelector('.track-fx-knob');
    const valEl  = cell.querySelector('.track-fx-knob-val');
    const apply  = (v) => {
      v = Math.max(min, Math.min(max, v));
      track.synth[key] = v;
      valEl.textContent = fmt(v);
      const norm = Math.pow((v - min) / (max - min || 1), 1 / curve);
      knob.style.setProperty('--ang', (-135 + norm * 270) + 'deg');
      if (key === 'attack' || key === 'decay' || key === 'sustain' || key === 'release') updateAdsr();
      if (overridable) {
        const isSf2 = INSTRUMENT_TO_SF2?.[track.instrument] != null;
        cell.classList.toggle('is-override', !!(isSf2 && track.synth._override?.[key]));
      }
    };
    const setOverride = (on) => {
      if (!overridable) return;
      if (!track.synth._override) track.synth._override = {};
      if (on) track.synth._override[key] = true;
      else delete track.synth._override[key];
    };
    apply(cur);
    knob.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      knob.setPointerCapture(e.pointerId);
      seqCheckpoint();
      setOverride(true);
      const startX = e.clientX, startY = e.clientY;
      const startNorm = Math.pow((track.synth[key] - min) / (max - min || 1), 1 / curve);
      const onMove = (ev) => {
        const speed = ev.shiftKey ? 4 : 1;
        const delta = ((startY - ev.clientY) + (ev.clientX - startX)) / speed;
        const norm  = Math.max(0, Math.min(1, startNorm + delta / 200));
        apply(min + (max - min) * Math.pow(norm, curve));
      };
      const onUp = () => {
        knob.removeEventListener('pointermove', onMove);
        knob.removeEventListener('pointerup', onUp);
        seqSave();
      };
      knob.addEventListener('pointermove', onMove);
      knob.addEventListener('pointerup', onUp);
    });
    knob.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (preset?.[key] === undefined) return;
      seqCheckpoint();
      setOverride(false);
      apply(preset[key]);
      seqSave();
    });
    knob.addEventListener('wheel', (e) => {
      e.preventDefault();
      const norm = Math.pow((track.synth[key] - min) / (max - min || 1), 1 / curve);
      const step = e.shiftKey ? 0.005 : 0.02;
      const next = Math.max(0, Math.min(1, norm - Math.sign(e.deltaY) * step));
      seqCheckpoint();
      setOverride(true);
      apply(min + (max - min) * Math.pow(next, curve));
      seqSave();
    }, { passive: false });
    if (sync) {
      cell.querySelector('.track-fx-sync')?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        seqCheckpoint();
        const snapped = fxTempoSnap(sync, track.synth[key] ?? cur);
        apply(snapped);
        seqSave();
      });
    }
    sliderEls[key] = { valEl, setValue: apply, fmt, min, max, curve };
    return cell;
  }
  // Flat grid of all applicable knobs — no grouping.
  const knobGrid = document.createElement('div');
  knobGrid.className = 'track-fx-knobs';
  let _fxHdrInserted = false;
  for (const [key, , , , , , synthOnly] of TRACK_FX_FIELDS) {
    if (synthOnly && !isSynth) continue;
    if (!_fxHdrInserted && (key === 'delayWet' || key === 'reverb')) {
      const hdr = document.createElement('div');
      hdr.className = 'cp-modal-fx-divider';
      hdr.textContent = 'Send FX';
      knobGrid.appendChild(hdr);
      _fxHdrInserted = true;
    }
    knobGrid.appendChild(makeFxKnob(key));
  }
  body.appendChild(knobGrid);
  refreshLucide();
  updateAdsr();
  // Reset-to-preset button row
  const resetRow = document.createElement('div');
  resetRow.className = 'track-fx-reset-row';
  resetRow.innerHTML = `<button class="track-fx-reset" type="button">Reset to ${instrumentDisplayName(track.instrument) || 'preset'} defaults</button>`;
  resetRow.querySelector('button').addEventListener('click', () => {
    if (!preset) return;
    seqCheckpoint();
    track.synth._override = {};
    for (const [key, , , , , , synthOnly] of TRACK_FX_FIELDS) {
      if (synthOnly && !isSynth) continue;
      if (preset[key] === undefined) continue;
      const el = sliderEls[key];
      if (el && el.setValue) el.setValue(preset[key]);
      else track.synth[key] = preset[key];
    }
    if (isSynth && preset.waveform && sliderEls.waveform?.select) {
      track.synth.waveform = preset.waveform;
      sliderEls.waveform.select.value = preset.waveform;
    }
    updateAdsr();
  });
  body.appendChild(resetRow);
  modal.hidden = false;
}
function closeTrackFxModal() {
  const modal = document.getElementById('track-fx-modal');
  if (modal) modal.hidden = true;
  // Clean up any orphan submenus we hoisted onto the body.
  document.querySelectorAll('body > .track-fx-inst-submenu').forEach(sm => sm.remove());
  seqSave();
}
document.getElementById('track-fx-close')?.addEventListener('click', closeTrackFxModal);
document.querySelector('.track-fx-backdrop')?.addEventListener('click', closeTrackFxModal);

function ensureTrackLane(track) {
  let lane = document.querySelector(`.seq-lane[data-track-id="${track.id}"]`);
  if (lane) {
    lane.classList.add('lane-' + track.kind);
    return lane;
  }
  lane = document.createElement('div');
  lane.className = 'seq-lane lane-' + track.kind;
  lane.dataset.trackId = track.id;
  lane.style.minHeight = '54px';
  // Insert before the resize handle / add-track-button so new lanes
  // appear above any trailing controls inside the inner container.
  const inner  = document.getElementById('seq-tracks-inner');
  const handle = inner.querySelector('.midi-lane-resize-handle');
  if (handle) inner.insertBefore(lane, handle);
  else        inner.appendChild(lane);
  // Wire drag-drop behaviour appropriate for the track's kind
  if (track.kind === 'chord') initChordLane(lane);
  else                         initFreeLane(lane);
  return lane;
}

// HTML5 drag-and-drop on the track sidebar to reorder SEQ.tracksList.
// Pointerdown on a button/input cancels the drag so editing controls keep
// working. A small accent line above/below the hovered label indicates
// drop-position.
function _wireTrackDrag(label) {
  label.dataset.dragWired = '1';
  label.addEventListener('dragstart', (e) => {
    if (e.target.closest('button, input, select, .seq-th-knob')) {
      e.preventDefault(); return;
    }
    // copyMove (not just move) — otherwise browsers reject the
    // dragover's 'copy' dropEffect when Alt is held, and the drop
    // silently does a plain move instead of duplicating.
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/x-track-id', label.dataset.trackId);
    label.classList.add('dragging');
  });
  label.addEventListener('dragend', () => {
    label.classList.remove('dragging');
    document.querySelectorAll('.seq-track-label.drop-before, .seq-track-label.drop-after')
      .forEach(el => el.classList.remove('drop-before', 'drop-after'));
  });
  label.addEventListener('dragover', (e) => {
    const draggingId = document.querySelector('.seq-track-label.dragging')?.dataset.trackId;
    if (!draggingId) return;
    // Alt-drag DUPLICATES — allow dropping on the source itself too.
    if (!e.altKey && draggingId === label.dataset.trackId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
    const rect = label.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    label.classList.toggle('drop-before', before);
    label.classList.toggle('drop-after', !before);
  });
  label.addEventListener('dragleave', () => {
    label.classList.remove('drop-before', 'drop-after');
  });
  label.addEventListener('drop', (e) => {
    e.preventDefault();
    const srcId = e.dataTransfer.getData('text/x-track-id');
    const tgtId = label.dataset.trackId;
    const before = label.classList.contains('drop-before');
    const altCopy = e.altKey;
    label.classList.remove('drop-before', 'drop-after');
    if (!srcId) return;
    // Alt-drag = duplicate the source track (with fresh ids on the
    // track + every clip) and insert at the target slot. Plain drag
    // re-orders the existing track.
    const list = SEQ.tracksList;
    const srcIdx = list.findIndex(t => t.id === srcId);
    const tgtIdx = list.findIndex(t => t.id === tgtId);
    if (srcIdx < 0 || tgtIdx < 0) return;
    seqCheckpoint();
    if (altCopy) {
      const src = list[srcIdx];
      // Deep clone the track via JSON, then rewrite ids so we don't
      // accidentally share refs with the source. Items array gets a
      // fresh id per clip via newClipId().
      const clone = JSON.parse(JSON.stringify(src));
      clone.id = newTrackId();
      // Append a "copy" suffix only if the name doesn't already end with one.
      clone.name = /\bcopy\b/i.test(src.name) ? src.name : src.name + ' copy';
      if (Array.isArray(clone.items)) {
        for (const it of clone.items) {
          if (it && typeof it === 'object' && 'notes' in it) {
            it.id = newClipId();
          }
        }
      }
      // Drop transient playback state.
      clone.pendingIdx = 0; clone.pendingTime = 0; clone.cycleStart = 0;
      clone.activeIdx = -1; clone.dragSrcIdx = null; clone.dropTarget = null;
      clone._scheduled = null; clone._flatNotes = null; clone._flatDirty = true;
      let insertAt = tgtIdx;
      if (!before) insertAt += 1;
      list.splice(insertAt, 0, clone);
    } else {
      if (srcId === tgtId) return;
      const [moved] = list.splice(srcIdx, 1);
      let insertAt = list.findIndex(t => t.id === tgtId);
      if (!before) insertAt += 1;
      list.splice(insertAt, 0, moved);
    }
    rebuildTracksUI();
    seqRenderAll();
    seqSave();
  });
}

// Find or create the sidebar header for a track.
function ensureTrackHeader(track) {
  let label = document.querySelector(`.seq-track-label[data-track-id="${track.id}"]`);
  if (!label) {
    label = document.createElement('div');
    label.className = 'seq-track-label';
    label.dataset.trackId = track.id;
    label.draggable = true;
    _wireTrackDrag(label);
    const addBtn = document.getElementById('seq-add-track-btn');
    document.getElementById('seq-track-sidebar').insertBefore(label, addBtn);
  } else if (!label.dataset.dragWired) {
    label.draggable = true;
    _wireTrackDrag(label);
  }
  populateTrackHeader(label, track);
  return label;
}

function populateTrackHeader(label, track) {
  const padLinked = (track === firstTrackOfKind('chord'));
  const convertBtn = track.kind === 'chord'
    ? `<button class="seq-th-convert" title="Convert to Free (bake chords to notes — one way)"><i data-lucide="arrow-right-from-line"></i></button>`
    : '';
  // Per-track record arm button — free tracks only. When armed and Play
  // starts, any MIDI input on this track's midiInPortId gets captured
  // into a new clip.
  const armBtn = track.kind === 'free'
    ? `<button class="seq-th-arm${track.armed ? ' armed' : ''}" title="Arm for MIDI recording"><i data-lucide="circle"></i></button>`
    : '';
  label.innerHTML = `
    <div class="seq-th-row seq-th-top">
      <span class="seq-th-name" title="Click to focus · double-click to rename">${escapeHtml(track.name)}</span>
      ${armBtn}
      ${convertBtn}
      <button class="seq-th-fx" title="Track instrument settings"><i data-lucide="sliders-horizontal"></i></button>
      <button class="seq-th-collapse" title="Collapse / expand"><i data-lucide="chevrons-down-up"></i></button>
      <button class="seq-th-del" title="Remove track">✕</button>
    </div>`;
  // Append the rest of the header rows (mixer row). Instrument picker
  // lives in the per-track FX modal now.
  label.insertAdjacentHTML('beforeend', `
    <div class="seq-th-row seq-th-bot">
      <button class="seq-th-m${track.muted ? ' on' : ''}" title="Mute">M</button>
      <button class="seq-th-s${track.soloed ? ' on' : ''}" title="Solo">S</button>
      <span class="seq-th-knob" data-value="${track.volume}" title="${track.output === 'midi' ? 'Velocity scale — drag up/down (double-click to reset)' : 'Volume — drag up/down (double-click to reset)'}"><span class="seq-th-knob-ind"></span></span>
    </div>
  `);
  if (track.kind === 'chord') {
    label.querySelector('.seq-th-convert')?.addEventListener('click', (e) => {
      e.stopPropagation();
      convertChordToFree(track);
    });
  }
  if (track.kind === 'free') {
    label.querySelector('.seq-th-arm')?.addEventListener('click', (e) => {
      e.stopPropagation();
      e.currentTarget.blur();
      track.armed = !track.armed;
      e.currentTarget.classList.toggle('armed', track.armed);
      // Mirror to global REC.armed so Play can call recActivate.
      REC.armed = SEQ.tracksList.some(t => t.armed);
      const recBtn = document.getElementById('seq-rec-btn');
      if (recBtn) recBtn.classList.toggle('armed', REC.armed && !REC.active);
    });
  }
  // Keep events from bubbling up to the lane behind the sidebar
  const stop = (e) => e.stopPropagation();
  label.querySelectorAll('select, input, button').forEach(el => {
    el.addEventListener('mousedown', stop);
    el.addEventListener('click', stop);
  });

  label.querySelector('.seq-th-fx')?.addEventListener('click', (e) => {
    e.stopPropagation();
    e.currentTarget.blur();  // drop focus so :hover/focus accent doesn't linger after the modal opens
    openTrackFxModal(track);
  });
  label.querySelector('.seq-th-collapse').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTrackCollapse(label, track);
  });
  // Click → bind Instrument panel. (Piano-roll is opened by clicking a
  // CLIP block in the arrangement, not by clicking the track name.)
  // Double-click → rename.
  const nameEl = label.querySelector('.seq-th-name');
  nameEl.addEventListener('click', (e) => {
    e.stopPropagation();
    setSynthEditTarget(padLinked ? 'pad' : (track.kind === 'free' ? 'free' : 'pad'));
    document.querySelector('.synth-controls')?.classList.remove('collapsed');
  });
  nameEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startInlineRename(nameEl, track);
  });
  label.querySelector('.seq-th-del').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteTrack(track.id);
  });

  // Mute and Solo are mutually exclusive: turning one on clears the other.
  const muteBtn = label.querySelector('.seq-th-m');
  const soloBtn = label.querySelector('.seq-th-s');
  muteBtn.addEventListener('click', () => {
    seqCheckpoint();
    track.muted = !track.muted;
    if (track.muted) track.soloed = false;
    muteBtn.classList.toggle('on', track.muted);
    soloBtn.classList.toggle('on', track.soloed);
    seqSave();
  });
  soloBtn.addEventListener('click', () => {
    seqCheckpoint();
    track.soloed = !track.soloed;
    if (track.soloed) track.muted = false;
    muteBtn.classList.toggle('on', track.muted);
    soloBtn.classList.toggle('on', track.soloed);
    seqSave();
  });
  // Volume knob: drag up = louder, drag down = softer. Sweep is 270°, from
  // ~7-o'clock (min=0) clockwise through top to ~5-o'clock (max=1.5).
  const knob = label.querySelector('.seq-th-knob');
  const VOL_MIN = 0, VOL_MAX = 1.5;
  const knobUpdate = () => {
    const v = Math.max(VOL_MIN, Math.min(VOL_MAX, track.volume));
    const frac = (v - VOL_MIN) / (VOL_MAX - VOL_MIN);
    const ang  = -135 + frac * 270;
    knob.style.setProperty('--ang', ang + 'deg');
  };
  knobUpdate();
  knob.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    knob.setPointerCapture(e.pointerId);
    seqCheckpoint();
    const startX  = e.clientX;
    const startY  = e.clientY;
    const startV  = track.volume;
    // 200px of drag covers the full 0..1.5 range. Up AND right both
    // increase volume; down AND left both decrease. Hold Shift for fine
    // control (4× slower).
    // Throttle CC#7 sends so we don't flood the MIDI bus during fast drags.
    let lastCcT = 0;
    const sendCcThrottled = () => {
      if (track.output !== 'midi') return;
      const now = performance.now();
      if (now - lastCcT < 25) return;
      lastCcT = now;
      sendTrackChannelVolume(track);
    };
    const onMove = (ev) => {
      const speed = ev.shiftKey ? 4 : 1;
      const delta = ((startY - ev.clientY) + (ev.clientX - startX)) / speed;
      const next  = Math.max(VOL_MIN, Math.min(VOL_MAX, startV + delta / 200 * (VOL_MAX - VOL_MIN)));
      track.volume = next;
      knobUpdate();
      sendCcThrottled();
    };
    const onUp = () => {
      knob.removeEventListener('pointermove', onMove);
      knob.removeEventListener('pointerup', onUp);
      sendTrackChannelVolume(track); // final value
      seqSave();
    };
    knob.addEventListener('pointermove', onMove);
    knob.addEventListener('pointerup', onUp);
  });
  knob.addEventListener('dblclick', (e) => {
    e.preventDefault(); e.stopPropagation();
    seqCheckpoint();
    track.volume = 1.0;
    knobUpdate();
    sendTrackChannelVolume(track);
    seqSave();
  });
  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = e.shiftKey ? 0.01 : 0.05;
    track.volume = Math.max(VOL_MIN, Math.min(VOL_MAX, track.volume - Math.sign(e.deltaY) * step));
    knobUpdate();
    sendTrackChannelVolume(track);
    seqSave();
  }, { passive: false });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

function startInlineRename(nameEl, track) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'seq-th-name-input';
  input.value = track.name;
  input.maxLength = 30;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  const finish = (commit) => {
    if (commit) {
      const v = input.value.trim();
      if (v && v !== track.name) {
        seqCheckpoint();
        track.name = v;
      }
      seqSave();
    }
    rebuildTracksUI();
    // Keep the piano-roll title in sync if this track owns the open clip.
    if (SEQ.focusedClip?.trackId === track.id) refreshPianoRollTitle();
  };
  input.addEventListener('blur',    () => finish(true));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
}


// One-way conversion: bake all chord blocks into free-track note items.
// The track keeps its id, name, instrument, mixer settings and synth, but
// its kind flips to 'free' and the blocks become individual notes.
function convertChordToFree(track) {
  if (!track || track.kind !== 'chord') return;
  seqCheckpoint();
  // Rename so the header reflects the kind change (one-way conversion).
  if (track.name === 'Chords')               track.name = 'Notes';
  else if (/^Chords (\d+)$/.test(track.name)) track.name = track.name.replace(/^Chords /, 'Notes ');
  else                                        track.name = track.name + ' · notes';
  // Each chord-block becomes a CLIP containing that chord's notes.
  const clips = [];
  for (const block of track.items) {
    const shift = block.semitoneShift || 0;
    const midis = chordToMidiNotes(block.keyRoot, state.octave, block.interval, block.q)
      .map(n => Math.max(0, Math.min(127, n + shift)));
    const notes = midis.map(midi => ({
      midi, label: midiNoteLabel(midi),
      start: 0, beats: block.beats,
    }));
    clips.push(makeClip({
      start: block.start, beats: block.beats,
      label: block.label || null,
      notes,
    }));
  }
  clips.sort((a, b) => a.start - b.start);
  track.items = clips;
  track.kind  = 'free';
  // Reset playback cursor in case we were playing
  track.pendingIdx = 0;
  track.pendingTime = 0;
  // The lane element keeps the same data-track-id but its bound drag-drop
  // logic was the chord variant — replace it with a fresh free-kind lane
  // at the SAME DOM position so the visual order is preserved.
  const oldLane = document.querySelector(`.seq-lane[data-track-id="${track.id}"]`);
  if (oldLane) {
    const parent = oldLane.parentNode;
    const newLane = document.createElement('div');
    newLane.className = 'seq-lane';
    newLane.dataset.trackId = track.id;
    parent.insertBefore(newLane, oldLane);
    oldLane.remove();
    initFreeLane(newLane);
  }
  rebuildTracksUI();
  seqRenderAll();
  seqResyncTrack(track);
  // Open the piano-roll for the first clip if any, so the user immediately
  // sees they can now edit notes.
  if (track.items.length > 0) openPianoRoll(track, track.items[0]);
  seqSave();
}

function deleteTrack(id) {
  const tr = SEQ.tracksList.find(t => t.id === id);
  const name = tr?.name || 'this track';
  showConfirm({
    title: 'Delete track',
    message: `Delete “${name}”?`,
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: () => {
      if (SEQ.focusedClip?.trackId === id) closePianoRoll();
      removeTrackById(id);
      document.querySelectorAll(`[data-track-id="${id}"]`).forEach(el => el.remove());
      rebuildTracksUI();
      seqRenderAll();
      seqSave();
    }
  });
}

function showConfirm({ title = 'Confirm', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, onConfirm, onCancel } = {}) {
  // Remove any existing confirm
  document.querySelectorAll('.cp-confirm').forEach(el => el.remove());
  const overlay = document.createElement('div');
  overlay.className = 'cp-confirm';
  overlay.innerHTML = `
    <div class="cp-confirm-backdrop"></div>
    <div class="cp-confirm-panel" role="dialog" aria-modal="true">
      <div class="cp-confirm-title">${escapeHtml(title)}</div>
      <div class="cp-confirm-message">${escapeHtml(message)}</div>
      <div class="cp-confirm-actions">
        <button type="button" class="cp-confirm-btn cp-confirm-cancel">${escapeHtml(cancelLabel)}</button>
        <button type="button" class="cp-confirm-btn cp-confirm-ok${danger ? ' danger' : ''}">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); onCancel?.(); }
    else if (e.key === 'Enter') { e.preventDefault(); close(); onConfirm?.(); }
  };
  document.addEventListener('keydown', onKey);
  overlay.querySelector('.cp-confirm-backdrop').addEventListener('click', () => { close(); onCancel?.(); });
  overlay.querySelector('.cp-confirm-cancel').addEventListener('click', () => { close(); onCancel?.(); });
  overlay.querySelector('.cp-confirm-ok').addEventListener('click', () => { close(); onConfirm?.(); });
  // Focus the confirm button (or cancel for safety on danger? — focus cancel for danger).
  setTimeout(() => {
    overlay.querySelector(danger ? '.cp-confirm-cancel' : '.cp-confirm-ok')?.focus();
  }, 0);
}

function rebuildTracksUI() {
  // Make sure each track has a sidebar header and a lane element
  for (const t of SEQ.tracksList) {
    ensureTrackHeader(t);
    ensureTrackLane(t);
  }
  // Remove DOM for tracks that no longer exist
  document.querySelectorAll('.seq-track-label[data-track-id]').forEach(label => {
    if (!trackById(label.dataset.trackId)) label.remove();
  });
  document.querySelectorAll('.seq-lane[data-track-id]').forEach(lane => {
    if (!trackById(lane.dataset.trackId)) lane.remove();
  });
  // Remove orphan HTML rows that never had a track-id (legacy "melody"
  // label + #seq-note-lane). Without this they sit in the sidebar/lane
  // stack and push every dynamically-added track out of vertical alignment.
  document.querySelectorAll('.seq-track-label:not([data-track-id])').forEach(el => el.remove());
  document.getElementById('seq-note-lane')?.remove();
  // Re-order DOM to match tracksList order. The default hardcoded HTML
  // lanes can sit in arbitrary positions when localStorage tracks reuse
  // their ids, and inserting new lanes before the resize handle no longer
  // guarantees correct order when default lanes are involved.
  const sidebar = document.getElementById('seq-track-sidebar');
  const addBtn  = document.getElementById('seq-add-track-btn');
  const inner   = document.getElementById('seq-tracks-inner');
  const handle  = inner?.querySelector('.midi-lane-resize-handle');
  if (sidebar && addBtn) {
    for (const t of SEQ.tracksList) {
      const lbl = document.querySelector(`.seq-track-label[data-track-id="${t.id}"]`);
      if (lbl) sidebar.insertBefore(lbl, addBtn);
    }
  }
  if (inner) {
    for (const t of SEQ.tracksList) {
      const lane = document.querySelector(`.seq-lane[data-track-id="${t.id}"]`);
      if (!lane) continue;
      if (handle) inner.insertBefore(lane, handle);
      else        inner.appendChild(lane);
    }
  }
  _ensureGlobalPlayhead();
  refreshLucide();
  syncTrackLabelHeights();
}

// Legacy entry-point kept for places that called buildTrackHeaders before
function buildTrackHeaders() { rebuildTracksUI(); }

// ----- Add Track button + menu -----
function openAddTrackMenu(anchor) {
  document.querySelectorAll('.seq-add-track-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'seq-add-track-menu';
  menu.innerHTML = `
    <button data-kind="chord">+ Chord track</button>
    <button data-kind="free">+ Free track</button>
  `;
  const r = anchor.getBoundingClientRect();
  menu.style.left = (r.left) + 'px';
  menu.style.top  = (r.bottom + 4) + 'px';
  document.body.appendChild(menu);
  const close = (e) => {
    if (e && menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', close, true);
  };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
  menu.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const kind = btn.dataset.kind;
      const baseName = kind === 'chord' ? 'Chords' : 'Free';
      const sameKindCount = tracksOfKind(kind).length;
      const name = sameKindCount === 0 ? baseName : `${baseName} ${sameKindCount + 1}`;
      const tr = addTrack(kind, { name });
      if (!tr.synth) tr.synth = { ...state.synth };
      seqCheckpoint();
      rebuildTracksUI();
      seqRenderAll();
      seqSave();
      menu.remove();
      document.removeEventListener('mousedown', close, true);
    });
  });
}
document.getElementById('seq-add-track-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openAddTrackMenu(e.currentTarget);
});

// ----- Per-lane drag-drop init (called once per track lane DOM element) -----
function initChordLane(lane) {
  const getTrack = () => trackById(lane.dataset.trackId);
  const _hint = () => lane.querySelector('.seq-drop-hint');
  lane.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-chord')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    lane.classList.add('drag-over');
    _hint()?.style.setProperty('color', 'var(--accent)');
    const rect = lane.getBoundingClientRect();
    const beat = Math.max(0, arrSnap((e.clientX - rect.left) / BEAT_PX));
    seqSetGhost(lane, beat, chordDropLen());
  });
  lane.addEventListener('dragleave', (e) => {
    if (!lane.contains(e.relatedTarget)) { lane.classList.remove('drag-over'); seqClearGhost(lane); }
  });
  lane.addEventListener('drop', (e) => {
    e.preventDefault();
    lane.classList.remove('drag-over');
    _hint()?.style.removeProperty('color');
    seqClearGhost(lane);
    const raw = e.dataTransfer.getData('application/x-chord');
    if (!raw) return;
    const t = getTrack();
    if (!t) return;
    const rect = lane.getBoundingClientRect();
    const dropBeat = Math.max(0, arrSnap((e.clientX - rect.left) / BEAT_PX));
    dropChord(t, dropBeat, JSON.parse(raw));
  });
}

function initFreeLane(lane) {
  const getTrack = () => trackById(lane.dataset.trackId);
  lane.addEventListener('dragover', (e) => {
    const hasNote  = e.dataTransfer.types.includes('application/x-note');
    const hasChord = e.dataTransfer.types.includes('application/x-chord');
    if (!hasNote && !hasChord) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    lane.classList.add('drag-over');
    const rect = lane.getBoundingClientRect();
    const beat = Math.max(0, arrSnap((e.clientX - rect.left) / BEAT_PX));
    seqSetGhost(lane, beat, hasChord ? chordDropLen() : 1);
  });
  lane.addEventListener('dragleave', (e) => {
    if (!lane.contains(e.relatedTarget)) { lane.classList.remove('drag-over'); seqClearGhost(lane); }
  });
  lane.addEventListener('drop', (e) => {
    e.preventDefault();
    lane.classList.remove('drag-over');
    seqClearGhost(lane);
    const t = getTrack();
    if (!t) return;
    const rect = lane.getBoundingClientRect();
    const dropBeat = Math.max(0, arrSnap((e.clientX - rect.left) / BEAT_PX));
    const rawChord = e.dataTransfer.getData('application/x-chord');
    if (rawChord) { dropChord(t, dropBeat, JSON.parse(rawChord)); return; }
    const rawNote = e.dataTransfer.getData('application/x-note');
    if (rawNote) dropNote(t, dropBeat, JSON.parse(rawNote));
  });
}

// ----- Per-track render -----
function _appendLaneOverlays(_lane) {
  // No per-lane overlays anymore — loop tags + bar sit on the ruler and
  // the playhead spans the whole arrangement view from the inner container.
}

// Ensure exactly one global playhead spans the ruler + all lanes inside
// seq-tracks-inner. Called from rebuildTracksUI / on init.
function _ensureGlobalPlayhead() {
  const inner = document.getElementById('seq-tracks-inner');
  if (!inner) return;
  let ph = inner.querySelector(':scope > .seq-playhead');
  if (!ph) {
    ph = document.createElement('div');
    ph.className = 'seq-playhead seq-playhead-global';
    inner.appendChild(ph);
  }
  // Always show the playhead — even when not playing — at the current
  // play-cursor position so the user sees where playback will start.
  ph.style.display = 'block';
  ph.style.left = ((SEQ.startBeat ?? 0) * BEAT_PX) + 'px';
  return ph;
}

function _appendRulerLoopHandles() {
  const ruler = document.getElementById('seq-ruler');
  if (!ruler) return;
  ruler.querySelectorAll('.seq-loop-bar').forEach(h => h.remove());
  const bar = document.createElement('div');
  bar.className = 'seq-loop-bar';
  bar.innerHTML = '<div class="seq-loop-bar-left"></div><div class="seq-loop-bar-right"></div>';
  _positionLoopBar(bar);
  ruler.appendChild(bar);
  _bindLoopBar(bar);
}

function _positionLoopBar(bar) {
  bar.style.left  = (SEQ.loopStart * BEAT_PX) + 'px';
  bar.style.width = Math.max(2, (SEQ.loopEnd - SEQ.loopStart) * BEAT_PX) + 'px';
}

function _bindLoopBar(bar) {
  const lefth  = bar.querySelector('.seq-loop-bar-left');
  const righth = bar.querySelector('.seq-loop-bar-right');
  const startDrag = (mode) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    seqCheckpoint();
    bar.setPointerCapture(e.pointerId);
    const ruler = bar.parentElement;
    const startX = e.clientX;
    const initStart = SEQ.loopStart, initEnd = SEQ.loopEnd;
    const onMove = (ev) => {
      const rect = ruler.getBoundingClientRect();
      const minLen = state.beatsPerBar || 4;
      if (mode === 'left') {
        const beat = Math.max(0, Math.round((ev.clientX - rect.left) / BEAT_PX));
        SEQ.loopStart = Math.min(beat, SEQ.loopEnd - minLen);
      } else if (mode === 'right') {
        const beat = Math.max(0, Math.round((ev.clientX - rect.left) / BEAT_PX));
        SEQ.loopEnd = Math.max(beat, SEQ.loopStart + minLen);
      } else {
        const dxBeats = Math.round((ev.clientX - startX) / BEAT_PX);
        const len = initEnd - initStart;
        const newStart = Math.max(0, initStart + dxBeats);
        SEQ.loopStart = newStart;
        SEQ.loopEnd   = newStart + len;
      }
      _positionLoopBar(bar);
      seqUpdateLoopStart();
      seqUpdateLoopEnd();
      if (SEQ.loop) seqResyncAllThrottled();
    };
    const onUp = () => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      if (SEQ.playing && SEQ.loop) seqLoopBaseChangedResync();
      seqSave();
    };
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
  };
  lefth.addEventListener('pointerdown', startDrag('left'));
  righth.addEventListener('pointerdown', startDrag('right'));
}

function _bindLaneLoopHandle(handle, lane, which) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const rect = lane.getBoundingClientRect();
      const beat = Math.max(0, Math.round((ev.clientX - rect.left) / BEAT_PX));
      const minLen = state.beatsPerBar || 4;
      if (which === 'start') {
        SEQ.loopStart = Math.min(beat, SEQ.loopEnd - minLen);
        seqUpdateLoopStart();
      } else {
        SEQ.loopEnd = Math.max(beat, SEQ.loopStart + minLen);
        seqUpdateLoopEnd();
      }
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

// Render an .overlap-region div in the lane for every intersection between
// two items in the items array. Both items become semi-transparent so the
// underlying overlap stripes are visible.
function _markOverlaps(lane, items) {
  if (!lane || !items) return;
  // Clear previous overlap markers
  lane.querySelectorAll(':scope > .overlap-region').forEach(el => el.remove());
  const overlapIdx = new Set();
  const regions = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    const aEnd = a.start + (a.beats || 0);
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      const bEnd = b.start + (b.beats || 0);
      if (a.start < bEnd && b.start < aEnd) {
        overlapIdx.add(i);
        overlapIdx.add(j);
        regions.push({
          start: Math.max(a.start, b.start),
          end:   Math.min(aEnd, bEnd),
        });
      }
    }
  }
  const blocks = lane.querySelectorAll(':scope > .seq-block');
  blocks.forEach((el, i) => {
    el.classList.toggle('overlapping', overlapIdx.has(i));
  });
  for (const r of regions) {
    const region = document.createElement('div');
    region.className = 'overlap-region';
    region.style.left  = (r.start * BEAT_PX) + 'px';
    region.style.width = ((r.end - r.start) * BEAT_PX) + 'px';
    lane.appendChild(region);
  }
}

// Compute the MIDI pitch range across every clip's notes on a free
// track, padded by half an octave. Returned object is passed to each
// clip's mini-preview so they share a common Y axis.
function _freeTrackMidiRange(track) {
  if (!track || track.kind !== 'free') return null;
  let lo = Infinity, hi = -Infinity;
  for (const clip of track.items) {
    if (!Array.isArray(clip.notes)) continue;
    for (const n of clip.notes) {
      if (n.midi < lo) lo = n.midi;
      if (n.midi > hi) hi = n.midi;
    }
  }
  if (!isFinite(lo)) return null;
  const paddedHi = hi + 6;
  const paddedLo = lo - 6;
  return { lo: paddedLo, hi: paddedHi, span: Math.max(1, paddedHi - paddedLo) };
}

function seqRenderTrack(track) {
  if (!track) return;
  // Any render of a free track may follow a mutation — invalidate the
  // cached flat-notes view so playback picks up the latest content.
  if (track.kind === 'free') invalidateFreeTrackFlat(track);
  // If the focused clip belongs to this track, keep the piano-roll in sync
  if (track.kind === 'free' && SEQ.focusedClip?.trackId === track.id) renderPianoRoll();
  // If this is the chord track currently focused by the chord-view,
  // refresh its card row so adds / deletes / resizes appear there too.
  if (track.kind === 'chord' && SEQ.chordViewOpen
      && (track.id === SEQ.focusedChordTrackId || (!SEQ.focusedChordTrackId && track === firstTrackOfKind('chord')))
      && typeof renderChordView === 'function') {
    renderChordView();
  }
  // Default tracks delegate to their legacy renderers — but only while
  // they still match their original kind.
  if (track.id === 'tr-default-chord' && track.kind === 'chord') return seqRender();
  if (track.id === 'tr-default-free'  && track.kind === 'free')  return seqRenderFreeClips(track);
  const lane = document.querySelector(`.seq-lane[data-track-id="${track.id}"]`);
  if (!lane) return;
  lane.innerHTML = '';
  if (track.items.length > 0) {
    lane.style.minWidth = seqLaneWidth(track.items) + 'px';
    if (track.kind === 'free') {
      // Render each clip as a labeled block with a mini-roll preview.
      const trackRange = _freeTrackMidiRange(track);
      track.items.forEach((clip, idx) => lane.appendChild(seqMakeClipBlock(track, clip, idx, trackRange)));
    } else {
      track.items.forEach((item, idx) => lane.appendChild(seqMakeBlock(item, idx, false, false)));
    }
    _markOverlaps(lane, track.items);
  } else {
    lane.style.minWidth = '';
    // Don't clear minHeight here — syncTrackLabelHeights below will set it
    // to match the sidebar label so empty tracks stay aligned with their
    // taller-than-CSS-default neighbours.
  }
  _appendLaneOverlays(lane);
  syncTrackLabelHeights();
  seqUpdateLoopVisible();
}

// Render a free-kind default track's lane as clip blocks (used for the
// hardcoded #seq-midi-lane when its track is free).
function seqRenderFreeClips(track) {
  const lane = document.querySelector(`.seq-lane[data-track-id="${track.id}"]`)
            || document.getElementById('seq-midi-lane');
  if (!lane) return;
  lane.innerHTML = '';
  if (track.items.length > 0) {
    lane.style.minWidth = seqLaneWidth(track.items) + 'px';
    const trackRange = _freeTrackMidiRange(track);
    track.items.forEach((clip, idx) => lane.appendChild(seqMakeClipBlock(track, clip, idx, trackRange)));
    _markOverlaps(lane, track.items);
  } else {
    lane.style.minWidth = '';
  }
  _appendLaneOverlays(lane);
  syncTrackLabelHeights();
  seqUpdateLoopVisible();
}

// Build a DOM block for a clip on a free track. Includes mini-roll
// preview of its notes, drag-to-move, ✕ delete, click → open piano-roll.
// `trackRange`, when provided, locks the mini-preview's pitch axis to a
// track-wide min/max so notes across clips line up at comparable heights.
function seqMakeClipBlock(track, clip, idx, trackRange) {
  const block = document.createElement('div');
  block.className = 'seq-block seq-clip-block';
  block.dataset.clipId = clip.id;
  block.style.left  = (clip.start * BEAT_PX) + 'px';
  block.style.width = (clip.beats * BEAT_PX) + 'px';

  // No label inside the clip — the mini-roll preview communicates content.

  // Mini-roll preview — pad the pitch range by a half octave above and
  // below so notes never sit right on the clip's top/bottom edge. Use
  // the track-wide range when available so a clip with low notes and
  // a clip with high notes on the same track visually differ in height.
  if (clip.notes.length > 0) {
    let hi, lo, span;
    if (trackRange && trackRange.span > 0) {
      hi = trackRange.hi; lo = trackRange.lo; span = trackRange.span;
    } else {
      const midis = clip.notes.map(n => n.midi);
      hi = Math.max(...midis) + 6;
      lo = Math.min(...midis) - 6;
      span = Math.max(1, hi - lo);
    }
    const mini = document.createElement('div');
    mini.className = 'seq-clip-mini';
    for (const note of clip.notes) {
      const n = document.createElement('div');
      n.className = 'seq-clip-mini-note';
      n.style.left   = (note.start / clip.beats * 100) + '%';
      // Real percentage — CSS `min-width: 2px` already keeps very
      // short notes visible without inflating their visible duration.
      n.style.width  = (note.beats / clip.beats * 100) + '%';
      n.style.bottom = (((note.midi - lo) / span) * 100) + '%';
      mini.appendChild(n);
    }
    block.appendChild(mini);
  }

  // Resize handle on LEFT edge — pulls the clip start earlier or later
  // while keeping note absolute positions; notes shift relative to the
  // new start so what was at song-beat X stays at song-beat X.
  const resizeL = document.createElement('div');
  resizeL.className = 'seq-resize seq-resize-left';
  resizeL.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    seqCheckpoint();
    resizeL.setPointerCapture(e.pointerId);
    const startX = e.clientX, startStart = clip.start, startBts = clip.beats;
    const startNoteStarts = clip.notes.map(n => n.start);
    const snap = SEQ.arrSnap ? SEQ.arrSnapVal : 0.5;
    const miniNotes = block.querySelectorAll('.seq-clip-mini-note');
    const laneL = block.parentElement;
    let ghost = null;
    if (SEQ.arrSnap && laneL) {
      ghost = document.createElement('div');
      ghost.className = 'seq-ghost';
      ghost.style.left  = (clip.start * BEAT_PX) + 'px';
      ghost.style.width = (clip.beats * BEAT_PX) + 'px';
      laneL.appendChild(ghost);
    }
    const onMove = (ev) => {
      const dxBeats = (ev.clientX - startX) / BEAT_PX;
      const maxDelta = startBts - snap;
      const delta = Math.max(-startStart, Math.min(maxDelta, dxBeats));
      clip.start = startStart + delta;
      clip.beats = startBts - delta;
      block.style.left  = (clip.start * BEAT_PX) + 'px';
      block.style.width = (clip.beats * BEAT_PX) + 'px';
      clip.notes.forEach((n, i) => {
        n.start = startNoteStarts[i] - delta;
        const el = miniNotes[i];
        if (!el) return;
        el.style.left  = (n.start / clip.beats * 100) + '%';
        el.style.width = Math.max(2, (n.beats / clip.beats * 100)) + '%';
      });
      if (ghost) {
        const snappedStart = Math.max(0, Math.round(clip.start / snap) * snap);
        const ghostDelta = snappedStart - startStart;
        const ghostBeats = Math.max(snap, startBts - ghostDelta);
        ghost.style.left  = (snappedStart * BEAT_PX) + 'px';
        ghost.style.width = (ghostBeats * BEAT_PX) + 'px';
      }
      seqResyncTrackThrottled(track);
    };
    const onUp = () => {
      resizeL.removeEventListener('pointermove', onMove);
      resizeL.removeEventListener('pointerup', onUp);
      if (ghost) ghost.remove();
      const snapped = Math.max(0, Math.round(clip.start / snap) * snap);
      const delta = snapped - clip.start;
      clip.start = snapped;
      clip.beats = Math.max(snap, clip.beats - delta);
      clip.notes.forEach(n => { n.start -= delta; });
      seqRenderTrack(track);
      seqSave();
    };
    resizeL.addEventListener('pointermove', onMove);
    resizeL.addEventListener('pointerup', onUp);
  });
  block.appendChild(resizeL);

  // Resize handle on right edge
  const resize = document.createElement('div');
  resize.className = 'seq-resize';
  resize.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    seqCheckpoint();
    resize.setPointerCapture(e.pointerId);
    const startX = e.clientX, startBts = clip.beats;
    const snap = SEQ.arrSnap ? SEQ.arrSnapVal : 0.5;
    const miniNotes = block.querySelectorAll('.seq-clip-mini-note');
    const lane = block.parentElement;
    let ghost = null;
    if (SEQ.arrSnap && lane) {
      ghost = document.createElement('div');
      ghost.className = 'seq-ghost';
      ghost.style.left  = (clip.start * BEAT_PX) + 'px';
      ghost.style.width = (clip.beats * BEAT_PX) + 'px';
      lane.appendChild(ghost);
    }
    const onMove = (ev) => {
      clip.beats = Math.max(snap, startBts + (ev.clientX - startX) / BEAT_PX);
      block.style.width = (clip.beats * BEAT_PX) + 'px';
      clip.notes.forEach((n, i) => {
        const el = miniNotes[i];
        if (!el) return;
        el.style.left  = (n.start / clip.beats * 100) + '%';
        el.style.width = Math.max(2, (n.beats / clip.beats * 100)) + '%';
      });
      if (ghost) {
        const snappedB = Math.max(snap, Math.round(clip.beats / snap) * snap);
        ghost.style.left  = (clip.start * BEAT_PX) + 'px';
        ghost.style.width = (snappedB * BEAT_PX) + 'px';
      }
      seqResyncTrackThrottled(track);
    };
    const onUp = () => {
      resize.removeEventListener('pointermove', onMove);
      resize.removeEventListener('pointerup', onUp);
      if (ghost) ghost.remove();
      clip.beats = Math.max(snap, Math.round(clip.beats / snap) * snap);
      seqAutoExtendLoop(clip.start + clip.beats);
      seqRenderTrack(track);
      seqSave();
    };
    resize.addEventListener('pointermove', onMove);
    resize.addEventListener('pointerup', onUp);
  });
  block.appendChild(resize);

  // Split-mode hover preview: a thin vertical guide at the snapped split
  // position, plus a dashed outline of the resulting right-half clip.
  block.addEventListener('pointermove', (e) => {
    if (SEQ.arrTool !== 'split') return;
    const rect = block.getBoundingClientRect();
    let relBeat = ((e.clientX - rect.left) / BEAT_PX);
    if (SEQ.arrSnap) relBeat = Math.round(relBeat / SEQ.arrSnapVal) * SEQ.arrSnapVal;
    const minSeg = 0.25;
    let guide = block.querySelector('.split-guide');
    let ghostR = block.querySelector('.split-ghost-right');
    if (relBeat <= minSeg || relBeat >= clip.beats - minSeg) {
      guide?.remove();
      ghostR?.remove();
      return;
    }
    if (!guide)  { guide  = document.createElement('div'); guide.className  = 'split-guide';       block.appendChild(guide); }
    if (!ghostR) { ghostR = document.createElement('div'); ghostR.className = 'split-ghost-right'; block.appendChild(ghostR); }
    const px = relBeat * BEAT_PX;
    guide.style.left  = (px - 0.5) + 'px';
    ghostR.style.left  = px + 'px';
    ghostR.style.width = ((clip.beats - relBeat) * BEAT_PX) + 'px';
  });
  block.addEventListener('pointerleave', () => {
    block.querySelector('.split-guide')?.remove();
    block.querySelector('.split-ghost-right')?.remove();
  });

  // Move by drag · single click opens the piano-roll for this clip
  block.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.seq-resize') || e.target.closest('.seq-delete')) return;
    if (SEQ.arrTool === 'pan' || SEQ._arrSpaceHeld) return; // pan handled on wrap
    if (SEQ.arrTool === 'erase') {
      e.preventDefault();
      seqCheckpoint();
      const i = track.items.indexOf(clip);
      if (i >= 0) track.items.splice(i, 1);
      if (SEQ.focusedClip?._clipRef === clip || SEQ.focusedClip?.clipId === clip.id) closePianoRoll();
      seqRenderTrack(track);
      seqResyncTrack(track);
      seqSave();
      return;
    }
    if (SEQ.arrTool === 'split') {
      e.preventDefault();
      e.stopPropagation();
      const rect = block.getBoundingClientRect();
      // Clip-relative beat at click position. Snap if snap is on.
      let relBeat = ((e.clientX - rect.left) / BEAT_PX);
      if (SEQ.arrSnap) relBeat = Math.round(relBeat / SEQ.arrSnapVal) * SEQ.arrSnapVal;
      // Need a meaningful split — not at very start / very end.
      const minSeg = 0.25;
      if (relBeat <= minSeg || relBeat >= clip.beats - minSeg) return;
      seqCheckpoint();
      // Notes whose start is BEFORE the split stay in the left clip;
      // notes starting AT/AFTER the split move to the right clip with
      // their start adjusted relative to the new clip-start.
      const leftNotes  = [];
      const rightNotes = [];
      for (const n of clip.notes) {
        if (n.start < relBeat) leftNotes.push({ ...n });
        else                   rightNotes.push({ ...n, start: n.start - relBeat });
      }
      const left = makeClip({
        start: clip.start, beats: relBeat,
        label: clip.label || null,
        notes: leftNotes,
      });
      const right = makeClip({
        start: clip.start + relBeat,
        beats: clip.beats - relBeat,
        label: null,
        notes: rightNotes,
      });
      const i = track.items.indexOf(clip);
      if (i >= 0) track.items.splice(i, 1, left, right);
      // Keep focus on the LEFT half if the user was editing this clip.
      if (SEQ.focusedClip?._clipRef === clip || SEQ.focusedClip?.clipId === clip.id) {
        SEQ.focusedClip = { trackId: track.id, clipId: left.id, _trackRef: track, _clipRef: left };
      }
      track.items.sort((a, b) => a.start - b.start);
      seqRenderTrack(track);
      seqResyncTrack(track);
      seqSave();
      return;
    }
    if (SEQ.arrTool === 'merge') {
      e.preventDefault();
      e.stopPropagation();
      if (!SEQ._mergeFirst) {
        SEQ._mergeFirst = { trackId: track.id, clipId: clip.id, _clipRef: clip };
        block.classList.add('merge-pending');
        return;
      }
      const first = SEQ._mergeFirst;
      // Same clip clicked twice → cancel the merge.
      if (first._clipRef === clip) {
        SEQ._mergeFirst = null;
        document.querySelectorAll('.seq-block.merge-pending').forEach(el => el.classList.remove('merge-pending'));
        return;
      }
      // Different track → silently restart with the new clip as first.
      if (first.trackId !== track.id) {
        document.querySelectorAll('.seq-block.merge-pending').forEach(el => el.classList.remove('merge-pending'));
        SEQ._mergeFirst = { trackId: track.id, clipId: clip.id, _clipRef: clip };
        block.classList.add('merge-pending');
        return;
      }
      SEQ._mergeFirst = null;
      document.querySelectorAll('.seq-block.merge-pending').forEach(el => el.classList.remove('merge-pending'));
      const t = trackById(first.trackId);
      if (!t || t.kind !== 'free') return;
      const a = first._clipRef && t.items.indexOf(first._clipRef) >= 0
        ? first._clipRef
        : t.items.find(it => it.id === first.clipId);
      const b = clip;
      if (!a || !b) return;
      seqCheckpoint();
      const newStart = Math.min(a.start, b.start);
      const newEnd   = Math.max(a.start + a.beats, b.start + b.beats);
      const aOffset  = a.start - newStart;
      const bOffset  = b.start - newStart;
      const mergedNotes = [
        ...a.notes.map(n => ({ ...n, start: n.start + aOffset })),
        ...b.notes.map(n => ({ ...n, start: n.start + bOffset })),
      ].sort((x, y) => x.start - y.start);
      const merged = makeClip({
        start: newStart,
        beats: newEnd - newStart,
        label: a.label || b.label || null,
        notes: mergedNotes,
      });
      t.items = t.items.filter(it => it !== a && it !== b);
      t.items.push(merged);
      t.items.sort((x, y) => x.start - y.start);
      seqAutoExtendLoop(merged.start + merged.beats);
      // Focus the merged clip in the piano-roll if one of the originals was focused.
      if (SEQ.focusedClip?._clipRef === a || SEQ.focusedClip?._clipRef === b
          || SEQ.focusedClip?.clipId === a.id || SEQ.focusedClip?.clipId === b.id) {
        SEQ.focusedClip = { trackId: t.id, clipId: merged.id, _trackRef: t, _clipRef: merged };
      }
      seqRenderTrack(t);
      seqResyncTrack(t);
      seqSave();
      return;
    }
    e.preventDefault();
    seqCheckpoint();
    try { block.setPointerCapture(e.pointerId); } catch (_) {}
    // Audible preview of the clicked clip — but never during playback
    // (the user is listening to the song, not the clip).
    // - Chord clip: play the chord (held).
    // - Free clip with one note: play that note (held).
    // - Free clip with multiple notes: play the whole clip from start
    //   to end (or until pointerup), preserving each note's timing.
    if (track && !SEQ.playing) {
      const isFreeClip = track.kind === 'free' && Array.isArray(clip.notes);
      const playSimultaneous = (midis, releaseOnUp = true) => {
        if (!midis.length) return;
        if (track.output === 'midi') {
          const port = midiPortById(track.midiPortId);
          const vel  = seqTrackVel(track, state.velocity);
          midis.forEach(m => sendNoteOn(m, vel, track.channel, port));
          if (releaseOnUp) {
            const stop = () => midis.forEach(m => sendNoteOff(m, track.channel, port));
            block.addEventListener('pointerup',     stop, { once: true });
            block.addEventListener('pointercancel', stop, { once: true });
          }
        } else if (state.audioEnabled) {
          const inst = seqTrackInstrument(track);
          const previewNodes = [];
          midis.forEach(m => {
            let node;
            withSynth(track.synth, () => { node = startAudioNote(m, state.velocity, null, null, inst); });
            if (node) previewNodes.push(node);
          });
          if (releaseOnUp) {
            const stop = () => previewNodes.forEach(stopAudioNote);
            block.addEventListener('pointerup',     stop, { once: true });
            block.addEventListener('pointercancel', stop, { once: true });
          }
        }
      };
      if (isFreeClip && clip.notes.length > 1) {
        // Schedule the whole sequence with each note's timing. Stop
        // everything on pointerup so a quick tap doesn't keep playing.
        const ctx = getAudioCtx();
        const bd  = seqBeatDur();
        const t0  = ctx.currentTime;
        const audioNodes = [];
        const midiPort = (track.output === 'midi') ? midiPortById(track.midiPortId) : null;
        const vel = seqTrackVel(track, state.velocity);
        const inst = seqTrackInstrument(track);
        // Match the scheduler's path (startAudioNote with autoRelease=null
        // + a setTimeout that calls stopAudioNote at the right moment).
        // The autoRelease-based release envelope produced an audible
        // click between notes; using stopAudioNote gives the synth's
        // full release ramp like during real playback.
        const pendingTimers = [];
        for (const n of clip.notes) {
          const startT = t0 + (n.start || 0) * bd;
          const durT   = (n.beats || 0.25) * bd;
          if (midiPort) {
            const onTs  = audioTimeToMidiTs(startT);
            const offTs = audioTimeToMidiTs(startT + durT * 0.95);
            sendNoteOn (n.midi, vel, track.channel, midiPort, onTs);
            sendNoteOff(n.midi, track.channel, midiPort, offTs);
          } else if (state.audioEnabled) {
            let node;
            withSynth(track.synth, () => {
              node = startAudioNote(n.midi, vel, startT, null, inst);
            });
            if (node) {
              audioNodes.push(node);
              const offDelay = Math.max(0, (startT + durT * 0.95 - ctx.currentTime) * 1000);
              const tid = setTimeout(() => stopAudioNote(node), offDelay);
              pendingTimers.push(tid);
            }
          }
        }
        // Hard-stop helper — stopAudioNote uses a 500 ms release envelope
        // that does nothing for nodes scheduled to START in the future,
        // so they'd keep playing after pointerup. Cancel + disconnect
        // silences both live and queued voices immediately.
        const hardStop = (node) => {
          if (!node) return;
          const now = ctx.currentTime;
          try { node.env?.gain.cancelScheduledValues(now); } catch (_) {}
          try { node.env?.gain.setValueAtTime(0, now); } catch (_) {}
          try { node.env?.disconnect(); } catch (_) {}
          try { node.oscs?.forEach(o => { try { o.stop(now); } catch (_) {} }); } catch (_) {}
        };
        const stop = () => {
          audioNodes.forEach(hardStop);
          if (midiPort) {
            // Cancel any queued future note-ons by sending matching
            // note-offs at the same future timestamps + 1 ms, then a
            // best-effort immediate note-off for currently-sounding.
            for (const n of clip.notes) {
              const startT = t0 + (n.start || 0) * bd;
              sendNoteOff(n.midi, track.channel, midiPort, audioTimeToMidiTs(Math.max(ctx.currentTime, startT) + 0.001));
              sendNoteOff(n.midi, track.channel, midiPort);
            }
          }
        };
        block.addEventListener('pointerup',     stop, { once: true });
        block.addEventListener('pointercancel', stop, { once: true });
      } else if (isFreeClip && clip.notes.length === 1) {
        playSimultaneous([clip.notes[0].midi]);
      } else if (clip.interval !== undefined) {
        const kr = clip.keyRoot !== undefined ? clip.keyRoot : state.keys[state.currentTemplate];
        playSimultaneous(chordToMidiNotes(kr, state.octave, clip.interval, clip.q));
      }
    }
    const startX = e.clientX, startY = e.clientY, startBeat = clip.start;
    const snap = SEQ.arrSnap ? SEQ.arrSnapVal : (1 / BEAT_PX);
    const sourceLane = block.parentElement;
    // Build the move group: if the dragged clip is part of a multi-select,
    // every selected item moves with it. Otherwise just this clip.
    const anchorInSel = SEQ.selection.some(s => s.item === clip);
    const group = (anchorInSel && SEQ.selection.length > 1)
      ? SEQ.selection.map(s => ({
          track: trackByRef(_selKey(s)),
          item: s.item,
          origStart: s.item.start,
          el: null,
        })).filter(g => g.track)
      : [{ track, item: clip, origStart: startBeat, el: block }];
    // Resolve the DOM element per group entry by item-index in the
    // track (clip-blocks are rendered in items order). Bypasses the
    // data-clip-id querySelector which would pick the wrong block if
    // two clips happened to share an id.
    for (const g of group) {
      if (g.el) continue;
      const laneEl = document.querySelector(`.seq-lane[data-track-id="${g.track.id}"]`);
      if (!laneEl) continue;
      const idxInItems = g.track.items.indexOf(g.item);
      if (idxInItems < 0) continue;
      g.el = laneEl.querySelectorAll(':scope > .seq-clip-block')[idxInItems] || null;
    }
    const tracksInvolved = new Set(group.map(g => g.track.id));
    const canCrossTrack  = tracksInvolved.size === 1;
    let cloneCreated = false;
    let moved = false;
    let ghost = null;
    let groupGhosts = []; // one ghost per selected item when multi-dragging
    let targetLane = sourceLane;
    let targetTrack = track;
    const removeGroupGhosts = () => {
      groupGhosts.forEach(gg => gg.remove());
      groupGhosts = [];
    };
    const onMove = (ev) => {
      _edgeAutoScroll(document.getElementById('seq-lane-wrap'), ev.clientX);
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      const altCopy = e.altKey || ev.altKey;
      // Shift constrains the drag to its dominant axis. Horizontal-lock =
      // pure time-shift (no lane change). Vertical-lock = lane change only
      // (no time-shift).
      const shiftLock      = !!ev.shiftKey;
      const lockVertical   = shiftLock && Math.abs(dy) > Math.abs(dx);
      const lockHorizontal = shiftLock && !lockVertical;
      const effDx = lockVertical ? 0 : dx;
      // Alt-copy: originals are NEVER mutated — clones are spawned at the
      // drop position on release. So nothing to do here.
      moved = true;
      block.classList.add('moving');
      // Detect lane under cursor for cross-track drop. Free-clip drops are
      // allowed on free-lanes only (no free→chord). Cross-track is only
      // permitted when the whole selection lives in a single source track.
      // When shift-lock-horizontal is active, suppress lane changes.
      const els = document.elementsFromPoint(ev.clientX, ev.clientY);
      const overLane = els.find(el => el.classList?.contains('seq-lane'));
      if (!lockHorizontal && overLane && overLane !== sourceLane && canCrossTrack) {
        const t = trackById(overLane.dataset.trackId);
        if (t && t.kind === 'free') { targetLane = overLane; targetTrack = t; }
        else { targetLane = sourceLane; targetTrack = track; }
      } else {
        targetLane = sourceLane; targetTrack = track;
      }
      const crossing = targetLane !== sourceLane;
      // Block stays anchored at origStart; only the ghost previews the
      // drop position. Mutating item.start live would make the scheduler
      // re-fire the clip every time the drag crosses the playhead during
      // playback. On drop, item.start is committed from the ghost.
      for (const g of group) {
        g.item.start = g.origStart;
        if (g.el) g.el.style.left = (g.origStart * BEAT_PX) + 'px';
      }
      const cursorBeat = Math.max(0, startBeat + effDx / BEAT_PX);
      const snapped = Math.max(0, Math.round(cursorBeat / snap) * snap);
      const snapDelta = snapped - startBeat;
      // Render a ghost for every selected clip at its snapped target spot.
      // First time through, create one ghost per group member.
      if (groupGhosts.length !== group.length) {
        removeGroupGhosts();
        for (let i = 0; i < group.length; i++) {
          const gg = document.createElement('div');
          gg.className = 'seq-ghost';
          groupGhosts.push(gg);
        }
      }
      for (let i = 0; i < group.length; i++) {
        const g = group[i];
        const gg = groupGhosts[i];
        // Anchor item's ghost goes in the target lane; the rest stay in
        // their own lanes (so multi-track selections remain per-track).
        const wantLane = (g.item === clip) ? targetLane : document.querySelector(`.seq-lane[data-track-id="${g.track.id}"]`);
        if (gg.parentElement !== wantLane && wantLane) wantLane.appendChild(gg);
        const gStart = Math.max(0, g.origStart + snapDelta);
        gg.style.width = (g.item.beats * BEAT_PX) + 'px';
        gg.style.left  = (gStart * BEAT_PX) + 'px';
        gg.classList.toggle('copy-drag', altCopy);
      }
      // Keep `ghost` pointing at the anchor's ghost for onUp drop-position logic.
      ghost = groupGhosts[group.indexOf(group.find(g => g.item === clip))] || groupGhosts[0];
    };
    const onUp = (ev) => {
      block.removeEventListener('pointermove', onMove);
      block.removeEventListener('pointerup', onUp);
      block.classList.remove('moving');
      const dropLeft = ghost ? parseFloat(ghost.style.left) || 0 : null;
      removeGroupGhosts();
      ghost = null;
      // Safety net: nuke ANY .seq-ghost stragglers anywhere in the doc
      // (chord-pad / pr / arrangement) so a stuck preview can't persist.
      document.querySelectorAll('.seq-ghost').forEach(g => g.remove());
      if (moved) {
        const altCopyFinal = e.altKey || (ev && ev.altKey);
        const tracksToRender = new Set();
        const anchorNewStart = Math.max(0, Math.round((dropLeft ?? startBeat * BEAT_PX) / BEAT_PX / snap) * snap);
        const anchorDelta = anchorNewStart - startBeat;
        const crossingFinal = targetTrack && targetTrack !== track && canCrossTrack;
        if (altCopyFinal) {
          // ALT-DROP — spawn fresh clones at the drop positions, originals
          // stay completely untouched.
          for (const g of group) {
            const src = g.item;
            const destTrack = crossingFinal ? targetTrack : g.track;
            const cloneStart = Math.max(0, g.origStart + anchorDelta);
            const clone = makeClip({
              start: Math.max(0, Math.round(cloneStart / snap) * snap),
              beats: src.beats,
              label: src.label || null,
              notes: Array.isArray(src.notes) ? src.notes.map(n => ({ ...n })) : [],
            });
            destTrack.items.push(clone);
            tracksToRender.add(destTrack.id);
          }
        } else if (crossingFinal) {
          // Cross-track move — anchor's snapped drop determines group delta.
          for (const g of group) {
            const idx = g.track.items.indexOf(g.item);
            if (idx >= 0) g.track.items.splice(idx, 1);
            g.item.start = Math.max(0, g.origStart + anchorDelta);
            g.item.start = Math.max(0, Math.round(g.item.start / snap) * snap);
            targetTrack.items.push(g.item);
            tracksToRender.add(g.track.id);
          }
          tracksToRender.add(targetTrack.id);
        } else {
          // Same-lane move — apply anchor's snapped delta to every group
          // member (item.start was held at origStart during the drag).
          for (const g of group) {
            const ns = Math.max(0, g.origStart + anchorDelta);
            g.item.start = Math.max(0, Math.round(ns / snap) * snap);
            tracksToRender.add(g.track.id);
          }
        }
        for (const tid of tracksToRender) {
          const t2 = trackById(tid);
          if (!t2) continue;
          t2.items.sort((a, b) => a.start - b.start);
          seqRenderTrack(t2);
          seqResyncTrack(t2);
        }
        seqAutoExtendLoop(clip.start + clip.beats);
      } else {
        // No drag → treat as a select click. Shift extends, plain replaces.
        const additive = !!(ev?.shiftKey || ev?.ctrlKey || ev?.metaKey);
        seqSelectionToggle(track, clip, additive);
      }
    };
    block.addEventListener('pointermove', onMove);
    block.addEventListener('pointerup', onUp);
    block.addEventListener('pointercancel', () => {
      removeGroupGhosts();
      // Belt-and-suspenders: nuke ANY .seq-ghost still in the document
      // (this drag may have left strays if a previous gesture cancelled).
      document.querySelectorAll('.seq-lane .seq-ghost').forEach(g => g.remove());
    }, { once: true });
  });
  block.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    // Un-hide the piano-roll section if the user had toggled it off.
    if (document.body.classList.contains('hide-pianoroll')) {
      document.body.classList.remove('hide-pianoroll');
      const btn = document.querySelector('.header-section-toggle[data-section="pianoroll"]');
      btn?.classList.add('active');
      try {
        const KEY = 'chordpad.hiddenSections';
        const hidden = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
        hidden.pianoroll = false;
        localStorage.setItem(KEY, JSON.stringify(hidden));
      } catch (_) {}
    }
    openPianoRoll(track, clip);
  });

  return block;
}

function seqRenderAll() {
  for (const t of SEQ.tracksList) seqRenderTrack(t);
}

// Per-track resync (alias kept for older call sites)
function seqResyncChordsTrack(track) { seqResyncTrack(track); }

function toggleTrackCollapse(label, track) {
  const isNowCollapsed = label.classList.toggle('track-collapsed');
  const lane = document.querySelector(`.seq-lane[data-track-id="${label.dataset.trackId}"]`);
  if (lane) lane.classList.toggle('track-collapsed', isNowCollapsed);
  if (track && track.kind === 'free' && track.id === 'tr-default-free') seqRenderMidi();
  const icon = label.querySelector('.seq-th-collapse [data-lucide]');
  if (icon) { icon.setAttribute('data-lucide', isNowCollapsed ? 'chevrons-up-down' : 'chevrons-down-up'); refreshLucide(); }
  syncTrackLabelHeights();
}

buildTrackHeaders();
// Preload samples for any per-track instrument that isn't already covered by the global one.
// SF2-backed instruments (including all gm<N> presets) are loaded via the SF2 bank, not mp3 samples.
for (const tr of SEQ.tracksList) {
  if (!tr.instrument || tr.instrument === 'synth' || tr.instrument === state.instrument) continue;
  if (INSTRUMENT_TO_SF2[tr.instrument] != null) continue;
  if (!SAMPLE_DEFS || !SAMPLE_DEFS[tr.instrument]) continue;
  preloadSamplesOnGesture(tr.instrument);
}

function rollSnapBeat(val) {
  if (!SEQ.rollSnap) return val;
  const s = SEQ.rollSnapVal;
  return Math.round(val / s) * s;
}
function rollSnapFloor(val) {
  if (!SEQ.rollSnap) return val;
  const s = SEQ.rollSnapVal;
  return Math.floor(val / s) * s;
}

function setRollTool(tool) {
  SEQ.rollTool = tool;
  document.getElementById('seq-tool-pen').classList.toggle('active', tool === 'pen');
  document.getElementById('seq-tool-erase').classList.toggle('active', tool === 'erase');
  document.body.classList.toggle('roll-tool-pen',   tool === 'pen');
  document.body.classList.toggle('roll-tool-erase', tool === 'erase');
}
['seq-tool-select','seq-tool-pen','seq-tool-erase','seq-tool-pan'].forEach((id) => {
  document.getElementById(id)?.addEventListener('mousedown', (e) => e.preventDefault());
});
const _prToggleTool = (t) => prSetTool(SEQ.prTool === t && t !== 'select' ? 'select' : t);
document.getElementById('seq-tool-select')?.addEventListener('click', () => _prToggleTool('select'));
document.getElementById('seq-tool-pen')?.addEventListener('click',    () => _prToggleTool('draw'));
document.getElementById('seq-tool-erase')?.addEventListener('click',  () => _prToggleTool('erase'));
document.getElementById('seq-tool-pan')?.addEventListener('click',    () => _prToggleTool('pan'));
SEQ.rollSnap    = SEQ.rollSnap    ?? true;
SEQ.rollSnapVal = SEQ.rollSnapVal || 1;
// DAW-standard note values. Stored as beat lengths (1 beat = 1/4 note in
// 4/4); labels are the conventional musical notation (1/4 quarter,
// 1/8 eighth, 1/8t triplet eighth, etc.). One unified set shared by
// both the snap-unit selectors and the chord-drop-length picker.
const SNAP_VALUES = [
  { val: 0.25,        label: '1/16' },  // sixteenth — smallest
  { val: 1/3,         label: '1/8t' },  // eighth triplet
  { val: 0.5,         label: '1/8'  },  // eighth
  { val: 0.75,        label: '1/8d' },  // dotted eighth
  { val: 2/3,         label: '1/4t' },  // quarter triplet
  { val: 1,           label: '1/4'  },  // quarter — default for snap
  { val: 1.5,         label: '1/4d' },  // dotted quarter
  { val: 2,           label: '1/2'  },  // half
  { val: 3,           label: '1/2d' },  // dotted half
  { val: 4,           label: '1'    },  // whole / 1 bar in 4/4
  { val: 8,           label: '2'    },  // 2 bars
  { val: 16,          label: '4'    },  // 4 bars
];
const SNAP_DEFAULT_IDX = SNAP_VALUES.findIndex(s => s.label === '1/4');
// Default chord-drop length = 1 bar (whole note in 4/4) → the '1' entry.
const SNAP_CHORDLEN_DEFAULT_IDX = SNAP_VALUES.findIndex(s => s.label === '1');
// Populate a <select> from SNAP_VALUES so labels stay in sync with the
// array. Marks selectedIdx with `selected`.
function _fillSnapSelect(sel, selectedIdx) {
  if (!sel) return;
  sel.innerHTML = SNAP_VALUES.map((s, i) =>
    `<option value="${i}"${i === selectedIdx ? ' selected' : ''}>${s.label}</option>`
  ).join('');
}
let _snapIdx = SNAP_VALUES.findIndex(s => s.val === SEQ.rollSnapVal);
if (_snapIdx < 0) _snapIdx = SNAP_DEFAULT_IDX;

// Piano-roll snap controls — magnet toggle + unit dropdown.
const _prSnapBtn = document.getElementById('seq-tool-snap');
const _prSnapSel = document.getElementById('seq-snap-val');
if (_prSnapBtn) {
  _prSnapBtn.classList.toggle('active', !!SEQ.rollSnap);
  _prSnapBtn.addEventListener('click', () => {
    SEQ.rollSnap = !SEQ.rollSnap;
    _prSnapBtn.classList.toggle('active', SEQ.rollSnap);
  });
}
if (_prSnapSel) {
  _fillSnapSelect(_prSnapSel, _snapIdx);
  _prSnapSel.addEventListener('change', (e) => {
    _snapIdx = Math.max(0, Math.min(SNAP_VALUES.length - 1, parseInt(e.target.value, 10)));
    SEQ.rollSnapVal = SNAP_VALUES[_snapIdx].val;
  });
}

// Arrangement-view toolbar (above the tracks)
SEQ.arrTool    = SEQ.arrTool    || 'select';
SEQ.arrSnap    = SEQ.arrSnap    ?? true;
SEQ.arrSnapVal = SEQ.arrSnapVal || 1;
let _arrSnapIdx = SNAP_VALUES.findIndex(s => s.val === SEQ.arrSnapVal);
if (_arrSnapIdx < 0) _arrSnapIdx = SNAP_DEFAULT_IDX;
function arrSetTool(tool) {
  SEQ.arrTool = tool;
  ['select','erase','pan','merge','split','create'].forEach(t => {
    document.getElementById('seq-arr-tool-' + t)?.classList.toggle('active', tool === t);
  });
  const wrap = document.getElementById('seq-lane-wrap');
  if (wrap) {
    wrap.classList.remove('arr-tool-select','arr-tool-erase','arr-tool-pan','arr-tool-merge','arr-tool-split','arr-tool-create');
    wrap.classList.add('arr-tool-' + tool);
  }
  // Reset merge sequence whenever the user switches tools (or re-selects merge).
  SEQ._mergeFirst = null;
  document.querySelectorAll('.seq-block.merge-pending').forEach(el => el.classList.remove('merge-pending'));
  // Clear any leftover create-tool ghost preview.
  document.querySelectorAll('.seq-create-ghost').forEach(g => g.remove());
}
function arrSnap(beat) {
  if (!SEQ.arrSnap) return beat;
  return Math.round(beat / SEQ.arrSnapVal) * SEQ.arrSnapVal;
}
function rollSnap(beat) {
  if (!SEQ.rollSnap) return beat;
  return Math.round(beat / SEQ.rollSnapVal) * SEQ.rollSnapVal;
}
// Beats a chord block / chord clip should span when dropped from the chord
// pad onto a track or the piano-roll. Defaults to one bar in the current
// time signature on first use, then sticks at whatever the user picks.
SEQ.chordDropLen = SEQ.chordDropLen || state.beatsPerBar || 4;
function chordDropLen() {
  return SEQ.chordDropLen > 0 ? SEQ.chordDropLen : (state.beatsPerBar || 4);
}
// Delete the currently-selected notes in the piano-roll (mirrors the
// inline Delete/Backspace handler so toolbar buttons can reuse the logic).
function prDeleteNotes() {
  if (!prRollHasNoteSelection()) return;
  const { track, clip } = focusedClipObjects();
  if (!clip) return;
  seqCheckpoint();
  clip.notes = clip.notes.filter(n => !SEQ.prSelection.has(n));
  SEQ.prSelection.clear();
  renderPianoRoll();
  if (track) { seqRenderTrack(track); seqResyncTrack(track); }
  seqSave();
}
['select','erase','pan','merge','split','create'].forEach(t => {
  const btn = document.getElementById('seq-arr-tool-' + t);
  btn?.addEventListener('mousedown', e => e.preventDefault());
  btn?.addEventListener('click', () => {
    // Clicking the already-active tool toggles back to select.
    arrSetTool(SEQ.arrTool === t && t !== 'select' ? 'select' : t);
  });
});

// Edit-action toolbar buttons (mirror the Ctrl+X/C/V/D/Del shortcuts).
// Arrangement-view buttons act on the clip selection; piano-roll buttons
// act on the note selection inside the focused clip.
function _wireEditBtn(id, fn) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', () => fn());
}
_wireEditBtn('seq-arr-edit-undo',      () => seqUndo());
_wireEditBtn('seq-arr-edit-redo',      () => seqRedo());
_wireEditBtn('seq-pr-edit-undo',       () => seqUndo());
_wireEditBtn('seq-pr-edit-redo',       () => seqRedo());
_wireEditBtn('seq-arr-edit-cut',       () => seqCutSelection());
_wireEditBtn('seq-arr-edit-copy',      () => seqCopySelection());
_wireEditBtn('seq-arr-edit-paste',     () => seqPasteSelection());
_wireEditBtn('seq-arr-edit-duplicate', () => seqDuplicateSelection());
_wireEditBtn('seq-arr-edit-delete',    () => seqDeleteSelection());
_wireEditBtn('seq-arr-edit-quantize',  () => seqQuantizeSelection());
// Project export / import (download / upload .json). Lives in the
// transport bar — operates on the whole project, not the arrangement.
_wireEditBtn('seq-project-export', () => seqExportProject());
_wireEditBtn('seq-project-import', () => document.getElementById('seq-project-import-input')?.click());
document.getElementById('seq-project-import-input')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!seqImportProject(data)) {
        alert('Could not import project — JSON did not match expected shape.');
      }
    } catch (err) {
      alert('Could not parse JSON: ' + err.message);
    }
  };
  reader.readAsText(file);
  // Clear so picking the same file twice still triggers change.
  e.target.value = '';
});
_wireEditBtn('seq-pr-edit-cut',        () => prCutNotes());
_wireEditBtn('seq-pr-edit-copy',       () => prCopyNotes());
_wireEditBtn('seq-pr-edit-paste',      () => prPasteNotes());
_wireEditBtn('seq-pr-edit-duplicate',  () => prDuplicateNotes());
_wireEditBtn('seq-pr-edit-delete',     () => prDeleteNotes());
_wireEditBtn('seq-pr-edit-quantize',   () => prQuantizeNotes());
// Transport navigation buttons (jump play-cursor to start/end of
// project / loop).
_wireEditBtn('seq-nav-track-start', () => seqJumpTrackStart());
_wireEditBtn('seq-nav-track-end',   () => seqJumpTrackEnd());
_wireEditBtn('seq-nav-loop-start',  () => seqJumpLoopStart());
_wireEditBtn('seq-nav-loop-end',    () => seqJumpLoopEnd());

// Step-cursor buttons with press-and-hold to repeat. Each press shifts
// the play-cursor by one snap unit (or 1 beat if snap is off). Holding
// the button repeats every 80 ms after a 300 ms initial delay.
function _wireStepCursor(id, dir) {
  const btn = document.getElementById(id);
  if (!btn) return;
  let delayTimer = null, repeatTimer = null;
  const step = () => {
    const unit = SEQ.arrSnap ? SEQ.arrSnapVal : 1;
    seqJumpToBeat((SEQ.startBeat || 0) + dir * unit);
  };
  const stop = () => {
    if (delayTimer)  { clearTimeout(delayTimer);  delayTimer  = null; }
    if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    step();
    delayTimer = setTimeout(() => {
      repeatTimer = setInterval(step, 80);
    }, 300);
  });
  btn.addEventListener('pointerup',     stop);
  btn.addEventListener('pointercancel', stop);
  btn.addEventListener('pointerleave',  stop);
}
_wireStepCursor('seq-nav-cursor-left',  -1);
_wireStepCursor('seq-nav-cursor-right', +1);

// Chord-length dropdowns (arrangement + piano-roll) — kept in sync so the
// same setting drives the duration of any chord dropped from the pad,
// whether onto a track lane or into the roll.
(function _initChordLenSelects() {
  const arrSel = document.getElementById('seq-arr-chordlen');
  const prSel  = document.getElementById('seq-pr-chordlen');
  let idx = SNAP_VALUES.findIndex(s => s.val === SEQ.chordDropLen);
  if (idx < 0) idx = SNAP_CHORDLEN_DEFAULT_IDX; // default = "1" (one bar in 4/4)
  // Populate both dropdowns once, then keep them in sync on change.
  _fillSnapSelect(arrSel, idx);
  _fillSnapSelect(prSel,  idx);
  const apply = (i) => {
    idx = Math.max(0, Math.min(SNAP_VALUES.length - 1, i));
    SEQ.chordDropLen = SNAP_VALUES[idx].val;
    if (arrSel) arrSel.value = String(idx);
    if (prSel)  prSel.value  = String(idx);
    seqSave();
  };
  apply(idx);
  arrSel?.addEventListener('change', e => apply(parseInt(e.target.value, 10)));
  prSel ?.addEventListener('change', e => apply(parseInt(e.target.value, 10)));
  // Clicking the icon area of the wrap should open the dropdown too,
  // not just focus the select. Browsers don't natively open a <select>
  // when its <label> is clicked, so trigger showPicker() ourselves.
  document.querySelectorAll('.seq-chordlen-wrap').forEach(wrap => {
    wrap.addEventListener('click', (e) => {
      if (e.target.tagName === 'SELECT') return; // let the select handle its own click
      const sel = wrap.querySelector('select');
      if (sel && typeof sel.showPicker === 'function') {
        e.preventDefault();
        try { sel.showPicker(); } catch (_) { sel.focus(); }
      }
    });
  });
})();
(function _initVisualLatencyCtrl() {
  const el = document.getElementById('seq-visual-latency');
  if (!el) return;
  el.value = String(SEQ.visualLatencyMs || 0);
  el.addEventListener('input', () => {
    const v = parseInt(el.value, 10);
    SEQ.visualLatencyMs = isNaN(v) ? 0 : Math.max(-50, Math.min(200, v));
    seqSave();
  });
})();
document.getElementById('seq-arr-zoom-in') ?.addEventListener('click', () => seqApplyZoom(BEAT_PX * 1.25));
document.getElementById('seq-arr-zoom-out')?.addEventListener('click', () => seqApplyZoom(BEAT_PX / 1.25));
document.getElementById('pr-zoom-in') ?.addEventListener('click', () => prApplyZoom(PR_BEAT_PX * 1.25));
document.getElementById('pr-zoom-out')?.addEventListener('click', () => prApplyZoom(PR_BEAT_PX / 1.25));
// Follow-cursor toggles for arrangement + piano roll. State lives on
// SEQ so the playhead-frame loop in seq.js can read it without a DOM
// query each tick. Persisted in the UI-prefs blob (which already
// reaches into SEQ.* via uiPrefsLoad/Save).
(function _initFollowToggles() {
  const bind = (btnId, flag) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.classList.toggle('active', !!SEQ[flag]);
    btn.addEventListener('click', () => {
      SEQ[flag] = !SEQ[flag];
      btn.classList.toggle('active', !!SEQ[flag]);
      if (typeof uiPrefsSave === 'function') uiPrefsSave();
    });
  };
  bind('seq-arr-follow', 'followArr');
  bind('pr-follow',      'followPr');
})();
// Ctrl + wheel zooms wherever the cursor is over the track-arrangement or
// piano-roll body. preventDefault stops the browser-level page zoom.
(function _initZoomWheel() {
  const wrap = document.getElementById('seq-lane-wrap');
  const body = document.getElementById('seq-pianoroll-body');
  const zoomFromWheel = (ev, applyFn, current) => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    applyFn(current() * factor, ev.clientX);
  };
  wrap?.addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    zoomFromWheel(ev, seqApplyZoom, () => BEAT_PX);
  }, { passive: false });
  body?.addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    zoomFromWheel(ev, prApplyZoom, () => PR_BEAT_PX);
  }, { passive: false });
})();

// Arrangement snap controls — magnet toggle + unit dropdown.
const _arrSnapBtn = document.getElementById('seq-arr-tool-snap');
const _arrSnapSel = document.getElementById('seq-arr-snap-val');
if (_arrSnapBtn) {
  _arrSnapBtn.classList.toggle('active', !!SEQ.arrSnap);
  _arrSnapBtn.addEventListener('click', () => {
    SEQ.arrSnap = !SEQ.arrSnap;
    _arrSnapBtn.classList.toggle('active', SEQ.arrSnap);
  });
}
if (_arrSnapSel) {
  _fillSnapSelect(_arrSnapSel, _arrSnapIdx);
  _arrSnapSel.addEventListener('change', (e) => {
    _arrSnapIdx = Math.max(0, Math.min(SNAP_VALUES.length - 1, parseInt(e.target.value, 10)));
    SEQ.arrSnapVal = SNAP_VALUES[_arrSnapIdx].val;
  });
}
arrSetTool(SEQ.arrTool);
// Pan-mode (and marquee-select) on the arrangement wrap.
(function _initArrPan() {
  const wrap = document.getElementById('seq-lane-wrap');
  if (!wrap) return;
  // Hover-ghost preview for the create tool. Shows where the empty clip
  // will land, snapped to the current snap unit.
  const _removeCreateGhost = () => {
    document.querySelectorAll('.seq-create-ghost').forEach(g => g.remove());
  };
  wrap.addEventListener('pointermove', (e) => {
    if (SEQ.arrTool !== 'create') { _removeCreateGhost(); return; }
    const lane = e.target.classList?.contains('seq-lane') ? e.target : null;
    const t = lane ? trackById(lane.dataset.trackId) : null;
    if (!t || t.kind !== 'free') { _removeCreateGhost(); return; }
    const rect = lane.getBoundingClientRect();
    const snapV = SEQ.arrSnap ? SEQ.arrSnapVal : (1 / BEAT_PX);
    let beat = Math.max(0, (e.clientX - rect.left) / BEAT_PX);
    beat = Math.floor(beat / snapV) * snapV;
    const beats = Math.max(snapV, state.beatsPerBar);
    let ghost = lane.querySelector(':scope > .seq-create-ghost');
    // If a ghost lives in another lane, scrub it first.
    document.querySelectorAll('.seq-create-ghost').forEach(g => { if (g.parentElement !== lane) g.remove(); });
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.className = 'seq-ghost seq-create-ghost';
      lane.appendChild(ghost);
    }
    ghost.style.left  = (beat * BEAT_PX) + 'px';
    ghost.style.width = (beats * BEAT_PX) + 'px';
  });
  wrap.addEventListener('pointerleave', _removeCreateGhost);
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.seq-track-sidebar')) return;
    // Clicks that land on (or inside) a clip block must reach the block's
    // own bubble-phase listener — don't swallow them here unless we're
    // explicitly in pan mode (which scrolls regardless of target).
    const onBlock = !!e.target.closest('.seq-block');
    // Pan: hand-tool active OR spacebar held — wraps drag-to-scroll.
    if (SEQ.arrTool === 'pan' || SEQ._arrSpaceHeld) {
      e.preventDefault();
      e.stopPropagation();
      wrap.setPointerCapture(e.pointerId);
      const startX = e.clientX, startY = e.clientY;
      const startSL = wrap.scrollLeft, startST = wrap.scrollTop;
      wrap.classList.add('arr-panning');
      const onMove = (ev) => {
        wrap.scrollLeft = startSL - (ev.clientX - startX);
        wrap.scrollTop  = startST - (ev.clientY - startY);
      };
      const onUp = () => {
        wrap.removeEventListener('pointermove', onMove);
        wrap.removeEventListener('pointerup', onUp);
        wrap.classList.remove('arr-panning');
      };
      wrap.addEventListener('pointermove', onMove);
      wrap.addEventListener('pointerup', onUp);
      return;
    }
    // Marquee-select: only when click starts on an empty lane area (not
    // on a clip / chord block) and the select tool is active.
    if (onBlock) return;
    // Create tool: clicking an empty free-lane spawns a 1-bar empty clip
    // at the snapped beat position. Tool stays active so you can quickly
    // place several clips in a row.
    if (SEQ.arrTool === 'create' && e.target.classList?.contains('seq-lane')) {
      const t = trackById(e.target.dataset.trackId);
      if (t && t.kind === 'free') {
        e.preventDefault();
        e.stopPropagation();
        const rect = e.target.getBoundingClientRect();
        const snapV = SEQ.arrSnap ? SEQ.arrSnapVal : (1 / BEAT_PX);
        let beat = Math.max(0, (e.clientX - rect.left) / BEAT_PX);
        beat = Math.floor(beat / snapV) * snapV;
        seqCheckpoint();
        const beats = Math.max(snapV, state.beatsPerBar);
        const clip = makeClip({ start: beat, beats, label: null, notes: [] });
        t.items.push(clip);
        t.items.sort((a, b) => a.start - b.start);
        seqAutoExtendLoop(beat + beats);
        document.querySelectorAll('.seq-create-ghost').forEach(g => g.remove());
        seqRenderTrack(t);
        seqResyncTrack(t);
        seqSave();
      }
      return;
    }
    if (SEQ.arrTool === 'select' && e.target.classList?.contains('seq-lane')) {
      e.preventDefault();
      wrap.setPointerCapture(e.pointerId);
      const inner = document.getElementById('seq-tracks-inner');
      const innerRect = inner.getBoundingClientRect();
      const startX = e.clientX - innerRect.left;
      const startY = e.clientY - innerRect.top;
      // Snapshot the selection so shift-marquee adds to it; without
      // shift, we start fresh. Each move rebuilds from the snapshot so
      // items that have left the marquee rect get unselected again.
      const baseSel = e.shiftKey ? SEQ.selection.slice() : [];
      if (!e.shiftKey) seqClearSelection();
      const marquee = document.createElement('div');
      marquee.className = 'seq-marquee';
      inner.appendChild(marquee);
      const onMove = (ev) => {
        const x = ev.clientX - innerRect.left;
        const y = ev.clientY - innerRect.top;
        const left = Math.min(startX, x), top = Math.min(startY, y);
        const right = Math.max(startX, x), bottom = Math.max(startY, y);
        marquee.style.left = left + 'px';
        marquee.style.top  = top + 'px';
        marquee.style.width  = (right - left) + 'px';
        marquee.style.height = (bottom - top) + 'px';
        // Rebuild selection: snapshot + everything currently inside rect.
        SEQ.selection = baseSel.slice();
        document.querySelectorAll('#seq-tracks-inner .seq-lane .seq-block').forEach(block => {
          const bRect = block.getBoundingClientRect();
          const bLeft = bRect.left - innerRect.left, bTop = bRect.top - innerRect.top;
          const bRight = bLeft + bRect.width, bBottom = bTop + bRect.height;
          const hit = bRight >= left && bLeft <= right && bBottom >= top && bTop <= bottom;
          if (!hit) return;
          const laneEl = block.parentElement;
          const trackId = laneEl?.dataset?.trackId;
          const t = trackById(trackId);
          if (!t) return;
          // Map block back to its item via DOM index — robust against
          // duplicate clip ids (which can occur in legacy projects).
          const blocks = [...laneEl.children].filter(c => c.classList.contains('seq-block'));
          const idx = blocks.indexOf(block);
          const item = idx >= 0 ? t.items[idx] : null;
          if (item && !SEQ.selection.some(s => s.trackId === t.id && s.item === item)) {
            SEQ.selection.push({ trackId: t.id, item });
          }
        });
        seqRefreshSelectionVisuals();
      };
      const onUp = () => {
        wrap.removeEventListener('pointermove', onMove);
        wrap.removeEventListener('pointerup', onUp);
        marquee.remove();
      };
      wrap.addEventListener('pointermove', onMove);
      wrap.addEventListener('pointerup', onUp);
    }
  }, true);
})();
setRollTool('none');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
