# Chord Pad

A browser-based chord-progression composer with multi-track sequencer, piano roll, live chord analyzer and MIDI clock sync. Runs entirely in the browser — open `chord-pad.html` and you're in. No build step, no framework, no backend.

This README is a **technical tour** of how the project is built. For a user guide, look at the in-app section toggles and tooltips.

---

## Architecture at a glance

```
                            ┌─────────────────────────────────────────────┐
                            │              chord-pad.html                 │
                            │   (single-page app, all modules globals)    │
                            └────────────────────┬────────────────────────┘
                                                 │
            ┌────────────────────────────────────┼────────────────────────────────────┐
            │                                    │                                    │
   vendor/soundfont2.js                    js/audio.js                            js/midi.js
   (SF2 parser library)              (AudioContext, voices,                  (Web MIDI in/out,
                                      reverb, delay, prewarm)                 clock receive, panic)
                                                 │                                    │
                                                 └─────────────┬──────────────────────┘
                                                               │
                                                          js/seq.js
                                       (SEQ global, transport, scheduling,
                                        per-track event ledger, persistence,
                                        loop, undo, marquee, zoom, follow)
                                                               │
                                ┌──────────────────────────────┼──────────────────────────────┐
                                │                              │                              │
                          js/pads.js                    js/kbinput.js                  js/chord-pad.js
                       (chord-board builders          (visual keyboard,              (state global, chord
                        for the 4 templates)           kbActive map, MIDI            theory primitives,
                                                       keyboard shortcuts)            playChord/release,
                                                                                      modals, knobs, UI)
                                                               │
                                ┌──────────────────────────────┼──────────────────────────────┐
                                │                              │                              │
                       js/pianoroll.js                 js/chordview.js                  js/analyzer.js
                  (note editor, marquee, alt-       (lyrics-style chord cards,        (live chord
                   clone, edge ticks, velocity)      treadmill for loop wrap)          detection from
                                                                                       kbActive)
```

Everything runs in browser globals. Modules read each other's state directly — there is no module system, no DI, no event bus beyond a few `document.dispatchEvent` for MIDI port changes. Coordination is by **load order** and shared mutable objects (`state`, `SEQ`, `REC`).

---

## No build step

