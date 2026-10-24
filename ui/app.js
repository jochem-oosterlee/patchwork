// UI <-> engine. JSON over a localhost WebSocket.

const WS_URL = 'ws://127.0.0.1:7681';

const inputListEl  = document.getElementById('midi-input-list');
const outputSel    = document.getElementById('midi-output');
const nameEl       = document.getElementById('plugin-status');
const presetListEl = document.getElementById('preset-list');
const modalEl      = document.getElementById('library-modal');
const modalCloseBtn = document.getElementById('library-close');
const gridEl       = document.getElementById('library-grid');
const midiModal    = document.getElementById('midi-modal');
const audioModal   = document.getElementById('audio-modal');
const audDeviceType = document.getElementById('audio-device-type');
const audDevice     = document.getElementById('audio-device');
const audSampleRate = document.getElementById('audio-sample-rate');
const audBufferSize = document.getElementById('audio-buffer-size');
const tagModal       = document.getElementById('tag-modal');
const tagEditor      = document.getElementById('tag-editor');
const sourcesListEl  = document.getElementById('sources-list');
const sourcesRailEl  = document.querySelector('.sources-rail');
const sourceModal    = document.getElementById('source-modal');
const sourceLabelEl  = document.getElementById('source-label');
const sourceIconGrid = document.getElementById('source-icon-grid');
const sourceDeviceEl = document.getElementById('source-device');
const sourceChansEl  = document.getElementById('source-channels');
const sourceDeleteBtn  = document.getElementById('source-delete');
const sourceDefaultBtn = document.getElementById('source-default');
const sourceClockChk   = document.getElementById('source-is-clock');
const sourceAddBtn     = document.getElementById('source-add');
const routingModal   = document.getElementById('routing-modal');
const routingInputs  = document.getElementById('routing-input-list');
const routingChans   = document.getElementById('routing-channels');
const setStrip     = document.getElementById('patchset-strip');
const setPrevBtn   = document.getElementById('patchset-prev');
const setNextBtn   = document.getElementById('patchset-next');
const undoBtn      = document.getElementById('btn-undo');
const redoBtn      = document.getElementById('btn-redo');
const kbOutSel     = document.getElementById('kb-output');
const kbContainer  = document.getElementById('kb-container');
const kbOctLabel   = document.getElementById('kb-oct-label');
const kbOctDownBtn = document.getElementById('kb-oct-down');
const kbOctUpBtn   = document.getElementById('kb-oct-up');
const logBodyEl    = document.getElementById('log-body');
const logSectionEl = document.querySelector('.log-section');
const logClearBtn  = document.getElementById('log-clear');

let ws = null;
let pendingState = null;
let currentPluginName = '';
let focusNewPreset = false;
let arturiaPlugins = null;
let pickingMode = null; // null | 'new-preset'  — set when File>New or ghost row triggers library
let currentPresetsCache = [];

const TAXONOMY = [
  { name: 'Bass',           subs: ['Bass Line', 'Hard Bass', 'Plucked Bass', 'Soft Bass', 'Sub Bass'] },
  { name: 'Keys',           subs: ['Bells', 'Classic Synth Keys', 'Evolving Keys', 'Lofi Keys', 'Mallets', 'Percussive Keys', 'Plucked Keys'] },
  { name: 'Lead',           subs: ['Big Lead', 'Dirty Lead', 'Hard Lead', 'Percussive Lead', 'Plucked Lead', 'Poly Lead', 'Soft Lead', 'Solo Lead', 'Synced Lead'] },
  { name: 'Pad',            subs: ['Atmosphere', 'Bright Pad', 'Choir', 'Classic Synth Pad', 'Evolving Pad', 'Strings Pad'] },
  { name: 'Piano',          subs: ['Acoustic Grand', 'Acoustic Upright', 'Hybrid', 'Percussive'] },
  { name: 'Electric Piano', subs: ['Classic EP', 'Clavinet', 'Creative EP'] },
  { name: 'Organ',          subs: ['Combo Organ', 'Synth Organ', 'Tonewheel Organ'] },
  { name: 'Strings',        subs: ['Bowed Strings', 'Guitar', 'Plucked Strings', 'String Ensemble'] },
  { name: 'Brass & Winds',  subs: ['Brass Acoustic', 'Brass Hybrid', 'Brass Synth', 'Winds Acoustic', 'Winds Hybrid', 'Winds Synth'] },
  { name: 'Drums',          subs: ['Creative Drums', 'Drum Kit', 'Drum Loop', 'High Hat', 'Kick', 'Percussion', 'Snare', 'Tom'] },
  { name: 'Sequence',       subs: ['Arpeggio', 'Melodic Sequence', 'Noise Sequence', 'Rhythmic Sequence'] },
  { name: 'Vocal',          subs: ['Real Choir', 'Synth Choir', 'Vocoder'] },
  { name: 'Sound Effects',  subs: ['Ambient SFX', 'Creative SFX', 'Drone', 'Hit', 'Machines', 'Nature Sounds', 'Noise', 'Soundtrack', 'Sweeps'] },
];

// Short marketing-style blurbs per Arturia instrument. Used as tooltip/detail
// panel in the library view. Add freely — anything missing just shows the name.
const ARTURIA_INFO = {
  'Solina V2':         { tagline: 'Authentic orchestra machine.', body: 'Float your mind on the swirling liquid textures of the premiere string machine of the 1970s.' },
  'Mellotron V':       { tagline: 'Tape-replay legend.',           body: 'The original sample player — strings, flutes, choirs and brass straight off the tape strips.' },
  'Memory V':          { tagline: 'Six-voice analog warmth.',      body: 'Faithful recreation of the Moog Memorymoog: lush poly leads, pads and basses with three oscillators per voice.' },
  'Acid V':            { tagline: 'Squelchy 303 magic.',           body: 'The unmistakable bassline + sequencer combo that powers acid house and techno, with built-in drive and modulation.' },
  'Stage-73 V2':       { tagline: 'The legendary tine piano.',     body: 'Bell-like highs, warm lows, ready for both vintage and modern productions.' },
  'CP-70 V':           { tagline: 'Iconic electric grand.',         body: 'The road-tested favorite of rock and pop legends, with bite and shimmer.' },
  'Clavinet V':        { tagline: 'Funk machine on demand.',        body: 'Snappy, percussive electric clav with playable filters and amp simulation.' },
  'Piano V3':          { tagline: 'Acoustic pianos for any style.', body: 'Multiple modeled grands and uprights, from concert hall to honky-tonk.' },
  'Wurli V3':          { tagline: 'That breathy electric tone.',    body: 'The classic reed-and-bar electric piano, with full pedal/amp signal chain.' },
  'B-3 V2':            { tagline: 'Soul-shaking tonewheel organ.',  body: 'Drawbar tonewheel with rotary, percussion and tube-amp character.' },
  'Farfisa V':         { tagline: 'Combo-organ icon.',              body: 'Bright, biting combo-organ sound straight from the 60s.' },
  'VOX Continental V2':{ tagline: 'British invasion tone.',         body: 'Crisp transistor organ with that unmistakable bright top end.' },
  'Mini V':            { tagline: 'The granddaddy of analog.',      body: 'Faithful recreation of the most famous monosynth ever made.' },
  'Mini V4':           { tagline: 'Mini, evolved.',                  body: 'Updated mini-style monosynth with extra oscillators and modulation.' },
  'Prophet-5 V':       { tagline: 'Polyphonic warmth.',              body: 'The classic 5-voice analog poly — pads, leads, and brass for days.' },
  'Prophet-VS V':      { tagline: 'Wavetable vector synthesis.',     body: 'Digital wavetable poly with the iconic vector joystick.' },
  'Jup-8 V4':          { tagline: 'Lush 80s synth pads.',            body: 'Recreation of the legendary Japanese poly. Pads, plucks, chorus, bliss.' },
  'Jun-6 V':           { tagline: 'Always-on chorus charm.',         body: 'Single-DCO classic with that famous built-in chorus.' },
  'CS-80 V4':          { tagline: 'Cinematic poly.',                 body: 'Massive sci-fi-soundtrack synth with ribbon controller and polyphonic aftertouch.' },
  'ARP 2600 V3':       { tagline: 'Modular without patching.',       body: 'Semi-modular legend used on countless records and sound design.' },
  'Matrix-12 V2':      { tagline: 'Programmable analog.',            body: '12-voice analog poly with deep modulation matrix.' },
  'MiniFreak V':       { tagline: 'Wavetable + digital fun.',        body: 'Hybrid digital/analog poly with macros, modulation, FX.' },
  'Pigments':          { tagline: 'Modern poly powerhouse.',         body: 'Software-native poly with wavetable, analog, sample, granular and harmonic engines.' },
  'Analog Lab V':      { tagline: 'All your favourites in one.',     body: 'Thousands of presets pulled from every Arturia V Collection instrument.' },
  'Augmented STRINGS': { tagline: 'Modern hybrid strings.',          body: 'Acoustic strings layered with synthesis for instant evolving textures.' },
  'Augmented BRASS':   { tagline: 'Hybrid brass.',                   body: 'Acoustic brass fused with synthesis for cinematic punch.' },
  'Augmented VOICES':  { tagline: 'Hybrid choirs and vox.',          body: 'Sampled vocals blended with synth processing for ethereal layers.' },
  'Augmented WOODWINDS':{ tagline: 'Reed and pipe textures.',        body: 'Hybrid woodwinds for haunting solos and lush ensemble pads.' },
  'Augmented MALLETS': { tagline: 'Bells, marimbas, and beyond.',    body: 'Mallet instruments layered with synthesis for percussive ambience.' },
  'Augmented GRAND PIANO': { tagline: 'Piano + synthesis.',          body: 'Concert grand fused with evolving synth pads and pulses.' },
  'Augmented YANGTZE': { tagline: 'Chinese strings, reimagined.',    body: 'Traditional Yangtze strings blended with synthesis textures.' },
  'Modular V3':        { tagline: 'Big-system modular.',             body: 'Recreation of a classic 1970s modular synth with dozens of patchable modules.' },
  'OP-Xa V':           { tagline: 'Eight-voice analog poly.',         body: 'Recreation of the Oberheim OB-Xa — fat split/layer pads and brass.' },
  'SEM V3':            { tagline: 'Smooth Oberheim mono/duo.',        body: 'Oberheim Synthesizer Expansion Module: silky filters and classic patch-cord modulation.' },
  'KORG MS-20 V':      { tagline: 'Patch-pin punk.',                  body: 'Faithful Korg MS-20 emulation with its aggressive filter and semi-modular patching.' },
  'Buchla Easel V':    { tagline: 'West Coast wonderbox.',            body: 'Music Easel emulation — complex oscillator + low-pass gates for organic timbres.' },
  'MiniBrute V':       { tagline: 'Mono-synth grit.',                  body: 'Brute oscillator, Steiner filter and metalizer — raw, aggressive analog tone.' },
  'SQ80 V':            { tagline: 'Cross-wave hybrid.',                body: 'Recreation of the Ensoniq SQ-80 — digital wavetables routed through analog filters.' },
  'Synthx V':          { tagline: 'Italian poly classic.',             body: 'Inspired by the Elka Synthex — six-voice analog with distinctive PWM and chorus.' },
  'Synthi V':          { tagline: 'Pin-matrix legend.',                body: 'EMS Synthi emulation with the famous pin-matrix patching, joystick and spring reverb.' },
  'DX7 V':             { tagline: '80s FM royalty.',                  body: 'Six-operator FM synthesis — bell pianos, bass and crystalline pads of the era.' },
  'CZ V':              { tagline: 'Phase distortion shimmer.',         body: 'Casio CZ-style phase-distortion synthesis with biting digital harmonics.' },
  'Synclavier V':      { tagline: 'Studio-defining digital.',          body: 'FM + additive workstation — the sound of countless 80s and 90s productions.' },
  'CMI V':             { tagline: 'Sampler that shaped pop.',          body: 'Fairlight CMI sampling/synthesis workstation — classic crunchy 8-bit samples and additive layers.' },
  'Emulator II V':     { tagline: 'Iconic 8-bit sampler.',             body: 'E-mu Emulator II recreation — that grainy 80s sampler character on the toughest hits.' },
  'Jup-8000 V':        { tagline: 'Supersaw machine.',                 body: 'Roland JP-8000 inspired — the supersaw, feedback osc and trance staples.' },
  'Vocoder V':         { tagline: 'Robotic voice classic.',            body: 'Recreation of vintage 16-band vocoders for talking instruments and robotic vox.' },
  'Pure LoFi':         { tagline: 'Tape, vinyl, cassette grit.',       body: 'Multi-effect that adds all the wow, flutter, noise and saturation of beloved lo-fi mediums.' },
};

// Category map for known Arturia instruments. Anything unknown lands in "Other".
const CATEGORIES = [
  { name: 'Multi / hybrid', match: ['Analog Lab V', 'Pigments'] },
  { name: 'Pianos & keys',  match: ['Piano V3', 'CP-70 V', 'Stage-73 V2', 'Clavinet V', 'Wurli V3'] },
  { name: 'Organs',         match: ['B-3 V2', 'Farfisa V', 'VOX Continental V2'] },
  { name: 'String machines', match: ['Solina V2', 'Mellotron V'] },
  { name: 'Analog synths',  match: ['Mini V4', 'Mini V', 'Memory V', 'Prophet-5 V', 'Prophet-VS V', 'Jup-8 V4', 'Jun-6 V', 'ARP 2600 V3', 'Modular V3', 'Matrix-12 V2', 'CS-80 V4', 'OP-Xa V', 'SEM V3', 'KORG MS-20 V', 'Buchla Easel V', 'MiniBrute V', 'MiniFreak V', 'SQ80 V', 'Synthx V', 'Synthi V'] },
  { name: 'Digital & FM',   match: ['DX7 V', 'CZ V', 'Synclavier V', 'CMI V', 'Emulator II V', 'Jup-8000 V'] },
  { name: 'Augmented',      match: ['Augmented BRASS', 'Augmented GRAND PIANO', 'Augmented MALLETS', 'Augmented STRINGS', 'Augmented VOICES', 'Augmented WOODWINDS', 'Augmented YANGTZE'] },
  { name: 'Drum machines & loops', match: ['Acid V'] },
  { name: 'FX & utility',   match: ['Vocoder V', 'Pure LoFi'] },
];

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function applyPendingState() {
  if (!pendingState) return;
  const { enabledDevices, midiOut, kbOut } = pendingState;
  const setIfPresent = (sel, val) => {
    if ([...sel.options].some(o => o.value === (val || ''))) sel.value = val || '';
  };
  setIfPresent(outputSel, midiOut);
  setIfPresent(kbOutSel, kbOut);
  currentEnabledDevices = enabledDevices || [];
  const sel = new Set(currentEnabledDevices);
  inputListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = sel.has(cb.value);
  });
}

function setPluginName(name) {
  currentPluginName = name || '';
  if (name) {
    nameEl.textContent = name;
    nameEl.classList.remove('empty');
  } else {
    nameEl.textContent = 'no plugin';
    nameEl.classList.add('empty');
  }
}

let currentSets = [];
let currentSetIdx = 0;

function flashSaved(btn, restoreIcon) {
  btn.classList.add('saved');
  btn.innerHTML = '<i data-lucide="check"></i>';
  if (window.lucide) lucide.createIcons();
  setTimeout(() => {
    btn.classList.remove('saved');
    btn.innerHTML = `<i data-lucide="${restoreIcon}"></i>`;
    if (window.lucide) lucide.createIcons();
  }, 1500);
}

// Generic right-click / context menu. items = array of:
//   { label, icon?, danger?, disabled?, submenu?, action? }
//   submenu = function returning the same array shape (lazy).
function openContextMenu(items, x, y, opts = {}) {
  if (!opts.keepExisting) {
    closeAllMenus();
    document.querySelectorAll('.context-menu').forEach(m => m.remove());
  }
  const menu = document.createElement('div');
  menu.className = 'dropdown-menu context-menu';
  menu.style.position = 'fixed';
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';

  items.forEach(it => {
    if (it.separator) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'menu-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
    if (it.disabled) btn.disabled = true;
    const iconHtml = it.icon ? `<span class="menu-icon"><i data-lucide="${it.icon}"></i></span>` : '<span class="menu-icon"></span>';
    btn.innerHTML = `${iconHtml}<span class="menu-label">${escapeHtml(it.label)}</span>${it.submenu ? '<span class="menu-state">›</span>' : ''}`;
    if (it.submenu) {
      const openSubmenu = () => {
        // Close any nested submenu deeper than us, but keep this menu open.
        const menus = [...document.querySelectorAll('.context-menu')];
        const myIdx = menus.indexOf(menu);
        menus.slice(myIdx + 1).forEach(m => m.remove());
        const r = btn.getBoundingClientRect();
        const subItems = typeof it.submenu === 'function' ? it.submenu() : it.submenu;
        openContextMenu(subItems, r.right + 4, r.top, { keepExisting: true });
      };
      btn.addEventListener('click', e => { e.stopPropagation(); openSubmenu(); });
      btn.addEventListener('mouseenter', () => {
        // Close any open sibling submenu first, then open this one.
        document.querySelectorAll('.context-menu').forEach(m => {
          if (m !== menu) m.remove();
        });
        openSubmenu();
      });
    } else if (it.action) {
      btn.addEventListener('mouseenter', () => {
        // Hovering a non-submenu item closes any open child submenus.
        const menus = [...document.querySelectorAll('.context-menu')];
        const myIdx = menus.indexOf(menu);
        menus.slice(myIdx + 1).forEach(m => m.remove());
      });
      btn.addEventListener('click', e => {
        e.stopPropagation();
        it.action();
        document.querySelectorAll('.context-menu').forEach(m => m.remove());
      });
    }
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  // Clamp inside viewport.
  const w = menu.offsetWidth, h = menu.offsetHeight;
  if (x + w > window.innerWidth  - 8) menu.style.left = (window.innerWidth  - w - 8) + 'px';
  if (y + h > window.innerHeight - 8) menu.style.top  = (window.innerHeight - h - 8) + 'px';
  if (window.lucide) lucide.createIcons();
  const off = (e) => {
    if (!e.target.closest('.context-menu')) {
      document.querySelectorAll('.context-menu').forEach(m => m.remove());
      document.removeEventListener('click',   off, true);
      document.removeEventListener('contextmenu', off, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('click',       off, true);
    document.addEventListener('contextmenu', off, true);
  }, 0);
}

function openPresetContextMenu(idx, x, y) {
  const p = currentPresetsCache[idx];
  if (!p) return;
  const otherSets = currentSets
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => i !== currentSetIdx);
  const setSubmenu = (cmd) => () => otherSets.length
    ? otherSets.map(({ s, i }) => ({
        label: s.name,
        icon: 'arrow-right',
        action: () => send({ cmd, presetIndex: idx, destSet: i }),
      }))
    : [{ label: 'no other patchsets', disabled: true }];
  openContextMenu([
    { label: p.pinned ? 'Unpin' : 'Pin',  icon: p.pinned ? 'pin-off' : 'pin', action: () => send({ cmd: 'toggle_pin_preset', index: idx }) },
    { label: 'Tags…',                      icon: 'tag',                       action: () => openTagEditor(idx) },
    { separator: true },
    { label: 'Copy to patchset', icon: 'copy-plus', submenu: setSubmenu ('copy_preset_to_set') },
    { label: 'Move to patchset', icon: 'arrow-right-from-line', submenu: setSubmenu ('move_preset_to_set') },
    { separator: true },
    { label: 'Delete', icon: 'trash-2', danger: true, action: () => send({ cmd: 'delete_preset', index: idx }) },
  ], x, y);
}

function openPatchsetContextMenu(idx, x, y) {
  const s = currentSets[idx];
  if (!s) return;
  openContextMenu([
    { label: 'Rename…',       icon: 'pencil', action: () => { send({ cmd: 'select_set', index: idx }); setTimeout(beginRenameSet, 60); } },
    { label: 'Duplicate',     icon: 'copy',   action: () => send({ cmd: 'duplicate_set', index: idx }) },
    { label: 'Clear presets', icon: 'eraser', action: () => { send({ cmd: 'select_set', index: idx }); setTimeout(() => send({ cmd: 'clear_set' }), 60); } },
    { separator: true },
    { label: s.archived ? 'Unarchive' : 'Archive', icon: 'archive', action: () => send({ cmd: 'set_archived', index: idx, archived: !s.archived }) },
    { label: 'Delete', icon: 'trash-2', danger: true, disabled: currentSets.length <= 1, action: () => send({ cmd: 'delete_set', index: idx }) },
  ], x, y);
}

function openCopyToSetMenu(presetIdx, anchor, onPicked) {
  closeAllMenus();
  const menu = document.createElement('div');
  menu.className = 'dropdown-menu copy-to-set-menu';
  const presetName = (currentPresetsCache[presetIdx] || {}).name || '';
  if (currentSets.length <= 1) {
    const empty = document.createElement('div');
    empty.className = 'menu-item';
    empty.style.color = 'var(--text-faint)';
    empty.textContent = 'no other patchsets';
    menu.appendChild(empty);
  } else {
    currentSets.forEach((s, i) => {
      if (i === currentSetIdx) return;
      const has = (s.presetNames || []).includes(presetName);
      const item = document.createElement('button');
      item.className = 'menu-item';
      const note = has ? '<span class="menu-state">already there</span>' : '';
      item.innerHTML = `<span class="menu-icon"><i data-lucide="arrow-right"></i></span><span class="menu-label">${escapeHtml(s.name)}</span>${note}`;
      item.addEventListener('click', () => {
        send({ cmd: 'copy_preset_to_set', presetIndex: presetIdx, destSet: i });
        menu.remove();
        if (onPicked) onPicked();
      });
      menu.appendChild(item);
    });
  }
  document.body.appendChild(menu);
  positionMenu(menu, anchor);
  if (window.lucide) lucide.createIcons();
  const off = (e) => {
    if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener('click', off, true); }
  };
  setTimeout(() => document.addEventListener('click', off, true), 0);
}

function renderPatchsetBar(sets, idx) {
  currentSets = sets || [];
  currentSetIdx = idx || 0;
  setStrip.innerHTML = '';
  currentSets.forEach((s, i) => {
    if (s.archived) return;
    const pill = document.createElement('button');
    pill.className = 'patchset-pill' + (i === currentSetIdx ? ' active' : '');
    pill.innerHTML = `<span class="label">${escapeHtml(s.name)}</span><span class="count">${s.count}</span>`;
    pill.addEventListener('click', () => {
      if (i !== currentSetIdx) send({ cmd: 'select_set', index: i });
    });
    pill.addEventListener('dblclick', () => {
      if (i === currentSetIdx) beginRenameSet();
    });
    pill.addEventListener('contextmenu', e => {
      e.preventDefault();
      openPatchsetContextMenu(i, e.clientX, e.clientY);
    });
    setStrip.appendChild(pill);
  });
  // New-patchset ghost pill, always rendered after the last set.
  const addPill = document.createElement('button');
  addPill.id = 'patchset-new';
  addPill.className = 'patchset-pill ghost';
  addPill.title = 'new patchset';
  addPill.innerHTML = '<i data-lucide="plus"></i><span>new patchset</span>';
  addPill.addEventListener('click', () => send({ cmd: 'create_set', name: 'New set' }));
  setStrip.appendChild(addPill);

  // Scroll the active pill into view.
  const active = setStrip.querySelector('.patchset-pill.active');
  if (active) active.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  setPrevBtn.disabled = currentSetIdx <= 0;
  setNextBtn.disabled = currentSetIdx >= currentSets.length - 1;
}
let rackCanUndo = false, rackCanRedo = false;
function setUndoRedoState(canUndo, canRedo) {
  rackCanUndo = canUndo; rackCanRedo = canRedo;
  if (document.body.classList.contains('view-compose')) return;   // buttons belong to the song there
  undoBtn.disabled = !canUndo;
  redoBtn.disabled = !canRedo;
}
// In the Compose view undo/redo belong to the song; in the Rack view to the rack.
const inComposeView = () => document.body.classList.contains('view-compose');
undoBtn.addEventListener('click', () => inComposeView() ? postToCompose('undo') : send({ cmd: 'undo' }));
redoBtn.addEventListener('click', () => inComposeView() ? postToCompose('redo') : send({ cmd: 'redo' }));
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === 'z' || e.key === 'Z') {
    if (e.target && e.target.isContentEditable) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    e.preventDefault();
    send({ cmd: e.shiftKey ? 'redo' : 'undo' });
  } else if (e.key === 'y' || e.key === 'Y') {
    e.preventDefault();
    send({ cmd: 'redo' });
  }
});
const setBrowseBtn = document.getElementById('patchset-browse');
const setBrowserModal = document.getElementById('patchset-browser-modal');
const setBrowserSearch = document.getElementById('patchset-browser-search');
const setBrowserShowArchived = document.getElementById('patchset-browser-show-archived');
const setBrowserList = document.getElementById('patchset-browser-list');
setBrowseBtn && setBrowseBtn.addEventListener('click', () => {
  openModal(setBrowserModal);
  renderPatchsetBrowser();
  setTimeout(() => setBrowserSearch.focus(), 30);
});
setBrowserSearch && setBrowserSearch.addEventListener('input', renderPatchsetBrowser);
setBrowserShowArchived && setBrowserShowArchived.addEventListener('change', renderPatchsetBrowser);
function renderPatchsetBrowser() {
  if (!setBrowserList) return;
  const q = (setBrowserSearch.value || '').trim().toLowerCase();
  const showArchived = setBrowserShowArchived.checked;
  setBrowserList.innerHTML = '';
  const items = currentSets
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => (showArchived || !s.archived))
    .filter(({ s }) => !q || s.name.toLowerCase().includes(q) || (s.notes || '').toLowerCase().includes(q))
    .sort((a, b) => (b.s.updatedMs || b.s.createdMs || 0) - (a.s.updatedMs || a.s.createdMs || 0));
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'preset-empty';
    empty.textContent = 'no patchsets match';
    setBrowserList.appendChild(empty);
    return;
  }
  items.forEach(({ s, i }) => {
    const row = document.createElement('div');
    row.className = 'patchset-browser-row' + (i === currentSetIdx ? ' active' : '') + (s.archived ? ' archived' : '');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div'); name.className = 'name'; name.textContent = s.name;
    const subline = document.createElement('div'); subline.className = 'subline';
    subline.textContent = formatPatchsetSubline(s);
    meta.appendChild(name);
    meta.appendChild(subline);
    const count = document.createElement('div');
    count.className = 'count';
    count.textContent = s.count + ' presets';
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.addEventListener('click', e => e.stopPropagation());
    const archBtn = document.createElement('button');
    archBtn.className = 'icon-btn';
    archBtn.title = s.archived ? 'unarchive' : 'archive';
    archBtn.innerHTML = `<i data-lucide="${s.archived ? 'archive-restore' : 'archive'}"></i>`;
    archBtn.addEventListener('click', () => {
      send({ cmd: 'set_archived', index: i, archived: !s.archived });
    });
    actions.appendChild(archBtn);
    row.appendChild(meta);
    row.appendChild(count);
    row.appendChild(actions);
    row.addEventListener('click', () => {
      send({ cmd: 'select_set', index: i });
      setBrowserModal.hidden = true;
    });
    setBrowserList.appendChild(row);
  });
  if (window.lucide) lucide.createIcons();
}
function formatPatchsetSubline(s) {
  const parts = [];
  if (s.updatedMs) parts.push('Updated ' + relTime(s.updatedMs));
  else if (s.createdMs) parts.push('Created ' + relTime(s.createdMs));
  if (s.archived) parts.push('archived');
  return parts.join(' · ');
}
function relTime(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60)        return 'just now';
  if (sec < 3600)      return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400)     return Math.floor(sec / 3600) + 'h ago';
  if (sec < 86400 * 7) return Math.floor(sec / 86400) + 'd ago';
  return new Date(ms).toLocaleDateString();
}