All JS is loaded as classic `<script>` tags from [chord-pad.html](chord-pad.html#L591-L600), in this exact order:

```
vendor/soundfont2.js   → SF2 binary parser (3rd party)
js/audio.js            → Web Audio core, voice graphs, FX, SF2 playback
js/midi.js             → Web MIDI: ports, clock parser, panic
js/seq.js              → Sequencer engine, persistence, transport
js/pads.js             → Chord-pad board builders per template
js/kbinput.js          → Visual keyboard + keyboard shortcuts + glide
js/chord-pad.js        → Main UI: state, chord theory, modals, knobs
js/pianoroll.js        → Piano-roll editor (loads AFTER seq+pads)
js/chordview.js        → Lyrics-style chord follower
js/analyzer.js         → Live chord recognition from kbActive
```

Each file uses constants and helpers defined in earlier files. `pianoroll.js` hooks into double-click handlers set up by `pads.js`; `analyzer.js` reads `kbActive` from `kbinput.js`. Late-loading modules check `typeof X === 'function'` before calling things that might not exist (defensive, but mostly belt-and-suspenders given the deterministic load order).

There's no TypeScript, no linter config in repo, no bundler. The whole project is hot-editable: save a file, refresh the browser, you see the change. The service worker is configured to bust the app cache aggressively (see PWA section below).

---

## Module map

### `vendor/soundfont2.js`
Third-party library (MIT-licensed) that parses the binary SF2 SoundFont 2 format into JavaScript objects — sample headers, instrument zones, generators. Loaded once on first use of an SF2-backed instrument.

### `js/audio.js` ([file](js/audio.js))
Owns everything that touches Web Audio. AudioContext lifecycle, the master FX chain (master gain → compressor → output), reverb (convolver with synthetic impulse), delay (with feedback loop). Two voice paths:

- `startAudioNote(midi, vel, at, autoRelease, instrumentOverride)` — the basic synth, three oscillators + filter + envelope + tremolo + vibrato + sends to reverb/delay.
- `startSf2Voice(midi, vel, at, autoRelease, sf2, presetNumber)` — sample-based playback driven by SF2 generators.

Plus the MP3 sampler fallback (`startSampleNote`) for when SF2 hasn't loaded yet, sample prewarm (`prewarmSf2Preset`), and the JIT warmup graph (`_warmupAudioGraph`).

### `js/midi.js` ([file](js/midi.js))
Web MIDI initialization, per-port handler consolidation (`attachMidiInput`), MIDI clock receive with EMA-smoothed BPM (`onMidiClockMessage` + the `_midiClock` state), panic (all-notes-off + all-sound-off on all ports/channels), and the wrappers for outgoing notes (`sendNoteOn`, `sendNoteOff`).

### `js/seq.js` ([file](js/seq.js))
The biggest module. Sequencer engine: per-track event ledger, the 25-ms scheduler tick with 150-ms lookahead (`seqTick`), latency-corrected playhead (`seqAnimatePlayhead`), cursor jump with hard-cut + MIDI all-notes-off (`seqJumpToBeat`), loop boundary management with 1-bar minimum, undo (snapshot-based, 60-entry ring), marquee selection, drag-and-drop clip mutation, zoom (left-anchored), follow-cursor (50% viewport pinning), persistence (project + UI-prefs split).

Also: `withSynth(synth, fn)` — the pattern that lets per-track synth params swap into `state.synth` around a voice-start call, so the global voice functions read the right values for the right track.

### `js/pads.js` ([file](js/pads.js))
Builds the four chord-pad board layouts (`buildMajorHarmonyBoard`, `buildMinorHarmonyBoard`, `buildScaleChordsBoard`, `buildChordLibraryBoard`). Each pad is a `.pad` DOM node with a `.pad-button` and optional extension badge; event handlers route to `playChord` / `releaseChord` in chord-pad.js. Also handles drag-and-drop of chord pads into sequencer lanes.

### `js/kbinput.js` ([file](js/kbinput.js))
The visual piano keyboard (MIDI 21–108), the `kbActive` map (`Map<midi, audioNode>` of currently-held keys), keyboard letter-key → pad-trigger shortcuts (`Q/W/E/...`), arrow-key navigation (transpose key / octave), touch-glide across pads and keys, panic shortcut (`P`), undo/redo/copy/cut/paste/duplicate/select-all keyboard shortcuts.

### `js/chord-pad.js` ([file](js/chord-pad.js))
The biggest UI module (~5000 lines). Defines the `state` global, the chord-theory primitives (`CHORD_INTERVALS`, `QUALITY_GLYPH`, `TEMPLATES`), the voicing algorithm in `chordToMidiNotes`, `playChord` / `releaseChord` with per-pad active-chords map and keyboard highlighting, the `INSTRUMENT_PRESETS` dict, the two modals (chord-pad settings and per-track FX), the rotary knob primitives (`makeCpKnob`, `makeFxKnob`), the override-flag system on ADSR/Filter knobs, track-row UI with drag-reorder, REC system for capturing chord drops during playback, the section toggle handlers + floating mini-toolbar, and a thousand small UI wirings.

### `js/pianoroll.js` ([file](js/pianoroll.js))
Piano-roll editor. Renders the grid (sizer + ruler + keyboard sidebar + notes + playhead + clip-end-line), implements four tools (select / draw / erase / pan) with appropriate cursor states, multi-note marquee with baseSel snapshot, alt-drag clone with live alt-release detection, ctrl+drag octave-snap, edge ticks pinned to viewport top/bottom showing off-screen notes' time positions.

### `js/chordview.js` ([file](js/chordview.js))
The lyrics-style horizontal chord follower. Renders multiple copies of the focused chord-track's progression as fixed-baseline cards, then "treadmills" them (drops the leftmost copy, appends a new one at the right) at each loop wrap so the cursor flows rightward forever without snap-back. Card autofit cascades inline → stacked layout → font-shrink.

### `js/analyzer.js` ([file](js/analyzer.js))
Reads `kbActive` (the held-keys map) and runs reverse-lookup against `CHORD_INTERVALS` to print the detected chord name, with bass-note hint for ranking ambiguous interpretations and dual spellings for black-key roots.

### `sw.js` ([file](sw.js))
Service worker with dual-cache: `APP_CACHE` bumps per release, `ASSET_CACHE` keeps the 148 MB SF2 across updates.

---

## Audio engine ([js/audio.js](js/audio.js))

### AudioContext lifecycle

Web Audio contexts cannot start until the user has interacted with the page. The first `getAudioCtx()` call ([audio.js:138](js/audio.js#L138)) builds the context lazily; `_audioCtxUnlocked` ([audio.js:137](js/audio.js#L137)) tracks whether any user gesture has fired. Before that, calling `.resume()` would print a console warning, so we suppress.

On first gesture (`pointerdown` / `keydown` / `touchstart`, capture-phase listener), `_unlockAudioCtxOnGesture` ([audio.js:146](js/audio.js#L146)) flips the flag, resumes the context, and runs the **JIT warmup**:

1. Silent oscillator → exercises the master compressor and reverb so their internal state is non-zero.
2. Five silent SF2/synth voices (`audioVolume = 0`) at C-major positions, spread over ~100 ms. Same code path as a real note, so V8 optimizes the hot loops while the user is still finding the Play button.

Without this, the first few seconds of playback after a refresh sound soft and glitchy until JIT catches up. The Stage-2 warmup is gated on `state` and `startAudioNote` being defined (in case audio.js's gesture handler fires before chord-pad.js has loaded).

Master out chain ([audio.js:58-85](js/audio.js#L58)): voice → master gain (0.5) → DynamicsCompressor (threshold −8 dB, ratio 6:1, fast attack) → destination. Compressor prevents stacked-voice clipping. Compressor and reverb impulse are built once per context.

### Voice graph: basic synth (`startAudioNote`)

For `instrument === 'synth'` and no GM mapping match:

```
osc1 (user waveform)  ──┐
osc2 (2× triangle)    ──┤
osc3 (3× sine)        ──┤── mix (gain 0.42) ── biquad lowpass ── tremGain ── env ── ctx._out
optional detune-pair ───┘                                                            │
                                                                                     ├── reverbSend → ctx._reverb (convolver)
                                                                                     └── delaySend  → ctx._delay (feedback loop)

Vibrato LFO ────────────────────────────────────────────────────► osc.detune (all)
Tremolo LFO ──────────────────────────────────────────────────────► tremGain.gain
Filter LFO  ──────────────────────────────────────────────────────► filter.frequency
```

Mix gain (0.42) keeps the summed oscillators below clipping. Reverb send is a fixed 0.5; delay send is gated on `s.delayWet > 0`. ADSR is shaped on the `env` GainNode via `setValueAtTime` / `linearRampToValueAtTime` / `exponentialRampToValueAtTime`. Auto-release (when `autoRelease` is non-null) schedules the release ramp at attack+decay-time + autoRelease seconds, and stops oscillators afterward.

### Voice graph: SF2 sample playback (`startSf2Voice`)

When `INSTRUMENT_TO_SF2[instrument]` returns a preset number (0–127) and the FluidR3 SF2 is loaded ([audio.js:825](js/audio.js#L825)):

```
sample.buffer (decoded once, cached in SF2_BUFFER_CACHE)
   │
   ▼
BufferSource (playbackRate from semitone calc) ─── biquad filter ── tremGain ── env ── ctx._out
                                                                                 │
                                                                                 ├── reverbSend
                                                                                 └── delaySend

SF2 ModLFO → tremGain.gain   (always-on if generator > 0)
+ user tremolo LFO → same    (additive)

SF2 VibLFO → src.detune      (always-on if generator > 0)
+ user vibrato LFO → same    (additive)
```

Per-zone keyData lookup via the soundfont2.js library: `sf2.getKeyData(midi, velocity_layer, presetNumber)` returns generators (SF2 spec 2.04) for the matching zone. Generators read:

- **Pitch**: `OverridingRootKey`, `CoarseTune`, `FineTune`, `ScaleTuning` → semitone offset → playback rate (`Math.pow(2, semitones/12)`).
- **Filter**: `InitialFilterFc` (absolute cents → Hz) and `InitialFilterQ` (centibels → linear via `Math.pow(10, cB/200)`).
- **Envelope**: `AttackVolEnv`, `DecayVolEnv`, `SustainVolEnv`, `ReleaseVolEnv` (all timecents → seconds via `Math.pow(2, tc/1200)`).
- **Sample looping**: `SampleModes` (1 or 3 = loop). When set, `src.loop = true; src.loopStart/loopEnd` come from the sample header.
- **Native modulation**: `ModLFOToVolume` (centibels of amp mod), `VibLFOToPitch` (cents of pitch mod), with `Freq*LFO` (rate) and `Delay*LFO` (onset delay).

If `getKeyData` returns no sample for this MIDI note (zone gap), `startSf2Voice` returns `null` and the caller falls back to the MP3 sampler.

### The override flag system

ADSR (`attack`/`decay`/`sustain`/`release`) and filter (`filterFreq`/`filterQ`) sliders are **smart overrides**: if the user has never moved the slider, the SF2 generator wins. Once they touch it, their value takes over forever for that synth.

The flag lives on the synth object: `s._override = { attack: true, filterFreq: true, ... }`. In [audio.js:849](js/audio.js#L849) and [:874-884](js/audio.js#L874-L884):

```js
if (s._override?.filterFreq) {
  filterFreq = Math.min(20000, Math.max(20, s.filterFreq));
} else {
  filterFreq = absoluteCentsToHz(g(SF2G.InitialFilterFc) ?? 13500);
}
```

The flag is set in the knob handlers (`setOverride(true)` on pointerdown/wheel, `setOverride(false)` on dblclick which clears + resets to preset default). Switching instruments clears all `_override` flags.

### Reading SF2 defaults into the knobs

When the user picks an SF2 instrument, the knobs are positioned so they reflect what the soundfont actually plays internally. `readSf2Defaults(sf2, presetNumber)` ([audio.js:818-846](js/audio.js#L818)) reads the preset's `AttackVolEnv` / `DecayVolEnv` / `SustainVolEnv` / `ReleaseVolEnv` / `InitialFilterFc` / `InitialFilterQ` generators for a representative MIDI note (C4 with fallbacks), converts to the same linear units used by the preset object (seconds, Hz, 0..1), and the chord-pad and track-FX instrument-change handlers overlay these onto `state.synth` / `track.synth` after applying the generic baseline. Combined with the `_override = {}` reset on the same change, the knob positions and the audio engine agree on the starting state of the preset.

Tremolo and vibrato are different: **always additive**. The SF2 LFO runs as designed (so the Rhodes wobble survives at slider 0), and the user's slider value is added on top. This is by intent — there's no good "remove preset wobble" affordance in modern DAWs either.

### Global FX bus

Reverb is a `ConvolverNode` with a synthetic 2.5-second impulse response (white noise * `Math.exp(-3*t)`). The wet gain is updated from `state.synth.reverb` ([audio.js:415](js/audio.js#L415)) on every note start.

Delay is a `DelayNode` (max 2.0 s) with a `delayFb` feedback gain in a loop: `_delay → _delayFb → _delay`, plus a `_delayWet` send to output. The voice taps `env` (post-ADSR) and sends it into the delay. All three params update per-voice from `state.synth`.

### MP3 sampler fallback (`startSampleNote`)

Lives at [audio.js:260](js/audio.js#L260). Used when:
1. The instrument is GM-mapped but SF2 hasn't loaded yet (a `loadSf2('fluid')` is kicked off, falls through to MP3).
2. The instrument isn't in `INSTRUMENT_TO_SF2` at all and isn't `synth`.

Loads the closest MIDI note's MP3 from the gleitz/midi-js-soundfonts GitHub repo, plays at transposed playback rate. Applies ADSR + tremolo + filter LFO + reverb/delay sends so it sounds the same as SF2 voices, just with slight stretch artifacts.

### Sample prewarm

`prewarmSf2Preset(sf2, presetNumber)` ([audio.js:775](js/audio.js#L775)) eagerly decodes every sample in the preset (MIDI 21–108) into `AudioBuffer`s via `decodeAudioData`. Without this, the first note of each preset incurs a 5–50 ms decode on the audio thread → audible stutter.

To avoid UI jank, the decode is chunked: 22 samples per `setTimeout(0)` tick. 88 samples total fits in ~4 ticks (~80 ms). The cap (22) was tuned to balance perceived load time vs. UI smoothness — too low and the user can outrun the decode; too high and the first tick visibly hitches.

Cached in `SF2_BUFFER_CACHE` keyed by sample object reference, so once decoded the buffer is reused for every voice.

### `withSynth(synth, fn)` pattern

Defined in [seq.js:603](js/seq.js#L603):

```js
function withSynth(synth, fn) {
  if (!synth) return fn();
  const prev = state.synth;
  state.synth = synth;
  try { return fn(); } finally { state.synth = prev; }
}
```

All voice-start functions read `state.synth` synchronously (when scheduling), so swapping it before the call routes that voice through the per-track synth params. Used wherever a sequenced note fires:

```js
withSynth(track.synth, () => { node = startAudioNote(midi, vel, t, dur, track.instrument); });
```

This avoids passing synth-config as a parameter through every audio function, while still letting tracks have their own ADSR/filter/FX values. Tracks with `synth === null` (rare; only the legacy default chord track) fall back to the chord-pad's global `state.synth`.

### Latency compensation

The visual playhead is rewound by total audio output latency so what the user sees matches what they hear:

```js
const lat = (ctx.outputLatency ?? ctx.baseLatency ?? 0)
          + (SEQ.visualLatencyMs || 0) / 1000;
const now = ctx.currentTime - lat;
```

- `outputLatency` — Chromium browsers report the total render + buffer latency.
- `baseLatency` — Firefox fallback (usually ~0, less accurate).
- `visualLatencyMs` — manual user knob in Settings, defaults to 75 ms because most Windows audio stacks under-report by that much.

The scheduler also adds the same latency back when computing fire times for notes, so audio scheduling stays grid-locked while the visual cursor stays where the user's ears expect it.

---

## Sequencer engine ([js/seq.js](js/seq.js))

### The `SEQ` global

Holds all sequencer + transport state ([seq.js:149-183](js/seq.js#L149)):

- **Transport**: `playing`, `playStartTime` (ctx.currentTime when Play was pressed), `startBeat` (user-set cursor), `animBeat` (latency-corrected visual cursor), `LOOKAHEAD` (0.15 s scheduler horizon), `TICK_MS` (25 ms scheduler tick).
- **Loop**: `loopStart`, `loopEnd`, `loop` (bool), `animLoopLen`, `animLoopStart`.
- **Tracks**: `tracksList` (ordered array), plus transient runtime stuff (`pendingTimers` Set, `activeNodes` Set).
- **Selection**: `selection[]` (arrangement clips, array of `{trackId, item}`), `prSelection` (piano-roll notes, Set of note refs), `focusedClip`, `clipboard`.
- **Undo**: `_undoStack`, `_redoStack` (snapshot JSON strings, limit 60).
- **View prefs**: `followArr`, `followPr`, `prShowKeyboard`, `prBodyHeight`, `chordViewOpen`, `pianoRollOpen`.
- **MIDI clock**: `midiClockBpm` (last-applied), via the `_midiClock` parser state in midi.js.

### Track model (`makeTrack`)

Each track is fully independent ([seq.js:123-147](js/seq.js#L123)):

```js
{
  id, kind: 'chord' | 'free', name,
  instrument: 'synth' | 'epiano' | 'piano' | ...,
  channel: 0–15, output: 'instrument' | 'midi',
  midiPortId: '', midiInPortId: '',
  volume: 0–2, muted: false, soloed: false,
  synth: { /* per-track ADSR / filter / FX */ },
  items: [],            // chord items OR free clips

  // Playback state (reset on stop)
  pendingIdx, pendingTime, cycleStart, activeIdx,
  _scheduled: [],       // event ledger for selective cancel
  _flatNotes: null,     // free tracks only: cached flat note list
  _flatDirty: false,
}
```

**Chord items** carry the chord by reference, not by note list:
```js
{ interval, q, bassInterval, keyRoot, template, label, start, beats }
```
Notes are recomputed at schedule time via `chordToMidiNotes(keyRoot, octave, interval, q)` so transposition and voicing changes apply retroactively.

**Free clips** carry their notes baked in:
```js
{ id, start, beats, label, notes: [ { midi, label, start, beats, velocity? } ] }
```
Clip-relative starts allow the clip to be moved without touching each note.

### Scheduling

The scheduler ticks every 25 ms while playing (`setInterval(seqTick, SEQ.TICK_MS)`, [seq.js:1860](js/seq.js#L1860)). Each tick walks every track and pre-schedules any notes whose fire time falls inside `[now, now + LOOKAHEAD]`. For each scheduled note:

1. Compute audio fire time (`onDelay` from `setTimeout` for the visual update; `at` for `startAudioNote` so Web Audio handles sample-accurate timing).
2. Compute release time (`offDelay`, typically 95% of duration).
3. For MIDI output: `port.send([0x90|ch, midi, vel], timestamp)` — Web MIDI's `timestamp` argument gives sub-millisecond accuracy.
4. For audio output: `startAudioNote(midi, vel, at, autoRelease, inst)` schedules the entire envelope at the right Web Audio time.
5. Record the event in `track._scheduled` for selective cancellation.

The event ledger ([seq.js:1914-1951](js/seq.js#L1914)) stores `{ startAt, endAt, audioNodes, port, channel, midiNotes }` per scheduled event. On cursor jump or edit, `_seqCancelFuture(track, now)` walks the ledger and kills only future events: hard-stop oscillators, send +1 ms note-offs to cancel queued MIDI note-ons. This is the openDAW-inspired pattern that keeps in-flight notes playing while pending notes get cancelled cleanly.

### Cursor jump (`seqJumpToBeat`)

The user clicking a new cursor position needs a hard-cut, not a fade ([seq.js:2541](js/seq.js#L2541)):

1. Direct `oscillator.stop(ctx.currentTime)` on every active node (skip the 500 ms release envelope).
2. MIDI all-notes-off on every port any track might use (CC#123 on channels 0–15).
3. `_seqCancelFuture` for every track (selective cancel — keep ringing notes, drop pending ones).
4. Reanchor `playStartTime` to the new beat via `seqReanchorPlayStart`.
5. Resync every track via `seqLoopBaseChangedResync({ jumpInto: true })`.
6. Scroll arrangement + piano-roll viewport to bring the new position into view.

### Resync modes: strict-future vs jumpInto

`seqResyncTrack(track, opts)` has two modes for picking the next item to schedule:

- **Default — strict-future** (`t > now`). Used by every edit/drop/drag/resize. A clip dropped right on top of the playhead does NOT play in the current cycle; it waits for the next loop iteration. Touching a clip during playback never produces a mid-way attack.
- **`{ jumpInto: true }`** (`t + itemBeats × bd > now`). Used only by `seqJumpToBeat` (via `seqLoopBaseChangedResync`). Items that started before the jump beat but haven't ended yet still fire, with `onDelay` clamped to 0 — that's what makes "click into a clip and hear it" work for cursor jumps.

The default flipped during development. Previously every resync was loose (jumpInto-style), so edits during playback caused audible re-attacks at the playhead. Now playback is silent until the user clicks an explicit preview UI or jumps the cursor.

### Undo

Snapshot-based, not command-based ([seq.js:222-227](js/seq.js#L222)). Every mutation calls `seqCheckpoint()` which:

1. Serializes the entire `SEQ.tracksList` + transport state to JSON.
2. Pushes onto `_undoStack` (cap 60 entries).
3. If the new snapshot equals the top of the stack, skip (dedupe).

Undo pops, pushes current to redo, deserializes back. Selection references break across undo (item identities change), so selection is cleared after restore.

### Persistence

Two localStorage blobs ([seq.js:1252-1287](js/seq.js#L1252)):

- **`chord-pad-seq-v1`** — full project content: tracks, transport, tempo, loop, MIDI routing, visualLatencyMs. Also the JSON export/import format (`seqExportProject` / `seqImportProject`).
- **`chord-pad-ui-v1`** — UI preferences kept *separate* from project content: per-template chord keys, current template, follow-cursor toggles, arrangement/piano-roll/chord-view zoom levels, focused chord-track id. Never written to project export — importing a project doesn't clobber your local view-state.

The split exists because UI prefs are personal (what view did I leave open) while project content is the song itself. A teammate importing a `.json` project shouldn't end up zoomed where you were zoomed.

### Drag-and-drop for chord clips and free clips

The arrangement supports rich drag patterns ([seq.js:1019-1230](js/seq.js#L1019), [chord-pad.js:4481-4630](js/chord-pad.js#L4481)):

- **Simple drag** — move a single chord block within its track or to another chord track. Ghost preview, snap to grid.
- **Multi-select drag** — select N clips (marquee or shift-click), drag any one → the rest move with the same delta. Ghost-per-clip during the drag.
- **Cross-track drag** — chord track → chord track (move), or chord track → free track (convert to clip with notes baked in via `chordToMidiNotes`). Free→free across lanes too.
- **Alt-drag clone** — Alt held = clone instead of move. The originals stay put, ghosts (= clones) follow the cursor. On release, fresh clones are spawned at the drop positions with fresh ids.
- **Live Alt release** — releasing Alt mid-drag removes the clones and switches to plain move. Pressing Alt again re-clones. Uses `ev.altKey` (live state from pointermove), not `e.altKey` (frozen at pointerdown).
- **Block-stays, ghost-moves** — chord blocks AND free clips both keep their `item.start` pinned at the original position during the drag; only the ghost moves. On drop, `item.start` is committed from the ghost's snapped position. Mutating `item.start` live caused the scheduler to re-fire the clip every time the drag crossed the playhead — switching to ghost-only fixed that.

### Marquee selection

Rebuilt from a snapshot on every move ([chord-pad.js:4800-4822](js/chord-pad.js#L4800)). Without snapshotting, items would accumulate monotonically (anything that's ever touched the marquee stays selected, even if the marquee moves away). With snapshot:

```js
const baseSel = e.shiftKey ? SEQ.selection.slice() : [];
// On every onMove:
SEQ.selection = baseSel.slice();
// then add items currently inside the rect
```

Shift+marquee adds to existing selection (`baseSel` = current selection). Without shift, starts empty.

### Zoom

`seqApplyZoom(newBeatPx, anchorClientX)` and `prApplyZoom` ([seq.js:2752,2858](js/seq.js#L2752)). Both clamp the beat-per-pixel within a sane range and re-render. The anchor strategy is **leftmost-anchor** (`CURSOR_PULL = 0`): the beat that was at the left edge of the viewport before the zoom stays at the left edge after. Optional cursor pull (currently 0) would mix in cursor-anchor behaviour.

This bias is intentional. With cursor-anchor, content disappears past the viewport when zooming in and the user loses context. With leftmost-anchor, you keep seeing the left side and the rest grows out to the right.

### Follow-cursor

Two flags: `SEQ.followArr` and `SEQ.followPr`, toggled via the `locate` icon in each toolbar. When on, the playhead is pinned at 50% of the viewport during playback — the lanes scroll underneath. When the loop wraps and the cursor jumps backwards past the left edge, the viewport snaps back so the cursor is again visible. Both flags persist in `chord-pad-ui-v1`.

### Loop boundaries

`seqUpdateLoopStart` / `seqUpdateLoopEnd` ([seq.js:833,847](js/seq.js#L833)) move the handles and sync the orange loop-range bar on the ruler. Minimum loop length is one bar (`state.beatsPerBar || 4`), enforced in all loop-resize handlers — the chord view depends on this to keep its lookahead + animation timing consistent.

### MIDI in: routing + clock

`attachMidiInput()` ([midi.js:76](js/midi.js#L76)) consolidates per-port handlers. Each port gets exactly one `onmidimessage` handler that dispatches to:

1. **Clock parser** if `state.midiClockPortId === port.id` (always-attached, even when follow is off — that's how we detect "clock present").
2. **Keyboard** if `state.keyboardMidiPortId === port.id` AND no track has claimed it (otherwise the same note would sound twice).
3. **Per-track input** for every track with `midiInPortId === port.id`, gated on the channel.

MIDI clock parsing ([midi.js:135](js/midi.js#L135)): receives 24 ppq F8 ticks, maintains a rolling 24-sample window of inter-tick intervals, EMA-smooths the BPM. Updates `state.tempo` only when `state.midiClockEnabled` is true (otherwise just keeps the activity flag alive). The `_midiClock.beatListeners` array fires callbacks on every 24th tick (one quarter note) — used for the clock-indicator's beat flash.

`midiClockIsActive()` returns true if the last F8 was within the last 1 s (watchdog). When the source stops, the indicator drops back to its dimmed "no clock" state.

---

## Chord theory and UI ([js/chord-pad.js](js/chord-pad.js), [js/pads.js](js/pads.js))

### `state` global

Single top-level mutable object. Held parts:

- `currentTemplate` — which of the four chord-pad tabs is active.
- `keys` — pitch-class root per template (`{ 'major-harmony': 0, 'minor-harmony': 9, ... }`). Persisted in UI-prefs.
- `scaleType`, `octave`, `voicing`, `sustain`, `bassEnabled`, `bassOctave`, `playStyle`.
- `tempo`, `beatsPerBar`, `velocity`, `padOutput`, `padChannel`, `padMidiPortId`.
- `audioEnabled`, `audioVolume`, `volumeBalance`.
- `instrument` — current chord-pad voice instrument.
- `synth` — the chord-pad voice's synth dict (ADSR, filter, FX). Mirrored across tracks via `track.synth`.
- `activeChords` — `Map<padId, {notes, label, audioNodes, bassNote, bassAudioNode, kbHighlight}>` — live playback state for held chord pads.
- `midiAccess`, `midiClockEnabled`, etc.

### Chord theory primitives

- **`CHORD_INTERVALS`** ([chord-pad.js:66](js/chord-pad.js#L66)) — semitone offsets per quality. `maj7 → [0,4,7,11]`, `m7b5 → [0,3,6,10]`, etc. 41+ entries.
- **`QUALITY_GLYPH`** ([chord-pad.js:131](js/chord-pad.js#L131)) — display string per quality. `maj → ''`, `min → 'm'`, `dom7 → '7'`, `m7b5 → 'ø'` (a single Unicode glyph that we further render as an SVG superscript in some contexts).
- **`chordRootName(keyRoot, interval)`** — returns the spelled root (e.g. `'A♭'`) given the key context. Knows when to use sharps vs flats.
- **`chordDisplayName(keyRoot, interval, q)`** — root + suffix glyph as a plain string.
- **`qualityToHTML(glyph)`** — wraps the °/ø/+ symbols in SVG `<svg>` elements so they render as clean circle/slash/cross icons at any font size.
- **`formatChordRoot(name)`** — wraps ♭/♯ in `<span class="acc">` for fine-grained styling.

### Voicing algorithm (`chordToMidiNotes`)

Given a key root + octave + interval + quality, returns a MIDI note array ([chord-pad.js:453](js/chord-pad.js#L453)). Seven modes:

- **`auto`** — try every inversion across ±1 octave; pick the one whose average pitch is closest to the key's center octave. The "stay close to home" heuristic.
- **`auto1`** / **`auto2`** — auto with a 6-semitone bias toward inversion index 1 or 2. Lets the user say "I prefer first-inversion chords" without locking it to that — if the inversion is too far from home, auto still kicks in.
- **`high`** / **`low`** — shift the target center ±7 semitones to bias toward higher/lower voicings.
- **`spread`** — same as auto but applies drop-2 voicing (lowers the second-from-top note an octave) for open voicings.
- **`root`** — straight root-position, no inversion search. Always plays the chord with the chord root in the bass.

### `playChord` / `releaseChord`

[chord-pad.js:611,676](js/chord-pad.js#L611). On play:

1. If sustain is on and this pad is already active, treat as release.
2. If sustain is on and other pads are active, stop them.
3. Compute MIDI notes via `chordToMidiNotes`.
4. Route output:
   - **MIDI** — `sendNoteOn` per note on `padMidiPortId`.
   - **Instrument** — `startAudioNote` per note, or `playStrum` for strum styles, or `psStart` for the per-pad scheduler (arpeggio/sequence styles).
5. Optional bass note ([chord-pad.js:676-681](js/chord-pad.js#L676)) computed via `bassNoteForChord`.
6. **Keyboard highlighting** via `_markPadKeys`: every MIDI note in the chord (+ bass) gets a `.pad-active` class on its `.kb-key[data-midi=X]` element. Refcounted via `_padKeyRef` Map so overlapping pads (or pads + held keyboard keys) clean up correctly.
7. Save in `state.activeChords` with all the audio handles, the kbHighlight array, the bass node, the label. On release, all of this is reversed.

### Override system on knobs

`OVERRIDE_KEYS` ([chord-pad.js:2486-2489](js/chord-pad.js#L2486)) lists the six knobs that flip into "user has touched this" mode for SF2 instruments: `attack`, `decay`, `sustain`, `release`, `filterFreq`, `filterQ`.

Knob handlers (`makeCpKnob`, `makeFxKnob`) call `setOverride(true)` on pointerdown/wheel and `setOverride(false)` on dblclick (which also resets the value to the preset default). The audio engine reads `s._override?.[key]` to decide whether to use the slider value or the SF2 generator.

The visual feedback is a small accent-coloured dot rendered above the knob's value-label, plus the value text turns accent-coloured. Both via the `.is-override` class on the knob's cell.

`INSTRUMENT_PRESETS` ([chord-pad.js:1631-1640](js/chord-pad.js#L1631)) includes a `default` entry (neutral, all FX at 0) used as fallback when a GM preset doesn't ship its own — otherwise unknown instruments would inherit the Rhodes-tremolo preset and sound wrong.

### Rotary knob primitives

`makeCpKnob` / `makeFxKnob` ([chord-pad.js:1203,2931](js/chord-pad.js#L1203)) — both produce a circular knob with:

- Drag (X+Y diagonal, like Ableton's volume knob).
- Wheel-scroll fine-tune (`ev.shiftKey` = even finer).
- Double-click → reset to instrument preset default (and clear override flag).
- Optional `🔄` sync icon next to time/rate fields → snap to tempo-aligned values (eighth, dotted-eighth, quarter, etc.).
- Live re-render of value label + indicator rotation via the `apply(v)` function.

The two flavours differ only in target object (`state.synth` vs `track.synth`) and undo behaviour (the track version wraps in `seqCheckpoint` / `seqSave`).

### Modals

Two modal popovers share a similar shell (`.track-fx-modal`):

- **Chord-pad modal** (`#chord-pad-modal`) — chord-pad voice settings: voicing dropdown, octave/sustain/bass/tooltip toggles, instrument picker, sound knobs, reset button.
- **Track FX modal** (`#track-fx-modal`) — per-track FX: output routing (Instrument/MIDI), MIDI channel, instrument picker, ADSR/filter/FX knobs, ADSR envelope visualization (SVG path that recalculates on every knob change), reset button.

Both modals use the same `TRACK_FX_FIELDS` table ([chord-pad.js:2486-2505](js/chord-pad.js#L2486)) to drive their knob grid. Fields have a `synthOnly` flag — overtones, detune, waveform, filter-LFO only show when the instrument is `synth` (they're meaningless for SF2 samples).

The instrument picker is a custom dropdown with a hover-submenu showing all GM presets per category (Piano, Organ, Guitar, …). The submenu is hoisted to `document.body` so it can escape the modal's scrollable container, and positioned to the right of the menu via `getBoundingClientRect`.

### Section toggles + mini-toolbar

The header has six section toggle buttons (chord-pad, keyboard, sequencer, piano-roll, chord-view, settings). Each adds/removes a `body.hide-X` class. The body's CSS uses these to hide the corresponding panels.

A second, floating mini-toolbar mirrors these buttons. When the page scrolls past the header, the mini-toolbar fades in (top-right corner) so the user can still toggle sections without scrolling back up. Implemented via a `MutationObserver` watching the originals' `.active` class, plus a `requestAnimationFrame` throttled scroll handler.

### REC system

Recording captures live actions during sequenced playback ([chord-pad.js:1993+](js/chord-pad.js#L1993)). The `REC` object holds:

```js
{
  active, armed, startTime,
  pendingChords: Map<padId, { interval, q, bassInterval, label, keyRoot, template, startBeat }>,
  pendingNotes:  Map<midi, { label, startBeat }>,      // synth keys via kbinput
  pendingMidi:   Map<midi, { label, startBeat }>,      // external MIDI input
}
```

On `playChord`: if recording, add an entry with the current beat. On `releaseChord`: compute duration, push a new clip into `ensureTrackOfKind('chord').items`. Same flow for notes via `kbinput.js`. Each track has its own arm flag; only armed tracks accept their input source.

### Track drag-reorder + Alt-duplicate

Track headers are `draggable="true"`. On dragstart, set the dataTransfer payload to the track id; the headers light up `.drop-before` or `.drop-after` based on the cursor's Y in the hovered target. On drop:

- **Plain drop** — splice `SEQ.tracksList` to reorder.
- **Alt-drop** — deep-clone the source track (`JSON.parse(JSON.stringify(src))`), fresh `id` via `newTrackId()`, fresh `id` per clip via `newClipId()`, drop transient playback state (`_scheduled`, `pendingIdx`, `_flatDirty`, …), and insert at the target slot. Name gets a `" copy"` suffix.

`effectAllowed = 'copyMove'` at dragstart — without it, browsers reject the `'copy'` dropEffect that the dragover sets when Alt is held, and Alt-drop silently falls through to a plain reorder. ([chord-pad.js:3244-3324](js/chord-pad.js#L3244))

---

## Specialized views

### Piano roll ([js/pianoroll.js](js/pianoroll.js))

`renderPianoRoll` ([pianoroll.js:174](js/pianoroll.js#L174)) builds:

- A `.pr-sizer` absolute container sized to `minBeats × PR_BEAT_PX` wide, `rows × PR_ROW_H` tall. The sizer carries the background-grid pattern so it covers the full scrollable area (the body itself only renders across `clientWidth` even with `background-attachment: local`).
- The bar/beat ruler above the body, with horizontal scroll sync.
- The piano keyboard sidebar (full 88 keys, properly stacked white-with-black-overlay) on the left.
- One note-block per `clip.notes[i]` via `_prMakeNote`.
- A clip-end vertical line at `clip.beats * PR_BEAT_PX`. Notes past the clip end are dimmed via `--note-clip-frac` CSS variable (Ableton-style "this part won't sound" indicator).
- The playhead and the edge-overflow ticks (see below).

The pitch range is **full piano** (A0–C8) — no autosizing. This was a design call: a stable range matches the keyboard sidebar exactly and never leaves gaps.

**Tools** are stored in `SEQ.prTool` (`'select'` / `'draw'` / `'erase'` / `'pan'` / `'none'`). The body pointerdown handler dispatches based on this.

**Note interaction** ([pianoroll.js:561-829](js/pianoroll.js#L561)):
- Drag the body (not handles) → move the entire selection group. Originals' starts/midis captured up-front; deltas applied per move.
- Shift constrains to dominant axis (horizontal-only or vertical-only).
- Ctrl/Cmd snaps the vertical step to **12 semitones** (octave-snap) for quick octave-jump duplicates.
- Alt-drag clones lazily on first movement, so the user can press Alt during the initial nudge. Live Alt-release removes the clones. Same logic as the arrangement clip drag.
- Resize handles (left + right edges of the note) — drag to stretch/shrink. Snap to grid when snap is on.

**Multi-note selection** is a `Set<note>` (`SEQ.prSelection`) keyed by note object identity. The marquee uses the same snapshot-and-rebuild approach as the arrangement, so notes leave the selection when the rect moves away. Shift+click toggles; click on an unselected note replaces.

**Live keyboard highlighting during playback** ([seq.js, inside `seqAnimatePlayhead`](js/seq.js)) — when the playhead is inside the focused clip, every frame collects the MIDI numbers of notes overlapping the current beat into a reused `SEQ._prActiveMidi` set, then toggles `.pr-key-active` on each `.pr-keyboard-row`. The keyboard column lights up exactly while the corresponding note is sounding, matching what the user hears (same source of truth as the playhead position, so timing is consistent).

**Velocity lane** ([pianoroll.js:410](js/pianoroll.js#L410)) is a thin strip below the piano roll. One vertical bar per note, height = `velocity / 127`. Drag a bar up/down to adjust. When a selection exists, non-selected bars dim and become non-interactive.

**Edge overflow ticks** ([pianoroll.js:355-404](js/pianoroll.js#L355)) — for each note that's currently scrolled outside the visible pitch range, a 2 px wide tick is rendered at the note's *time* position pinned to the top or bottom of the viewport. Tells the user "there's something above/below" with the right x-coordinate. The tick has a small directional glow (gradient pseudo-element) that flares INTO the viewport (away from where the note actually is, suggesting "scroll this way").

### Chord view ([js/chordview.js](js/chordview.js))

The lyrics-style horizontal chord follower. Each chord in the focused chord-track renders as a card with the chord name centered (root + smaller suffix), beat-tick lines for whole-beat boundaries, and a duration label at the bottom (`4b`, `2b`, …).

**Treadmill for seamless loop wrap** — the trick that makes it look like one infinitely scrolling row even when the loop is short:

1. Render `N = max(3, ceil(3 × viewport / loopWidth))` copies of the chord row (capped at 200).
2. Track `_cvLoopIter` — increments on every detected loop-wrap (animBeat jumps backward).
3. When iter would exceed `copies - 2` (i.e. cursor would land in the rightmost rendered copy with no buffer ahead), `_cvTreadmill` runs: removes the leftmost copy of cards from the DOM, appends a fresh copy at the right. Every existing card's DOM position shifts LEFT by `loopWidth` pixels; the iter-based cursor transform shifts RIGHT by the same amount.

Net visible change: zero. The cursor flows rightward forever, the loop never "snaps back".

**Filter to loop range** — when looping, items outside `[loopStart, loopEnd]` are excluded; items that straddle the boundary are clipped to the visible portion (synthetic items with adjusted `start`/`beats`).

**Card autofit** ([chordview.js:271](js/chordview.js#L271)) — for each card:
1. Try the label inline at full font size. If fits, done.
2. Else add `.cv-stacked` — the suffix is now absolutely positioned below the root, taking it out of horizontal flow.
3. If still too wide (rare, very long root), font-shrink in 2px steps down to 50%.

**Cursor + colour lookahead** — the cursor's pixel position is derived from `animBeat` (real time). The `.current` class on cards uses `animBeat + 0.25 beats` (small lookahead) so the colour transition starts slightly before the chord boundary, smoothing the swell-in / fade-out across boundaries.

**Zoom** via Ctrl+wheel scales `CHORDVIEW_PX_PER_BEAT`, clamped 30–300 px/beat. Persisted in `chord-pad-ui-v1`. The chord-view init reads its own value from localStorage (because seq.js's loader can't access the chordview module's `let` bindings yet).

**Track picker** dropdown in the chord-view header lists every chord track; selecting one re-renders the view for that track. Auto-hides when there's only one chord track.

### Analyzer ([js/analyzer.js](js/analyzer.js))

Reads `kbActive.keys()` (the held-keys map) and renders the detected chord name in the keyboard panel's header.

`_buildChordReverseMap` ([analyzer.js:25](js/analyzer.js#L25)) builds a sorted-unique pitch-class-set → quality-list lookup from `CHORD_INTERVALS`. Built lazily on first call. Common interval sets map to multiple qualities (e.g. fully-diminished 7th = 4 enharmonic spellings).

`detectChords(midiNotes)` ([analyzer.js:44](js/analyzer.js#L44)) — for each note as a candidate root, check if the other notes' pitch-class offsets match a known quality. Returns all `(root, quality)` pairs that fit.

Ranked by:
1. **Bass note hint** — if the lowest sounding MIDI note's pitch class equals the candidate root, rank higher. This is what lets the analyzer say "C Eb G Bb" is `Cm7` (root in bass) instead of `Eb6` (which contains the same notes).
2. **Simpler glyph wins** — shorter `QUALITY_GLYPH[q]` rank higher among equally-bassed candidates.

Black-key roots (D♯ = E♭ etc.) render with both spellings (`D♯/E♭…`) so the user can pick the one that matches their key context.

### Keyboard input ([js/kbinput.js](js/kbinput.js))

`buildKeyboard` ([kbinput.js:373](js/kbinput.js#L373)) builds MIDI 21–108 as DOM elements: white keys absolute-positioned in a row, black keys absolute-overlaid. C4 is auto-centered in the scroll area on init.

`kbActive` ([kbinput.js:199](js/kbinput.js#L199)) is `Map<midi, audioNode>`. `kbNoteOn` adds `.active` class, starts audio, feeds analyzer. `kbNoteOff` reverses. The guard is on `kbActive.has(midi)`, not on the audioNode value, so even null nodes (e.g. SF2 not loaded yet) still get the cleanup.

Document-level `keydown` ([kbinput.js:75-153](js/kbinput.js#L75)) handles:
- Pad shortcuts via `findChordByKey` (which looks up the pressed key in `V2_KEYMAPS[currentTemplate]`).
- Ctrl+Z/Y/Shift+Z (undo/redo), Ctrl+C/X/V/D/A (copy/cut/paste/duplicate/select-all) — note-context if piano-roll selection exists, else clip-context.
- Shift+Space (play/stop), `P` (panic), arrow keys (key/octave navigation), Delete/Backspace.

Touch-glide ([kbinput.js:329-371](js/kbinput.js#L329)) — single finger across keys triggers `kbNoteOn`/`Off` as the finger enters/exits each key. Same on chord pads via `playChord`/`releaseChord`.

---

## PWA infrastructure

### Service worker dual-cache ([sw.js](sw.js))

```
APP_CACHE  = 'chord-pad-app-vNNN'   ← bumps every release
ASSET_CACHE = 'chord-pad-assets-v1' ← stays put across releases
```

- **APP_CACHE** holds the app shell: HTML, CSS, JS modules, manifest, icons. Network-first with cache fallback. Replaced wholesale on every release (the activate handler deletes any cache key that isn't the current APP_CACHE or the ASSET_CACHE).
- **ASSET_CACHE** holds the 148 MB FluidR3_GM.sf2. Cache-first; a `CACHE_FIRST_PATTERNS` regex tests `\.sf2$`. We `await c.put(response.clone())` rather than fire-and-forget — a previous version lost the cache when the user refreshed mid-stream and the put never completed.

The activate handler ([sw.js:33-43](sw.js#L33)) deletes old APP_CACHE generations but explicitly preserves the ASSET_CACHE:

```js
e.waitUntil(caches.keys().then(keys =>
  Promise.all(keys
    .filter(k => k !== APP_CACHE && k !== ASSET_CACHE)
    .map(k => caches.delete(k)))
));
```

Without this split, every CSS tweak would force a re-download of the 148 MB soundbank.

### External assets

- **SF2 file** — `FluidR3_GM.sf2` (Frank Wen, CC-BY 3.0). Hosted on the personal GCS bucket `chord-pad-assets-2026` (public-read, CORS `*`). URL: `https://storage.googleapis.com/chord-pad-assets-2026/FluidR3_GM.sf2`.
- **Lucide icons** — `https://unpkg.com/lucide@latest/dist/umd/lucide.min.js`. Inline `<i data-lucide="name">` tags are replaced with inline SVG by `lucide.createIcons()`, which is called after every dynamic UI update.
- **Google Fonts** — JetBrains Mono (the monospace UI font), Major Mono Display (the wordmark "chord pad"), Cormorant Garamond (decorative).

### Manifest

[manifest.json](manifest.json) declares the PWA basics: name, start_url (`./chord-pad.html`), `display: standalone`, theme color, two icons (192×192, 512×512 PNG, both `maskable`). When installed as a PWA, the app gets its own window without browser chrome.

---

## CSS organisation ([chord-pad.css](chord-pad.css))

Single ~3500-line file. Loosely organised top-to-bottom:

1. **Base** — root vars (`--bg`, `--accent`, `--panel-edge`, …), `*` reset, body, scrollbar styles, default form controls inherit font-family (so `<button>` doesn't fall back to Arial).
2. **Header** — `.header`, `.header-right`, section toggles, settings popover, floating mini-toolbar.
3. **Tabs** — `.tabs`, `.tab.active` styling, `.page` cards.
4. **Chord-pad board** — `.card.major / .minor / .scale / .lib`, `.key-row`, `.key-track`, `.pad`, `.pad-button`, active/suggested highlight states, connection SVG lines for flow arrows, pad-key glow animations.
5. **Controls & sliders** — settings panel rows, range sliders, segmented toggles.
6. **Library tab** — `.lib-row`, `.lib-cell` grid, synonym tooltip.
7. **Media queries** — mobile portrait/landscape, tablet breakpoints.
8. **Sequencer arrangement** — `.seq-panel`, transport buttons, snap/chord-length pickers, tool buttons, marquee, split/merge guides.
9. **Keyboard panel** — `.keyboard-panel`, `.chord-analyzer`, `.kb-wrap`, `.kb-key.kb-white / .kb-black` with active/pad-active states, scroll nav.
10. **Piano-roll toolbar** — pen ghost preview, eraser cursor.
11. **Piano-roll canvas** — `.pr-sizer` with the SVG background-grid pattern, `.pr-note` styling, velocity lane, overflow-edge ticks.
12. **Track sidebar** — `.seq-track-sidebar`, `.seq-track-label`, drag-reorder cues (`.dragging`, `.drop-before`, `.drop-after`).
13. **Piano-roll detail view** — collapsible `.seq-pianoroll` container, resize handle.
14. **Chord view** — `.chordview-card`, scale/opacity transitions, `.current / .past / .future` states, playhead, loop-boundary marker, beat dividers, autofit-friendly inline label.
15. **Modals** — `.track-fx-modal` shell, knob grid, ADSR envelope visualisation, instrument picker submenu hover behaviour, scrollbar styling.

---

## Key design decisions

A few patterns worth calling out — they're choices that affected a lot of the code:

### Single-page, single global state, no framework

This makes hot-editing trivial (save, refresh) and avoids the complexity of build pipelines, but means coordination relies on conventions (load order, mutable globals). It works because the project is small enough that the implicit conventions are still tractable.

### Snapshot-based undo

Rather than command-pattern undo (where each action records a description that can be replayed in reverse), `seqCheckpoint` serializes the entire state to JSON at every action. Memory cost: 60 × ~50 KB = ~3 MB worst case. Simpler than command-pattern, no risk of asymmetric inverse operations, immune to refactor drift in the actions themselves.

### Latency compensation as a first-class concern

The visual cursor is rewound by `outputLatency + visualLatencyMs` so what you see matches what you hear. Without this, the cursor visibly leads the audio on Windows by ~75 ms. The `visualLatencyMs` knob in Settings lets users tune for driver under-reporting.

### Per-track event ledger + selective cancel

Notes are scheduled ahead of audio-context time so Web Audio handles sample-accurate timing. But when the user edits a clip or jumps the cursor, we need to cancel only the pending events, not the ones already playing. The `_scheduled` array per track records each scheduled event; `_seqCancelFuture(track, now)` filters by `event.startAt > now` and cancels each (oscillator stop + 1 ms-later note-off for MIDI). openDAW-inspired.

### Playback never produces preview audio

A consistent rule across every interactive surface: while `SEQ.playing` is true, touching a clip / note / keyboard column / pad block emits no audio of its own — you're listening to the song, not auditioning. Concretely:

- Click previews in `seqMakeBlock` (chord-arrangement), `seqMakeClipBlock` (free-clip), `seqMakeRollNote` (mini-roll in arrangement), `prPreviewMidi` (piano-roll keyboard column), and the piano-roll note-grab handler are all gated on `!SEQ.playing`.
- Drags / drops / resizes go through `seqResyncTrack` in its default strict-future mode (see Resync modes), so a clip dropped on top of the playhead doesn't fire mid-way — it waits for the next loop cycle.
- The hard-stop helper used by free-clip multi-note previews (`hardStop(node)`) cancels `env.gain`, disconnects the env node, and stops every oscillator at `ctx.currentTime` — necessary because `stopAudioNote`'s 500 ms release does nothing for nodes scheduled to *start* in the future.

### Treadmill rendering for chord view

Render N copies of the chord row, treadmill the leftmost copy to the rightmost edge on each loop wrap. Net visible change: zero. The cursor flows rightward "forever" without ever snapping back. Same idea as endless carousels and Spotify's lyrics view.

### "Smart override" on SF2 ADSR/filter knobs

The user shouldn't have to know that SF2 generators encode the preset's character. They move a knob; it just works. Behind the scenes, sliders default to a neutral "preset default" value, and the SF2 generator wins until the user explicitly drags the slider, at which point their value takes over. The `_override` flag tracks the user's intent per-key.

### UI prefs decoupled from project content

Importing a colleague's `.json` project shouldn't move your zoom level or which key the chord-pads are in. Two separate localStorage blobs: `chord-pad-seq-v1` for the project, `chord-pad-ui-v1` for view-state. Exports only carry the project.

### No-build philosophy

The whole codebase is a few `.js` files and a `.css` file. No `package.json`, no `node_modules`, no `dist/`. Cloning the repo and opening the HTML file in a modern browser is the entire setup. The trade-off is no type-checking and no module isolation, but for a focused single-purpose app it's been worth it.

---

## File reference

| File | Purpose |
| --- | --- |
| `chord-pad.html` | Single HTML entrypoint, loads all scripts |
| `chord-pad.css` | Single stylesheet (~3500 lines, sectioned by component) |
| `manifest.json` | PWA manifest |
| `sw.js` | Service worker (dual-cache APP/ASSET) |
| `vendor/soundfont2.js` | Third-party SF2 binary parser (MIT-licensed) |
| `js/audio.js` | Web Audio core, voice graphs, FX, SF2 playback |
| `js/midi.js` | Web MIDI, clock receive, panic |
| `js/seq.js` | Sequencer engine, transport, persistence |
| `js/pads.js` | Chord-pad board builders |
| `js/kbinput.js` | Visual keyboard + shortcuts + glide |
| `js/chord-pad.js` | Main UI: state, theory, modals, knobs |
| `js/pianoroll.js` | Piano-roll editor |
| `js/chordview.js` | Lyrics-style chord follower |
| `js/analyzer.js` | Live chord recognition |
| `sf2/` | Local copy of FluidR3_GM.sf2 (git LFS) |
| `LICENSE` | GPLv3 |