setPrevBtn.addEventListener('click', () => {
  if (currentSetIdx > 0) send({ cmd: 'select_set', index: currentSetIdx - 1 });
});
setNextBtn.addEventListener('click', () => {
  if (currentSetIdx < currentSets.length - 1) send({ cmd: 'select_set', index: currentSetIdx + 1 });
});

function positionMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top  = (rect.bottom + 4) + 'px';
  // Provisional left: align under anchor.
  menu.style.left = rect.left + 'px';
  // Clamp inside viewport once dimensions are known.
  const mw   = menu.offsetWidth;
  const maxL = window.innerWidth  - mw - 8;
  let left   = rect.left;
  if (left > maxL) left = Math.max(8, rect.right - mw); // align right edge to anchor
  if (left < 8)    left = 8;
  menu.style.left = left + 'px';
}
const setRenameInput = document.getElementById('patchset-rename-input');
function beginRenameSet() {
  const cur = currentSets[currentSetIdx];
  if (!cur) return;
  setStrip.hidden = true;
  setRenameInput.hidden = false;
  setRenameInput.value = cur.name;
  setRenameInput.focus();
  setRenameInput.select();
}
function finishRenameSet(commit) {
  setRenameInput.hidden = true;
  setStrip.hidden = false;
  if (!commit) return;
  const cur = currentSets[currentSetIdx];
  const newName = setRenameInput.value.trim();
  if (cur && newName && newName !== cur.name)
    send({ cmd: 'rename_set', index: currentSetIdx, name: newName });
}
setRenameInput.addEventListener('blur', () => finishRenameSet(true));
setRenameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  { e.preventDefault(); setRenameInput.blur(); }
  if (e.key === 'Escape') { finishRenameSet(false); }
});

function renderThruSources(ids) {
  const wrap = document.createElement('div');
  wrap.className = 'sources';
  (ids || []).forEach(id => {
    const s = currentSources.find(x => x.id === id);
    const chip = document.createElement('span');
    chip.className = 'src removable' + (s && s.online ? '' : ' offline');
    const iconName = (s && s.icon) || 'music';
    const label    = s ? (s.label || s.deviceName) : 'missing source';
    chip.title = 'click to disconnect from thru';
    chip.innerHTML = `<i data-lucide="${iconName}"></i><span>${escapeHtml(label)}</span>`;
    chip.addEventListener('click', e => { e.stopPropagation(); send({ cmd: 'toggle_thru_source', sourceId: id }); });
    wrap.appendChild(chip);
  });
  return wrap;
}

function renderPresetSources(ids, presetIdx) {
  const wrap = document.createElement('div');
  wrap.className = 'sources';
  (ids || []).forEach(id => {
    const s = currentSources.find(x => x.id === id);
    const chip = document.createElement('span');
    chip.className = 'src removable' + (s && s.online ? '' : ' offline');
    const iconName = (s && s.icon) || 'music';
    const label    = s ? (s.label || s.deviceName) : 'missing source';
    chip.title = 'click to disconnect from this preset';
    chip.innerHTML = `<i data-lucide="${iconName}"></i><span>${escapeHtml(label)}</span>`;
    chip.addEventListener('click', e => {
      e.stopPropagation();
      send({ cmd: 'toggle_preset_source', index: presetIdx, sourceId: id });
    });
    wrap.appendChild(chip);
  });
  return wrap;
}

function renderTagBadges(tags) {
  const wrap = document.createElement('div');
  wrap.className = 'preset-tags';
  (tags || []).forEach(t => {
    const badge = document.createElement('span');
    badge.className = 'tag-badge';
    const slash = t.indexOf('/');
    if (slash > 0) {
      badge.innerHTML = `${escapeHtml(t.substring(0, slash))}<span class="sep">·</span><span class="sub">${escapeHtml(t.substring(slash + 1))}</span>`;
    } else {
      badge.textContent = t;
    }
    wrap.appendChild(badge);
  });
  return wrap;
}
function escapeHtml(s) { return (s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// Circular volume knob — vertical drag changes value. Range 0–1.5, unity at 1.
// `onChange` fires while dragging (audio follows live), `onCommit` fires on release.
function makeVolumeKnob(initial, onChange, onCommit) {
  const MIN = 0, MAX = 1.5;
  const knob = document.createElement('div');
  knob.className = 'vol-knob';
  knob.title = 'volume';
  const ind = document.createElement('div');
  ind.className = 'vol-knob-ind';
  knob.appendChild(ind);

  let value = initial;
  const setAngle = v => {
    const t = (v - MIN) / (MAX - MIN);          // 0..1
    const ang = -135 + t * 270;                 // -135° to +135°
    knob.style.setProperty('--ang', ang + 'deg');
  };
  setAngle(value);

  let dragStartX = 0, dragStartY = 0, dragStartVal = 0;
  knob.addEventListener('pointerdown', e => {
    e.stopPropagation();
    e.preventDefault();
    knob.setPointerCapture(e.pointerId);
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartVal = value;
    knob.classList.add('dragging');
  });
  knob.addEventListener('pointermove', e => {
    if (!knob.hasPointerCapture(e.pointerId)) return;
    // up + right = louder, down + left = quieter.
    const dy = dragStartY - e.clientY;
    const dx = e.clientX - dragStartX;
    const range = MAX - MIN;
    const next = Math.max(MIN, Math.min(MAX, dragStartVal + ((dy + dx) / 150) * range));
    if (Math.abs(next - value) < 0.001) return;
    value = next;
    setAngle(value);
    onChange(value);
  });
  const endDrag = (e) => {
    knob.releasePointerCapture(e.pointerId);
    knob.classList.remove('dragging');
    if (onCommit) onCommit(value);
  };
  knob.addEventListener('pointerup',     endDrag);
  knob.addEventListener('pointercancel', endDrag);
  // Double click → reset to unity (commit immediately).
  knob.addEventListener('dblclick', e => {
    e.stopPropagation();
    value = 1; setAngle(value);
    onChange(value);
    if (onCommit) onCommit(value);
  });
  knob.addEventListener('click',    e => e.stopPropagation());
  return knob;
}
function routingSummaryText(inputs, mask) {
  const chans = [];
  for (let ch = 1; ch <= 16; ch++) if (mask & (1 << (ch - 1))) chans.push(ch);
  const parts = [];
  if (chans.length) parts.push('ch ' + chans.join(','));
  if (inputs && inputs.length) parts.push(inputs.length + (inputs.length === 1 ? ' in' : ' ins'));
  return parts.join(' · ');
}

let lastPresetSignature = '';
function presetSignature(presets) {
  const thruSig = ((pendingState && pendingState.thruSourceIds) || []).join(',');
  return (presets || []).map(p =>
    p.name + '|' + (p.pluginPath || '')
    + '|' + (p.tags || []).join(',')
    + '|' + (p.sourceIds || []).join(',')
    + '|p=' + (p.pinned ? '1' : '0')
    + '|l=' + (p.loaded ? '1' : '0')
    + '|fx=' + (p.fx || []).map(f => f.name + (f.bypass ? '~' : '') + (f.loaded ? '*' : '')).join(',')
    + '|loading=' + (currentLoadingIds.has(p.id) ? '1' : '0')).join('\n')
    + '||def=' + ((pendingState && pendingState.defaultSourceId) || '')
    + '||thru=' + thruSig;
}
function updatePresetRowStates(bypass, currentIndex, loading) {
  const rows = presetListEl.querySelectorAll('.preset-row');
  const presets = currentPresetsCache;
  rows.forEach((row, i) => {
    if (i === 0) {
      row.classList.toggle('active', !!bypass);
      return;
    }
    const presetIdx = i - 1;
    const p         = presets[presetIdx] || {};
    const isActive  = !bypass && presetIdx === currentIndex;
    const isLoading = currentLoadingIds.has(p.id);
    row.classList.toggle('active',  isActive);
    row.classList.toggle('loading', isLoading);
    const pluginLbl = row.querySelector('.plugin');
    if (pluginLbl && isLoading) pluginLbl.innerHTML = '<span class="spinner"></span> loading…';
    const saveBtn = row.querySelector('button[data-role="save"]');
    if (saveBtn) {
      saveBtn.disabled = !isActive || isLoading;
      saveBtn.style.opacity = saveBtn.disabled ? '0.3' : '';
    }
  });
}
function renderPresets(presets, bypass = false, currentIndex = -1, loading = false) {
  currentPresetsCache = presets || [];
  activePresetIndex = bypass ? -1 : currentIndex;
  // Re-render sources so they reflect the new active preset's connections.
  setTimeout(() => renderSources(currentSources), 0);
  const sig = presetSignature(presets) + '||loading=' + (loading ? '1' : '0');
  if (sig === lastPresetSignature && presetListEl.childElementCount > 0) {
    updatePresetRowStates(bypass, currentIndex, loading);
    return;
  }
  lastPresetSignature = sig;
  presetListEl.innerHTML = '';

  // Fixed "thru" preset at the top: MIDI in -> MIDI out, no plugin.
  const thru = document.createElement('div');
  thru.className = 'preset-row thru' + (bypass ? ' active' : '');
  thru.addEventListener('click', () => send({ cmd: 'set_bypass', on: true }));
  const tnum = document.createElement('div'); tnum.className = 'num'; tnum.textContent = '00';
  const tmeta = document.createElement('div'); tmeta.className = 'meta';
  const tname = document.createElement('div'); tname.className = 'name'; tname.textContent = 'MIDI thru';
  const thruIds = (pendingState && pendingState.thruSourceIds) || [];
  tmeta.appendChild(tname);
  if (thruIds.length) tmeta.appendChild(renderThruSources(thruIds));
  const tactions = document.createElement('div'); tactions.className = 'actions';
  tactions.addEventListener('click', e => e.stopPropagation());
  // Same drag-drop behaviour as preset rows.
  thru.addEventListener('dragover', e => {
    if (![...e.dataTransfer.types].includes('application/x-patchwork-source')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
    thru.classList.add('drop-target');
  });
  thru.addEventListener('dragleave', () => thru.classList.remove('drop-target'));
  thru.addEventListener('drop', e => {
    const sid = e.dataTransfer.getData('application/x-patchwork-source');
    thru.classList.remove('drop-target');
    if (!sid) return;
    e.preventDefault();
    if (!thruIds.includes(sid))
      send({ cmd: 'toggle_thru_source', sourceId: sid });
  });
  const thruLed = document.createElement('span');
  thruLed.className = 'preset-led midi-led';
  thruLed.dataset.presetId = '__thru__';
  thru.appendChild(thruLed);
  thru.appendChild(tnum); thru.appendChild(tmeta); thru.appendChild(tactions);
  presetListEl.appendChild(thru);

  (presets || []).forEach((p, i) => {
    const row = document.createElement('div');
    const isActive  = !bypass && i === currentIndex;
    const isLoading = currentLoadingIds.has(p.id);
    row.className = 'preset-row' + (isActive ? ' active' : '') + (isLoading ? ' loading' : '') + (p.pinned ? ' pinned' : '');
    row.addEventListener('click', () => send({ cmd: 'load_preset', index: i }));
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      openPresetContextMenu(i, e.clientX, e.clientY);
    });
    row.addEventListener('dragover', e => {
      const types = [...e.dataTransfer.types];
      if (types.includes('application/x-patchwork-source')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        row.classList.add('drop-target');
      } else if (types.includes('application/x-patchwork-preset')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = row.getBoundingClientRect();
        const above = (e.clientY - rect.top) < rect.height / 2;
        row.classList.toggle('drop-above', above);
        row.classList.toggle('drop-below', !above);
      }
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-target', 'drop-above', 'drop-below');
    });
    row.addEventListener('drop', e => {
      const sid = e.dataTransfer.getData('application/x-patchwork-source');
      const fromStr = e.dataTransfer.getData('application/x-patchwork-preset');
      row.classList.remove('drop-target', 'drop-above', 'drop-below');
      if (sid) {
        e.preventDefault();
        const existing = new Set((currentPresetsCache[i] || {}).sourceIds || []);
        if (!existing.has(sid))
          send({ cmd: 'toggle_preset_source', index: i, sourceId: sid });
      } else if (fromStr !== '') {
        e.preventDefault();
        const from = parseInt(fromStr, 10);
        const rect = row.getBoundingClientRect();
        const above = (e.clientY - rect.top) < rect.height / 2;
        let to = above ? i : i + 1;
        // adjust for removing the source first
        if (from < to) to -= 1;
        if (from !== to && !isNaN(from))
          send({ cmd: 'reorder_preset', from, to });
      }
    });

    const grip = document.createElement('span');
    grip.className = 'preset-grip';
    grip.innerHTML = '<i data-lucide="grip-vertical"></i>';
    grip.draggable = true;
    grip.title = 'drag to reorder';
    grip.addEventListener('dragstart', e => {
      e.dataTransfer.setData('application/x-patchwork-preset', String(i));
      e.dataTransfer.effectAllowed = 'move';
      document.body.classList.add('dragging-preset');
    });
    grip.addEventListener('dragend', () => document.body.classList.remove('dragging-preset'));
    grip.addEventListener('click', e => e.stopPropagation());

    const num = document.createElement('div');
    num.className = 'num';
    num.textContent = String(i + 1).padStart(2, '0');
    const led = document.createElement('span');
    led.className = 'preset-led midi-led';
    led.dataset.presetId = p.id || '';
    row.appendChild(led);
    const vu = document.createElement('div');
    vu.className = 'preset-vu';
    vu.dataset.presetId = p.id || '';
    vu.innerHTML = '<div class="bar"></div>';
    row.appendChild(vu);
    row.appendChild(grip);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const nameField = document.createElement('div');
    nameField.className = 'name';
    nameField.spellcheck = false;
    const nameText = document.createElement('span');
    nameText.className = 'name-text';
    nameText.textContent = p.name || '(untitled)';
    nameField.appendChild(nameText);
    const startEditing = () => {
      nameText.contentEditable = 'true';
      nameText.focus();
      const range = document.createRange();
      range.selectNodeContents(nameText);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    // Click on the literal name text: defer load by ~220ms so a double-click
    // can cancel it and open rename instead. Clicks anywhere else on the row
    // load instantly.
    let nameClickTimer = null;
    nameText.addEventListener('click', e => {
      if (nameText.isContentEditable) { e.stopPropagation(); return; }
      e.stopPropagation();
      clearTimeout(nameClickTimer);
      nameClickTimer = setTimeout(() => send({ cmd: 'load_preset', index: i }), 220);
    });
    nameText.addEventListener('dblclick', e => {
      e.stopPropagation();
      clearTimeout(nameClickTimer);
      startEditing();
    });
    nameText.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); nameText.blur(); }
      if (e.key === 'Escape') { nameText.textContent = p.name || '(untitled)'; nameText.blur(); }
    });
    nameText.addEventListener('blur', () => {
      nameText.contentEditable = 'false';
      const newName = nameText.textContent.trim();
      if (newName && newName !== p.name) send({ cmd: 'rename_preset', index: i, name: newName });
    });
    const pluginLbl = document.createElement('div');
    pluginLbl.className = 'plugin';
    if (isLoading) {
      pluginLbl.innerHTML = '<span class="spinner"></span> loading…';
    } else {
      pluginLbl.textContent = (p.pluginPath || '').split(/[\\/]/).pop().replace(/\.vst3$/i, '') || '—';
    }
    meta.appendChild(nameField);
    meta.appendChild(pluginLbl);
    if ((p.tags || []).length) meta.appendChild(renderTagBadges(p.tags));
    if ((p.sourceIds || []).length) meta.appendChild(renderPresetSources(p.sourceIds, i));
    meta.appendChild(renderFxStrip(p.fx || [], i));

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.addEventListener('click', e => e.stopPropagation());

    const volKnob = makeVolumeKnob(
      p.volume == null ? 1 : p.volume,
      val => send({ cmd: 'set_preset_volume_live', index: i, volume: val }), // live audio
      val => send({ cmd: 'set_preset_volume',      index: i, volume: val }), // save on release
    );

    const saveBtn = document.createElement('button');
    saveBtn.className = 'icon-btn';
    saveBtn.dataset.role = 'save';
    saveBtn.title = 'save current state into this preset';
    saveBtn.innerHTML = '<i data-lucide="save"></i>';
    saveBtn.disabled = !isActive || isLoading;
    if (saveBtn.disabled) saveBtn.style.opacity = '0.3';
    saveBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (saveBtn.disabled) return;
      send({ cmd: 'update_preset_state', index: i });
      saveBtn.classList.add('saved');
      saveBtn.innerHTML = '<i data-lucide="check"></i>';
      if (window.lucide) lucide.createIcons();
      setTimeout(() => {
        saveBtn.classList.remove('saved');
        saveBtn.innerHTML = '<i data-lucide="save"></i>';
        if (window.lucide) lucide.createIcons();
      }, 1500);
    });

    const uiBtn = document.createElement('button');
    uiBtn.className = 'icon-btn';
    uiBtn.title = 'open plugin UI';
    uiBtn.innerHTML = '<i data-lucide="keyboard-music"></i>';
    uiBtn.addEventListener('click', () => send({ cmd: 'load_preset', index: i, showEditor: true }));

    actions.appendChild(volKnob);
    actions.appendChild(saveBtn);
    actions.appendChild(uiBtn);

    row.appendChild(num);
    row.appendChild(meta);
    row.appendChild(actions);
    presetListEl.appendChild(row);
  });

  const ghostWrap = document.getElementById('preset-ghost-wrap');
  ghostWrap.innerHTML = '';
  const ghost = document.createElement('div');
  ghost.className = 'preset-row ghost';
  ghost.innerHTML = '<div class="num">+</div><div class="meta"><div class="name">add preset</div><div class="plugin">pick a plugin from the library…</div></div><div class="actions"></div>';
  ghost.addEventListener('click', () => { pickingMode = 'new-preset'; openLibrary(); });
  ghostWrap.appendChild(ghost);

  if (window.lucide) lucide.createIcons();

  if (focusNewPreset) {
    focusNewPreset = false;
    const rows = presetListEl.querySelectorAll('.preset-row:not(.ghost):not(.thru)');
    const last = rows[rows.length - 1];
    const nm = last && last.querySelector('.name');
    if (nm) {
      nm.contentEditable = 'true';
      nm.focus();
      const range = document.createRange();
      range.selectNodeContents(nm);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
}

/* effect chain per preset: chips in series after the instrument */
function renderFxStrip(fx, presetIndex) {
  const strip = document.createElement('div');
  strip.className = 'fx-strip';
  strip.addEventListener('click', e => e.stopPropagation());
  fx.forEach((f, fi) => {
    const chip = document.createElement('span');
    chip.className = 'fx-chip' + (f.bypass ? ' bypassed' : '') + (f.loaded ? '' : ' offline');
    chip.title = (f.loaded ? 'open editor' : 'not loaded') + ' — ' + f.path + '\ndrag to reorder';
    // Drag a chip onto another to change the order of the chain.
    chip.draggable = true;
    chip.addEventListener('dragstart', e => {
      e.dataTransfer.setData('application/x-patchwork-fx', presetIndex + ':' + fi);
      e.dataTransfer.effectAllowed = 'move';
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
    chip.addEventListener('dragover', e => {
      if (![...e.dataTransfer.types].includes('application/x-patchwork-fx')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      chip.classList.add('drop-here');
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('drop-here'));
    chip.addEventListener('drop', e => {
      chip.classList.remove('drop-here');
      const data = e.dataTransfer.getData('application/x-patchwork-fx');
      if (!data) return;
      e.preventDefault(); e.stopPropagation();
      const [pi, from] = data.split(':').map(Number);
      if (pi !== presetIndex || from === fi) return;
      send({ cmd: 'move_fx', index: presetIndex, from, to: fi });
    });
    const pw = document.createElement('button');
    pw.className = 'fx-power';
    pw.title = f.bypass ? 'bypassed — click to enable' : 'active — click to bypass';
    pw.innerHTML = '<i data-lucide="power"></i>';
    pw.addEventListener('click', e => { e.stopPropagation(); send({ cmd: 'set_fx_bypass', index: presetIndex, fxIndex: fi, on: !f.bypass }); });
    const nm = document.createElement('span');
    nm.className = 'fx-name';
    nm.textContent = f.name || '?';
    nm.addEventListener('click', e => { e.stopPropagation(); send({ cmd: 'show_fx_editor', index: presetIndex, fxIndex: fi }); });
    const rm = document.createElement('button');
    rm.className = 'fx-remove';
    rm.title = 'remove';
    rm.innerHTML = '<i data-lucide="x"></i>';
    rm.addEventListener('click', e => { e.stopPropagation(); send({ cmd: 'remove_fx', index: presetIndex, fxIndex: fi }); });
    chip.appendChild(pw); chip.appendChild(nm); chip.appendChild(rm);
    strip.appendChild(chip);
    if (fi < fx.length - 1) {
      const arrow = document.createElement('span');
      arrow.className = 'fx-arrow';
      arrow.textContent = '›';
      strip.appendChild(arrow);
    }
  });
  const add = document.createElement('button');
  add.className = 'fx-add';
  add.title = 'add effect after the instrument';
  add.innerHTML = '<i data-lucide="plus"></i><span>fx</span>';
  add.addEventListener('click', e => { e.stopPropagation(); openFxPicker(presetIndex); });
  strip.appendChild(add);
  return strip;
}

/* effect picker: every VST3 the engine finds on the system */
const fxModal  = document.getElementById('fx-modal');
const fxListEl = document.getElementById('fx-list');
const fxSearch = document.getElementById('fx-search');
let vst3Plugins = null;
let fxPickerPreset = -1;
function openFxPicker(presetIndex) {
  fxPickerPreset = presetIndex;
  fxSearch.value = '';
  openModal(fxModal);
  if (!vst3Plugins) {
    fxListEl.innerHTML = '<div class="empty">scanning…</div>';
    send({ cmd: 'list_vst3_plugins' });
  } else {
    renderFxPicker();
  }
  setTimeout(() => fxSearch.focus(), 30);
}
function renderFxPicker() {
  const q = fxSearch.value.trim().toLowerCase();
  const items = (vst3Plugins || []).filter(p => !q || (p.name + ' ' + (p.vendor || '')).toLowerCase().includes(q));
  fxListEl.innerHTML = '';
  if (!items.length) {
    fxListEl.innerHTML = '<div class="empty">' + (vst3Plugins && vst3Plugins.length ? 'no match' : 'no vst3 plugins found in Common Files\\VST3') + '</div>';
    return;
  }
  items.forEach(p => {
    const row = document.createElement('button');
    row.className = 'fx-pick';
    row.innerHTML = `<span class="fx-pick-name">${escapeHtml(p.name)}</span><span class="fx-pick-vendor">${escapeHtml(p.vendor || '')}</span>`;
    row.addEventListener('click', () => {
      if (fxPickerPreset >= 0) send({ cmd: 'add_fx', index: fxPickerPreset, path: p.path });
      fxModal.hidden = true;
    });
    fxListEl.appendChild(row);
  });
}
fxSearch.addEventListener('input', renderFxPicker);
fxSearch.addEventListener('keydown', e => {
  if (e.key === 'Enter') { const first = fxListEl.querySelector('.fx-pick'); if (first) first.click(); }
  if (e.key === 'Escape') fxModal.hidden = true;
});

function groupPlugins(items) {
  const groups = CATEGORIES.map(c => ({ name: c.name, items: [] }));
  const other = { name: 'Other', items: [] };
  const findGroup = (name) => {
    for (let i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].match.includes(name)) return groups[i];
    }
    return other;
  };
  items.forEach(it => findGroup(it.name).items.push(it));
  return [...groups.filter(g => g.items.length), ...(other.items.length ? [other] : [])];
}

function renderLibrary(items) {
  gridEl.innerHTML = '';
  const groups = groupPlugins(items);
  groups.forEach(g => {
    const groupEl = document.createElement('div');
    groupEl.className = 'library-group';
    const h = document.createElement('h3');
    h.textContent = g.name;
    groupEl.appendChild(h);
    const tiles = document.createElement('div');
    tiles.className = 'library-tiles';
    g.items.forEach(it => {
      const tile = document.createElement('div');
      tile.className = 'library-tile';
      if (it.iconUrl) {
        const img = document.createElement('img');
        img.src = it.iconUrl;
        img.alt = '';
        img.onerror = () => { img.remove(); const fb = document.createElement('div'); fb.className = 'tile-fallback'; fb.textContent = '♪'; tile.insertBefore(fb, tile.firstChild); };
        tile.appendChild(img);
      } else {
        const fb = document.createElement('div');
        fb.className = 'tile-fallback';
        fb.textContent = '♪';
        tile.appendChild(fb);
      }
      const label = document.createElement('div');
      label.className = 'tile-name';
      label.textContent = it.name;
      tile.appendChild(label);
      tile.addEventListener('mouseenter', () => showLibraryDetail(it));
      tile.addEventListener('click', () => {
        pickingMode = null;
        send({ cmd: 'add_preset_with_plugin', name: it.name, path: it.path });
        closeLibrary();
      });
      tiles.appendChild(tile);
    });
    groupEl.appendChild(tiles);
    gridEl.appendChild(tiles.children.length ? groupEl : document.createDocumentFragment());
  });
}

function showLibraryDetail(it) {
  const el = document.getElementById('library-detail');
  if (!el) return;
  const info = ARTURIA_INFO[it.name] || {};
  const iconHtml = it.iconUrl ? `<img src="${it.iconUrl}" alt="">` : '';
  el.innerHTML = `
    ${iconHtml}
    <div class="name">${escapeHtml(it.name)}</div>
    ${info.tagline ? `<div class="tagline">${escapeHtml(info.tagline)}</div>` : ''}
    ${info.body    ? `<div class="body">${escapeHtml(info.body)}</div>`       : (info.tagline ? '' : '<div class="body" style="color:var(--text-faint)">No description on file yet.</div>')}
  `;
}

function openLibrary() {
  modalEl.hidden = false;
  if (!arturiaPlugins) {
    gridEl.innerHTML = '<div style="padding:20px; color: var(--text-faint); font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; text-align: center;">loading…</div>';
    send({ cmd: 'list_arturia_plugins' });
  } else {
    renderLibrary(arturiaPlugins);
  }
}
function closeLibrary() {
  modalEl.hidden = true;
  // if user opened the library via "add preset" but closed without picking, cancel.
  if (pickingMode === 'new-preset') pickingMode = null;
}

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    send({ cmd: 'list_midi_inputs' });
    send({ cmd: 'list_midi_outputs' });
    send({ cmd: 'get_state' });
  };

  ws.onclose = () => {
    setTimeout(connect, 2000);
  };

  ws.onerror = () => { /* onclose follows */ };

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    switch (m.event) {
      case 'midi_inputs': {
        inputListEl.innerHTML = '';
        // Merge currently-available devices with previously-enabled devices
        // (which may be offline right now). Keep offline ones visible &
        // checkable so the user doesn't lose their selection on disconnect.
        const available = new Set(m.devices || []);
        const enabled   = new Set((pendingState && pendingState.enabledDevices) || []);
        const combined  = [...new Set([...available, ...enabled])].sort();
        if (combined.length === 0) {
          const e = document.createElement('div');
          e.className = 'empty'; e.textContent = 'no midi input devices';
          inputListEl.appendChild(e);
        } else {
          combined.forEach(d => {
            const online = available.has(d);
            const lbl = document.createElement('label');
            if (!online) lbl.classList.add('offline');
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.value = d;
            cb.addEventListener('change', sendMidiInputs);
            const txt = document.createElement('span');
            txt.textContent = d + (online ? '' : '  (offline)');
            lbl.appendChild(cb); lbl.appendChild(txt);
            inputListEl.appendChild(lbl);
          });
        }
        applyPendingState();
        break;
      }
      case 'midi_outputs':
        outputSel.innerHTML = '<option value="">— off —</option>';
        kbOutSel.innerHTML  = '<option value="">— off —</option>';
        m.devices.forEach(d => {
          const a = document.createElement('option');
          a.value = d; a.textContent = d;
          outputSel.appendChild(a);
          const b = document.createElement('option');
          b.value = d; b.textContent = d;
          kbOutSel.appendChild(b);
        });
        applyPendingState();
        break;
      case 'state':
        pendingState = {
          enabledDevices: m.enabledDevices || m.midiIns || [],
          midiOut: m.midiOut, kbOut: m.kbOut, pluginPath: m.pluginPath,
          thruInputs: m.thruInputs || [], thruChannelMask: m.thruChannelMask || 0,
          thruSourceIds: m.thruSourceIds || [],
          defaultSourceId: m.defaultSourceId || '',
        };
        applyPendingState();
        if (m.loading) {
          nameEl.innerHTML = '<span class="spinner"></span> loading…';
          nameEl.classList.remove('empty');
          currentPluginName = '';
        } else {
          setPluginName(m.pluginName);
        }
        renderSources(m.sources || []);
        currentLoadingIds = new Set(m.loadingIds || []);
        renderPresets(m.presets || [], !!m.bypass, m.currentPreset ?? -1, !!m.loading);
        renderPatchsetBar(m.sets || [], m.currentSet ?? 0);
        renderPadsTarget(m.presets || []);
        if (setBrowserModal && !setBrowserModal.hidden) renderPatchsetBrowser();
        setUndoRedoState(!!m.canUndo, !!m.canRedo);
        applyTempoState(m);
        applyComposeUrl(m.composeUrl || '');
        document.getElementById('project-name').textContent = m.projectName || '';
        document.title = m.projectName ? m.projectName + ' — Patchwork' : 'Patchwork';
        break;
      case 'transport':
        applyTransport(m);
        break;
      case 'show_view':
        if (!document.getElementById('view-switch').hidden) setView(m.view === 'compose' ? 'compose' : 'rack');
        break;
      case 'compose_action':
        if (m.action === 'shellClick') { const el = document.querySelector(m.arg); if (el) el.click(); }   // dev/test helper
        else postToCompose(m.action, m.arg);
        break;
      case 'plugin_loaded':
        setPluginName(m.name);
        break;
      case 'plugin_error':
        setPluginName('');
        break;
      case 'arturia_plugins':
        arturiaPlugins = m.items;
        renderLibrary(arturiaPlugins);
        break;
      case 'vst3_plugins':
        vst3Plugins = m.items || [];
        if (!fxModal.hidden) renderFxPicker();
        break;
      case 'log':
        console.log('[engine]', m.msg);
        appendLog(m.msg);
        break;
      case 'audio_device_missing': {
        const warn = document.getElementById('audio-warning');
        warn.innerHTML = `Audio device <b>${escapeHtml(m.wanted || '?')}</b> is not available right now. Pick another one below.`;
        warn.hidden = false;
        send({ cmd: 'get_audio_state' });
        openModal(audioModal);
        break;
      }
      case 'audio_state':
        renderAudioState(m);
        break;
      case 'midi_activity':
        if (m.in)  blinkLed('midi-in-led');
        if (m.out) blinkLed('midi-out-led');
        if (m.kb)  blinkLed('kb-out-led');
        if (m.beat) pulseBeat();
        if (typeof m.effectiveBpm === 'number' && followClockOn && document.activeElement !== tempoInput) {
          tempoInput.value = String(Math.round(m.effectiveBpm));
        }
        (m.presets || []).forEach(blinkPresetLed);
        if (m.levels) applyVuLevels(m.levels);
        break;
    }
  };
}

const ledTimers = {};
function blinkLed(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('on');
  clearTimeout(ledTimers[id]);
  ledTimers[id] = setTimeout(() => el.classList.remove('on'), 90);
}
// Per-preset VU. Engine pushes raw peak amplitudes (linear). We convert to
// dBFS, take the max with the currently-displayed dB (instant attack), and
// a local rAF loop decays the bars at a fixed dB/s release rate so meters
// keep falling even when the engine has nothing else to broadcast.
//   bar 0%   = -60 dBFS  •  bar 100% = 0 dBFS
const VU_FLOOR_DB     = -60;
const VU_RELEASE_DB_S = 24;    // dB per second
const vuDb = {}; // presetId -> displayed dB
function peakToDb(p) {
  return p > 0.0000001 ? 20 * Math.log10(p) : -Infinity;
}
function applyVuLevels(levels) {
  // Instant attack only — release/decay happens in the rAF loop below.
  for (const id in levels) {
    const newDb = peakToDb(levels[id]);
    const prev  = vuDb[id] !== undefined ? vuDb[id] : VU_FLOOR_DB;
    if (newDb > prev) vuDb[id] = newDb;
  }
}
let vuLastFrameMs = 0;
function vuRenderLoop(now) {
  const dt = vuLastFrameMs ? (now - vuLastFrameMs) / 1000 : 0;
  vuLastFrameMs = now;
  const releaseStep = VU_RELEASE_DB_S * dt;
  for (const id in vuDb)
    vuDb[id] = Math.max(vuDb[id] - releaseStep, VU_FLOOR_DB);
  document.querySelectorAll('.preset-vu').forEach(el => {
    const id  = el.dataset.presetId;
    const dB  = vuDb[id] !== undefined ? vuDb[id] : VU_FLOOR_DB;
    const pct = Math.max(0, Math.min(100, ((dB - VU_FLOOR_DB) / -VU_FLOOR_DB) * 100));
    const bar = el.querySelector('.bar');
    if (bar) bar.style.height = pct.toFixed(1) + '%';
  });
  requestAnimationFrame(vuRenderLoop);
}
requestAnimationFrame(vuRenderLoop);

let beatTimer = null;
function pulseBeat() {
  if (!tempoClockIndicator) return;
  tempoClockIndicator.classList.add('beat');
  clearTimeout(beatTimer);
  beatTimer = setTimeout(() => tempoClockIndicator.classList.remove('beat'), 110);
}

const presetLedTimers = {};
function blinkPresetLed(presetId) {
  const els = document.querySelectorAll(`.preset-led[data-preset-id="${CSS.escape(presetId)}"]`);
  els.forEach(el => {
    el.classList.add('on');
    clearTimeout(presetLedTimers[presetId]);
    presetLedTimers[presetId] = setTimeout(() => el.classList.remove('on'), 90);
  });
}

function sendMidiInputs() {
  const names = [...inputListEl.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
  send({ cmd: 'set_enabled_devices', names });
}

const SOURCE_ICONS = ['music','piano','keyboard','keyboard-music','mic','guitar','drum','radio','headphones','gamepad-2','sliders','layout-grid','laptop','cable','audio-waveform','square-activity'];
let currentSources = [];
let currentLoadingIds = new Set();
let currentEnabledDevices = [];
let activePresetIndex = -1;
let currentDefaultSourceId = '';

function renderSources(sources) {
  currentSources = sources || [];
  currentDefaultSourceId = (pendingState && pendingState.defaultSourceId) || '';
  if (sourceModal && !sourceModal.hidden) refreshDefaultBtn();
  sourcesListEl.innerHTML = '';

  // If we just added a source via the + button, open its editor.
  if (knownSourceIdsBeforeAdd) {
    const newOne = currentSources.find(s => !knownSourceIdsBeforeAdd.has(s.id));
    knownSourceIdsBeforeAdd = null;
    if (newOne) setTimeout(() => openSourceEditor(newOne.id, /*fromAdd*/ true), 30);
  }
  if (currentSources.length === 0) {
    sourcesRailEl.classList.add('empty');
    return;
  }
  sourcesRailEl.classList.remove('empty');

  const linked = activePresetIndex >= 0
    ? new Set((currentPresetsCache[activePresetIndex] || {}).sourceIds || [])
    : null;

  currentSources.forEach(s => {
    const pill = document.createElement('button');
    pill.className = 'source-pill'
      + (s.online ? '' : ' offline')
      + (linked && linked.has(s.id) ? ' linked' : '')
      + (s.id === currentDefaultSourceId ? ' is-default' : '')
      + (s.isClockSource ? ' clock-master' : '');
    pill.title = s.deviceName + (s.online ? '' : ' (offline)');
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.innerHTML = `<i data-lucide="${escapeHtml(s.icon || 'music')}"></i>`;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = s.label || s.deviceName;
    pill.appendChild(icon);
    pill.appendChild(label);
    if (s.isClockSource) {
      const cf = document.createElement('span');
      cf.className = 'clock-flag';
      cf.title = 'MIDI clock master';
      cf.innerHTML = '<i data-lucide="radio"></i>';
      pill.appendChild(cf);
    }
    const chans = [];
    for (let ch = 1; ch <= 16; ch++) if ((s.channelMask || 0) & (1 << (ch - 1))) chans.push(ch);
    if (chans.length) {
      const c = document.createElement('span'); c.className = 'chan'; c.textContent = chans.join(',');
      pill.appendChild(c);
    }
    // Click → edit. Connecting happens by dragging onto a preset row.
    pill.addEventListener('click', () => openSourceEditor(s.id));

    // Drag a source onto a preset row to connect it.
    pill.draggable = true;
    pill.addEventListener('dragstart', e => {
      e.dataTransfer.setData('application/x-patchwork-source', s.id);
      e.dataTransfer.effectAllowed = 'link';
      document.body.classList.add('dragging-source');
    });
    pill.addEventListener('dragend', () => document.body.classList.remove('dragging-source'));

    sourcesListEl.appendChild(pill);
  });
  if (window.lucide) lucide.createIcons();
}

let sourceEditingId = null;
function openSourceEditor(id, fromAdd = false) {
  const s = currentSources.find(x => x.id === id);
  if (!s) return;
  sourceEditingId = id;
  sourceDeleteBtn.textContent = fromAdd ? 'Cancel' : 'Delete source';
  sourceDeleteBtn.dataset.fromAdd = fromAdd ? '1' : '';
  sourceLabelEl.value = s.label || s.deviceName;
  // device picker: enabled devices + any other already-referenced device.
  const devices = new Set(currentEnabledDevices);
  devices.add(s.deviceName);
  sourceDeviceEl.innerHTML = '';
  [...devices].forEach(d => {
    const opt = document.createElement('option');
    opt.value = d; opt.textContent = d;
    sourceDeviceEl.appendChild(opt);
  });
  sourceDeviceEl.value = s.deviceName;
  sourceDeviceEl.disabled = false;
  sourceDeleteBtn.style.display = '';
  sourceClockChk.checked = !!s.isClockSource;
  refreshDefaultBtn();

  sourceIconGrid.innerHTML = '';
  SOURCE_ICONS.forEach(name => {
    const b = document.createElement('button');
    b.dataset.icon = name;
    b.innerHTML = `<i data-lucide="${name}"></i>`;
    if (name === (s.icon || 'music')) b.classList.add('on');
    b.addEventListener('click', () => {
      sourceIconGrid.querySelectorAll('button.on').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      flushSource();
    });
    sourceIconGrid.appendChild(b);
  });

  sourceChansEl.innerHTML = '';
  for (let ch = 1; ch <= 16; ch++) {
    const b = document.createElement('button');
    b.textContent = ch;
    const bit = 1 << (ch - 1);
    if ((s.channelMask || 0) & bit) b.classList.add('on');
    b.addEventListener('click', () => {
      b.classList.toggle('on');
      flushSource();
    });
    sourceChansEl.appendChild(b);
  }
  if (window.lucide) lucide.createIcons();
  openModal(sourceModal);
}
sourceLabelEl && sourceLabelEl.addEventListener('input', () => flushSource());
sourceDeviceEl && sourceDeviceEl.addEventListener('change', () => flushSource());
function flushSource() {
  if (!sourceEditingId) return;
  let mask = 0;
  sourceChansEl.querySelectorAll('button').forEach((b, i) => { if (b.classList.contains('on')) mask |= (1 << i); });
  const iconBtn = sourceIconGrid.querySelector('button.on');
  const icon = iconBtn ? iconBtn.dataset.icon : 'music';
  send({
    cmd: 'update_source',
    id: sourceEditingId,
    label: sourceLabelEl.value,
    icon: icon || 'music',
    channelMask: mask,
    deviceName: sourceDeviceEl.value,
    isClockSource: !!sourceClockChk.checked,
  });
}
sourceClockChk && sourceClockChk.addEventListener('change', () => flushSource());
sourceDeleteBtn && sourceDeleteBtn.addEventListener('click', () => {
  if (!sourceEditingId) return;
  send({ cmd: 'delete_source', id: sourceEditingId });
  sourceModal.hidden = true;
  sourceDeleteBtn.dataset.fromAdd = '';
});

function refreshDefaultBtn() {
  if (!sourceEditingId) return;
  const isDefault = sourceEditingId === currentDefaultSourceId;
  sourceDefaultBtn.textContent = isDefault ? '★ Default (click to clear)' : 'Set as default';
  sourceDefaultBtn.classList.toggle('on', isDefault);
}
sourceDefaultBtn && sourceDefaultBtn.addEventListener('click', () => {
  if (!sourceEditingId) return;
  send({ cmd: 'set_default_source', id: sourceEditingId });
});

let knownSourceIdsBeforeAdd = null;
sourceAddBtn && sourceAddBtn.addEventListener('click', () => {
  if (currentEnabledDevices.length === 0) {
    appendLog('[ui] no enabled devices — open MIDI settings and tick at least one device first');
    openModal(midiModal);
    return;
  }
  knownSourceIdsBeforeAdd = new Set(currentSources.map(s => s.id));
  send({
    cmd: 'create_source',
    deviceName: currentEnabledDevices[0],
    label: currentEnabledDevices[0],
    icon: 'music',
    channelMask: 0,
  });
});
outputSel.addEventListener('change', () => send({ cmd: 'select_midi_output', name: outputSel.value }));
modalCloseBtn.addEventListener('click', closeLibrary);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!modalEl.hidden) closeLibrary();
  else if (!midiModal.hidden) midiModal.hidden = true;
  else if (!tagModal.hidden) tagModal.hidden = true;
  else closeAllMenus();
});

kbOutSel.addEventListener('change', () => send({ cmd: 'select_kb_output', name: kbOutSel.value }));

const KB_OCTAVES   = 2;
const KB_WHITE_W   = 28;
const KB_BLACK_W   = 18;
const KB_WHITE_H   = 90;
const KB_BLACK_H   = 56;
const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11]; // semitone offsets within octave
const BLACK_AFTER   = [0, 1, 3, 4, 5];        // black after which white index
const NOTE_NAMES   = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
let kbBaseOctave   = 3;
const kbActive     = new Set();

function noteName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

function renderKeyboard() {
  kbContainer.innerHTML = '';
  const totalWhites = KB_OCTAVES * 7 + 1;
  kbContainer.style.width  = (totalWhites * KB_WHITE_W) + 'px';
  kbContainer.style.height = KB_WHITE_H + 'px';
  const baseMidi = (kbBaseOctave + 1) * 12; // C of base octave
  kbOctLabel.textContent = 'C' + kbBaseOctave;

  for (let o = 0; o < KB_OCTAVES; o++) {
    WHITE_OFFSETS.forEach((semi, i) => {
      const midi = baseMidi + o * 12 + semi;
      const x = (o * 7 + i) * KB_WHITE_W;
      const el = document.createElement('div');
      el.className = 'kb-white';
      el.style.left = x + 'px';
      el.style.width = KB_WHITE_W + 'px';
      el.dataset.midi = midi;
      if (semi === 0) {
        const lbl = document.createElement('span');
        lbl.className = 'kb-note-label';
        lbl.textContent = 'C' + (kbBaseOctave + o);
        el.appendChild(lbl);
      }
      kbContainer.appendChild(el);
    });
    BLACK_AFTER.forEach((wi, idx) => {
      const semi = [1, 3, 6, 8, 10][idx];
      const midi = baseMidi + o * 12 + semi;
      const x = (o * 7 + wi + 1) * KB_WHITE_W - KB_BLACK_W / 2;
      const el = document.createElement('div');
      el.className = 'kb-black';
      el.style.left = x + 'px';
      el.dataset.midi = midi;
      kbContainer.appendChild(el);
    });
  }
  // top C
  {
    const midi = baseMidi + KB_OCTAVES * 12;
    const x = KB_OCTAVES * 7 * KB_WHITE_W;
    const el = document.createElement('div');
    el.className = 'kb-white';
    el.style.left = x + 'px';
    el.dataset.midi = midi;
    const lbl = document.createElement('span');
    lbl.className = 'kb-note-label';
    lbl.textContent = 'C' + (kbBaseOctave + KB_OCTAVES);
    el.appendChild(lbl);
    kbContainer.appendChild(el);
  }
}

function noteOn(el) {
  const midi = +el.dataset.midi;
  if (kbActive.has(midi)) return;
  kbActive.add(midi);
  el.classList.add('active');
  send({ cmd: 'kb_note', note: midi, vel: 100, on: true });
}
function noteOff(midi) {
  if (!kbActive.has(midi)) return;
  kbActive.delete(midi);
  kbContainer.querySelectorAll('.active').forEach(e => {
    if (+e.dataset.midi === midi) e.classList.remove('active');
  });
  send({ cmd: 'kb_note', note: midi, vel: 0, on: false });
}
function noteOffAll() {
  [...kbActive].forEach(noteOff);
}

kbContainer.addEventListener('pointerdown', e => {
  const el = e.target.closest('.kb-white, .kb-black');
  if (!el) return;
  el.setPointerCapture(e.pointerId);
  noteOn(el);
});
kbContainer.addEventListener('pointerup', e => {
  const el = e.target.closest('.kb-white, .kb-black');
  if (!el) return;
  noteOff(+el.dataset.midi);
});
kbContainer.addEventListener('pointerleave', noteOffAll);
kbContainer.addEventListener('pointercancel', noteOffAll);

kbOctDownBtn.addEventListener('click', () => { if (kbBaseOctave > 0) { noteOffAll(); kbBaseOctave--; renderKeyboard(); } });
kbOctUpBtn  .addEventListener('click', () => { if (kbBaseOctave < 8) { noteOffAll(); kbBaseOctave++; renderKeyboard(); } });

renderKeyboard();

const MAX_LOG_LINES = 500;
function appendLog(msg) {
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8);
  const line = document.createElement('div');
  line.className = 'log-line';
  const tsEl = document.createElement('span');
  tsEl.className = 'ts';
  tsEl.textContent = ts;
  line.appendChild(tsEl);
  line.appendChild(document.createTextNode(msg));
  logBodyEl.appendChild(line);
  while (logBodyEl.childElementCount > MAX_LOG_LINES) logBodyEl.removeChild(logBodyEl.firstChild);
  logBodyEl.scrollTop = logBodyEl.scrollHeight;
}
logClearBtn.addEventListener('click', () => { logBodyEl.innerHTML = ''; });

// Window drag + maximise are handled by the native title bar now.

document.getElementById('panic-btn').addEventListener('click', () => send({ cmd: 'panic' }));

const tempoWidget = document.getElementById('tempo-widget');
const tempoInput  = document.getElementById('tempo-input');
const tempoClockIndicator = document.getElementById('tempo-clock-indicator');
const tempoTsBtn = document.getElementById('tempo-ts');
const TIME_SIGS = [
  [2,4], [3,4], [4,4], [5,4], [6,4], [7,4],
  [3,8], [5,8], [6,8], [7,8], [9,8], [12,8],
];
tempoTsBtn && tempoTsBtn.addEventListener('click', e => {
  e.stopPropagation();
  const rect = tempoTsBtn.getBoundingClientRect();
  openContextMenu(
    TIME_SIGS.map(([n, d]) => ({
      label: `${n}/${d}`,
      action: () => send({ cmd: 'set_time_signature', num: n, den: d }),
    })),
    rect.left,
    rect.top - 8 - TIME_SIGS.length * 30,
  );
});
let followClockOn = true;
tempoClockIndicator.addEventListener('click', () => {
  followClockOn = !followClockOn;
  send({ cmd: 'set_follow_clock', on: followClockOn });
});
tempoInput.addEventListener('change', () => send({ cmd: 'set_bpm', bpm: parseFloat(tempoInput.value) || 120 }));
tempoInput.addEventListener('wheel', e => {
  e.preventDefault();
  const step = e.shiftKey ? 0.1 : 1;
  const next = Math.max(20, Math.min(999, (parseFloat(tempoInput.value) || 120) + (e.deltaY < 0 ? step : -step)));
  tempoInput.value = next.toFixed(1).replace(/\.0$/, '');
  send({ cmd: 'set_bpm', bpm: next });
}, { passive: false });
function applyTempoState(m) {
  if (!tempoWidget) return;
  const follow = m.followMidiClock !== false;
  followClockOn = follow;
  if (document.activeElement !== tempoInput) {
    const shown = (m.clockActive && follow) ? m.effectiveBpm : m.bpm;
    tempoInput.value = String(Math.round(shown));
  }
  tempoWidget.classList.toggle('clock-present', !!m.clockActive);
  tempoWidget.classList.toggle('clock-locked',  !!m.clockActive && follow);
  if (tempoTsBtn && m.tsNumerator && m.tsDenominator)
    tempoTsBtn.textContent = m.tsNumerator + '/' + m.tsDenominator;
}

/* Window controls (min/max/close) + window drag live in the native title bar. */

/* dropdown menus */
function closeAllMenus() {
  document.querySelectorAll('.dropdown-menu').forEach(m => m.hidden = true);
  document.querySelectorAll('.menu-trigger.open').forEach(t => t.classList.remove('open'));
}
function refreshViewMenuChecks() {
  document.querySelectorAll('#menu-view .menu-toggle').forEach(item => {
    const section = item.dataset.section;
    const visible = !document.body.classList.contains('hide-' + section);
    item.classList.toggle('checked', visible);
    const state = item.querySelector('.menu-state');
    if (state) state.textContent = visible ? 'on' : 'off';
  });
}
document.querySelectorAll('.menu-trigger').forEach(trigger => {
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const targetId = 'menu-' + trigger.dataset.menu;
    const target = document.getElementById(targetId);
    const wasOpen = !target.hidden;
    closeAllMenus();
    if (!wasOpen) {
      const rect = trigger.getBoundingClientRect();
      target.style.left = rect.left + 'px';
      target.style.top  = (rect.bottom + 4) + 'px';
      target.hidden = false;
      trigger.classList.add('open');
      if (targetId === 'menu-view') refreshViewMenuChecks();
    }
  });
});
document.addEventListener('click', e => {
  if (!e.target.closest('.dropdown-menu') && !e.target.closest('.menu-trigger')) closeAllMenus();
});
document.querySelectorAll('.dropdown-menu .menu-item').forEach(item => {
  item.addEventListener('click', e => {
    e.stopPropagation();
    if (item.classList.contains('menu-toggle')) {
      const section = item.dataset.section;
      document.body.classList.toggle('hide-' + section);
      refreshViewMenuChecks();
      return; // stay open
    }
    const action = item.dataset.action;
    if (action === 'audio-settings') {
      document.getElementById('audio-warning').hidden = true;
      send({ cmd: 'get_audio_state' });
      openModal(audioModal);
    }
    else if (action === 'midi-settings') openModal(midiModal);
    else if (action === 'new-from-library') { pickingMode = 'new-preset'; openLibrary(); }
    else if (action === 'new-from-file') { send({ cmd: 'open_plugin_picker' }); }
    else if (action === 'save-project')    { send({ cmd: 'project_save' }); }
    else if (action === 'save-project-as') { send({ cmd: 'project_save_as' }); }
    else if (action === 'open-project')    { send({ cmd: 'project_open' }); }
    else if (action === 'new-project')     { if (confirm('Start a new song? The current song stays in its project file only if you saved it.')) send({ cmd: 'project_new' }); }
    closeAllMenus();
  });
});

function openModal(modal) { modal.hidden = false; }

function fillSelect(sel, options, current, formatter) {
  sel.innerHTML = '';
  options.forEach(v => {
    const opt = document.createElement('option');
    opt.value = String(v);
    opt.textContent = formatter ? formatter(v) : String(v);
    sel.appendChild(opt);
  });
  if (current !== undefined && current !== null) sel.value = String(current);
}
function renderAudioState(m) {
  fillSelect(audDeviceType, m.deviceTypes || [], m.currentDeviceType);
  fillSelect(audDevice,     m.devices     || [], m.currentDevice);
  fillSelect(audSampleRate, m.sampleRates || [], m.currentSampleRate, r => Math.round(r) + ' Hz');
  fillSelect(audBufferSize, m.bufferSizes || [], m.currentBufferSize, b => b + ' samples');
}
[audDeviceType, audDevice, audSampleRate, audBufferSize].forEach(el => {
  if (!el) return;
  el.addEventListener('change', () => {
    document.getElementById('audio-warning').hidden = true;
    send({
      cmd: 'apply_audio_setup',
      deviceType: audDeviceType.value,
      device:     audDevice.value,
      sampleRate: parseFloat(audSampleRate.value) || 0,
      bufferSize: parseInt(audBufferSize.value, 10) || 0
    });
  });
});
document.querySelectorAll('[data-close-modal]').forEach(b => {
  b.addEventListener('click', () => document.getElementById(b.dataset.closeModal).hidden = true);
});
document.querySelectorAll('.modal').forEach(m => {
  const backdrop = m.querySelector('.modal-backdrop');
  if (backdrop) backdrop.addEventListener('click', () => {
    if (m.id === 'library-modal') closeLibrary();
    else m.hidden = true;
  });
});

/* routing editor (per-preset MIDI inputs + channels) */
let routingPresetIndex = -1;
function openRoutingEditor(idx) {
  routingPresetIndex = idx;
  const isThru = (idx === 'thru');
  const preset = isThru
    ? { inputs: (pendingState && pendingState.thruInputs) || [],
        channelMask: (pendingState && pendingState.thruChannelMask) || 0 }
    : currentPresetsCache[idx];
  if (!preset) return;
  const allInputs = [...inputListEl.querySelectorAll('input[type="checkbox"]')].map(cb => cb.value);
  const picked   = new Set(preset.inputs || []);
  let   mask     = preset.channelMask || 0;

  routingInputs.innerHTML = '';
  if (allInputs.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'no midi inputs open — enable some in MIDI settings first';
    routingInputs.appendChild(e);
  } else {
    allInputs.forEach(name => {
      const lbl = document.createElement('label');
      const cb  = document.createElement('input');
      cb.type   = 'checkbox';
      cb.value  = name;
      cb.checked = picked.has(name);
      cb.addEventListener('change', () => {
        if (cb.checked) picked.add(name); else picked.delete(name);
        flush();
      });
      const txt = document.createElement('span');
      txt.textContent = name;
      lbl.appendChild(cb); lbl.appendChild(txt);
      routingInputs.appendChild(lbl);
    });
  }

  routingChans.innerHTML = '';
  for (let ch = 1; ch <= 16; ch++) {
    const btn = document.createElement('button');
    btn.textContent = ch;
    const bit = 1 << (ch - 1);
    if (mask & bit) btn.classList.add('on');
    btn.addEventListener('click', () => {
      mask ^= bit;
      btn.classList.toggle('on');
      flush();
    });
    routingChans.appendChild(btn);
  }

  function flush() {
    if (isThru) {
      send({ cmd: 'set_thru_routing', inputs: [...picked], channelMask: mask });
    } else {
      send({
        cmd: 'set_preset_routing',
        index: routingPresetIndex,
        inputs: [...picked],
        channelMask: mask,
      });
    }
  }
  openModal(routingModal);
}

/* tag editor */
let tagEditorIndex = -1;
function openTagEditor(idx) {
  tagEditorIndex = idx;
  const preset = currentPresetsCache[idx];
  const existing = new Set(preset && preset.tags ? preset.tags : []);
  tagEditor.innerHTML = '';
  TAXONOMY.forEach(g => {
    const wrap = document.createElement('div');
    wrap.className = 'tag-group';
    const t = document.createElement('div');
    t.className = 'tag-group-title';
    t.textContent = g.name;
    wrap.appendChild(t);
    const chips = document.createElement('div');
    chips.className = 'tag-chips';
    const catKey = g.name;
    const catChip = document.createElement('button');
    catChip.className = 'tag-chip cat' + (existing.has(catKey) ? ' selected' : '');
    catChip.textContent = g.name;
    catChip.addEventListener('click', () => {
      if (existing.has(catKey)) existing.delete(catKey);
      else existing.add(catKey);
      catChip.classList.toggle('selected');
      flushTags();
    });
    chips.appendChild(catChip);
    g.subs.forEach(sub => {
      const key = g.name + '/' + sub;
      const chip = document.createElement('button');
      chip.className = 'tag-chip' + (existing.has(key) ? ' selected' : '');
      chip.textContent = sub;
      chip.addEventListener('click', () => {
        if (existing.has(key)) existing.delete(key);
        else existing.add(key);
        chip.classList.toggle('selected');
        flushTags();
      });
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);
    tagEditor.appendChild(wrap);
  });
  function flushTags() {
    send({ cmd: 'set_preset_tags', index: tagEditorIndex, tags: [...existing] });
  }
  openModal(tagModal);
}

/* views: Rack / Compose. The window keeps whatever size the user gave it;
   each view scrolls inside it. */
function setView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('#view-switch button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.body.classList.toggle('view-compose', name === 'compose');
  // The song's undo is always offered; the rack's follows the engine's state.
  if (name === 'compose') { undoBtn.disabled = false; redoBtn.disabled = false; }
  else setUndoRedoState(rackCanUndo, rackCanRedo);
  try { localStorage.setItem('patchwork-view', name); } catch (_) {}
}
document.querySelectorAll('#view-switch button').forEach(b => {
  b.addEventListener('click', () => setView(b.dataset.view));
  b.title = b.dataset.view === 'rack' ? 'Rack (Ctrl+1)' : 'Compose (Ctrl+2)';
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === '1' || e.key === '2')) {
    if (document.getElementById('view-switch').hidden) return;
    e.preventDefault();
    setView(e.key === '1' ? 'rack' : 'compose');
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    send({ cmd: e.shiftKey ? 'project_save_as' : 'project_save' });
  }
});
let composeUrlApplied = '';
function applyComposeUrl(url) {
  const sw = document.getElementById('view-switch');
  const frame = document.getElementById('compose-frame');
  if (!url) {
    sw.hidden = true;
    if (document.body.classList.contains('view-compose')) setView('rack');
    return;
  }
  sw.hidden = false;
  if (url !== composeUrlApplied) {
    composeUrlApplied = url;
    frame.src = url + (url.includes('?') ? '&' : '?') + 'embed=1';
    let want = 'rack';
    try { want = localStorage.getItem('patchwork-view') || 'rack'; } catch (_) {}
    setView(want);
  }
}

/* compose frame bridge: the frame is cross-origin (its own local server), so
   the title-bar tools talk to it over postMessage and it reports back. */
const composeFrame = document.getElementById('compose-frame');
const padsTargetSel = document.getElementById('pads-target');
let padsTargetId = '';
function postToCompose(action, arg) {
  try { composeFrame.contentWindow.postMessage({ type: 'patchwork', action, arg }, '*'); } catch (_) {}
}
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.type !== 'compose') return;
  switch (m.event) {
    case 'ready':
      postToCompose('query');
      break;
    case 'sections':
      document.querySelectorAll('#compose-tools .ctool').forEach(b => {
        b.classList.toggle('active', !!(m.active && m.active[b.dataset.section]));
      });
      break;
    case 'padTarget':
      padsTargetId = m.id || '';
      if ([...padsTargetSel.options].some(o => o.value === padsTargetId)) padsTargetSel.value = padsTargetId;
      break;
    case 'switchView':
      setView(m.view === 'compose' ? 'compose' : 'rack');
      break;
    case 'save':
      send({ cmd: m.as ? 'project_save_as' : 'project_save' });
      break;
    case 'rec':
      trRec.classList.toggle('armed',  !!m.armed);
      trRec.classList.toggle('active', !!m.active);
      trRecBeat.textContent = m.beat || '';
      break;
  }
});
document.querySelectorAll('#compose-tools .ctool').forEach(b => {
  b.addEventListener('mousedown', e => e.preventDefault());   // keep focus where it is
  b.addEventListener('click', () => postToCompose('toggleSection', b.dataset.section));
});
padsTargetSel.addEventListener('change', () => postToCompose('setPadTarget', padsTargetSel.value));
function renderPadsTarget(presets) {
  const opts = ['<option value="">— rack routing —</option>']
    .concat(presets.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`));
  padsTargetSel.innerHTML = opts.join('');
  padsTargetSel.value = presets.some(p => p.id === padsTargetId) ? padsTargetId : '';
}

/* engine transport (status bar) */
const trPlay = document.getElementById('tr-play');
const trStop = document.getElementById('tr-stop');
const trPos  = document.getElementById('tr-pos');
const trLoop = document.getElementById('tr-loop');
const trMetro = document.getElementById('tr-metro');
let metroOn = false;
function applyTransport(m) {
  const tsNum = Math.max(1, m.tsNum | 0 || 4);
  const beat  = Math.max(0, +m.beat || 0);
  const bar   = Math.floor(beat / tsNum) + 1;
  const bib   = Math.floor(beat % tsNum) + 1;
  trPos.textContent = bar + '.' + bib;
  trPlay.classList.toggle('on', !!m.playing);
  trPlay.closest('.transport').classList.toggle('playing', !!m.playing);
  trLoop.classList.toggle('on', !!m.loop);
  if (typeof m.metro === 'boolean') { metroOn = m.metro; trMetro.classList.toggle('on', metroOn); }
  if (typeof m.bpm === 'number' && m.bpm > 0 && document.activeElement !== tempoInput) {
    const shown = parseFloat(tempoInput.value);
    if (!(Math.abs(shown - m.bpm) < 0.05)) tempoInput.value = String(Math.round(m.bpm * 10) / 10);
  }
}
trPlay.addEventListener('click', () => send({ cmd: 'transport_play' }));
trStop.addEventListener('click', () => send({ cmd: 'transport_stop' }));
trMetro.addEventListener('click', () => send({ cmd: 'metronome', on: !metroOn }));
// Loop belongs to the song, so the compose frame flips it and the engine
// reports the result back through the transport event.
trLoop.addEventListener('click', () => postToCompose('toggleLoop'));
// Cursor navigation and record act on the song in the compose frame. The
// cursor-step buttons repeat while held, like the frame's own did.
document.querySelectorAll('.tr-nav').forEach(b => {
  const nav = b.dataset.nav;
  const repeats = nav === 'cursor-left' || nav === 'cursor-right';
  let holdTimer = null, repeatTimer = null, fired = false;
  const stop = () => { clearTimeout(holdTimer); clearInterval(repeatTimer); holdTimer = repeatTimer = null; };
  b.addEventListener('mousedown', e => { e.preventDefault(); });   // keep focus where it is
  b.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    fired = false;
    if (repeats) {
      holdTimer = setTimeout(() => {
        fired = true; postToCompose('nav', nav);
        repeatTimer = setInterval(() => postToCompose('nav', nav), 90);
      }, 350);
    }
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, () => {
    const wasRepeating = !!repeatTimer;
    stop();
    if (ev === 'pointerup' && !wasRepeating && !fired) postToCompose('nav', nav);
    fired = false;
  }));
});
const trRec = document.getElementById('tr-rec');
const trRecBeat = document.getElementById('tr-rec-beat');
trRec.addEventListener('mousedown', e => e.preventDefault());
trRec.addEventListener('click', () => postToCompose('toggleRec'));

window.addEventListener('load', () => {
  setTimeout(() => {
    const s = document.getElementById('splash');
    if (s) { s.classList.add('hide'); setTimeout(() => s.remove(), 400); }
  }, 700);
});

// Suppress the embedded browser's native right-click menu globally. Our own
// contextmenu handlers still fire and open custom menus where wanted.
window.addEventListener('contextmenu', e => e.preventDefault());

connect();
if (window.lucide) lucide.createIcons();
