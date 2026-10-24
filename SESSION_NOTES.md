# MIDI Host — session notes

Handoff context voor een nieuwe Claude Code sessie.

## Doel

Eigen MIDI-router + VST3-host op Windows. MIDI in → optionele VST3-plugin → audio out, met optionele MIDI thru naar een externe out. Eigen web-UI in Chrome, native engine in C++.

## Architectuur

```
Web UI (WebView2, in het app-venster)  ◄── ws://127.0.0.1:7681 ──►  C++ engine (JUCE)
  - tab "Patchwork": ui/ (gebundeld,        JSON berichten        - juce::AudioAppComponent
    geserveerd op http://127.0.0.1:7682)                           - VST3 hosting
  - tab "chord-pad": ui/compose/ (van schijf,                      - MIDI in/out
    geserveerd op http://127.0.0.1:7683)                           - ix::WebSocketServer
```

De engine serveert beide UI's zelf (secure context voor Web MIDI) en toont ze
in ingebedde WebView2-views: één venster, geen losse Chrome-tab meer.
De compose-view wordt van schijf geserveerd (`ui/compose/` in de source tree,
override via `chordPadDir` in settings.json).

De oude koppeling (chord-pad als transport-master, `cp-ch{n}`-VSTs per kanaal,
`route_channel`, `project_data`-rondreis) is op 2026-10-24 vervangen door het
model hieronder; de chord-pad-kant ervan was toch nooit gepusht.

## Engine-link (fase 1, 2026-10-24)

De engine bezit transport en sequencer. `ui/compose/js/link.js` (als laatste
geladen) legt wrappers om chord-pad's functies: gekoppeld → engine, anders het
oude Web Audio-gedrag. Engine-kant: `engine/Sequencer.h` (RT-veilig, model via
spin-locked pointer-swap, note-ons sample-accuraat in `PluginHost::addBlockMidi`).

UI → engine:
- `hello {role:'chordpad', version:2}` → `chordpad_ack`, `state`, `load_project`
  (compose.json), `transport`.
- `seq_model {model:{loop, loopStart, loopEnd, tracks:[{id, target, channel,
  audible, notes:[{start, beats, midi, vel}]}]}}` — plat, absolute kwartnoot-beats,
  noten al uitgerekend (chordToMidiNotes + bas) door de UI. Bij elke `seqSave`.
  `target` = preset-id uit Patchwork; '' = stil. Tracks met output 'instrument'
  spelen het pad-instrument (badge rechtsonder), output 'engine' hun eigen
  `engineTarget`, output 'midi' zijn stil zolang de link actief is.
- `transport_play {beat}`, `transport_stop`, `transport_seek {beat}`, `set_bpm`,
  `metronome {on}`, `click {accent}` (count-in).
- `note {on, note, vel, ch, target}` — live noten (pads, keyboard, previews).
  Zonder target gaat de noot als virtuele input "chord-pad" door de normale
  sources/presets-routing van de rack.
- `compose_save {data}` — autosave van het rijke project naar
  `%APPDATA%\MidiHost\compose.json`. Project save/open (`.pwproj`) bundelt
  settings.json + compose.json; geen rondreis meer.

Engine → UI: `transport {playing, beat, bpm, tsNum, loop, loopStart, loopEnd,
latencyBeats, notesFired}` op 30 Hz tijdens spelen (+1 bij play/stop-wissel).
De UI interpoleert de playhead ertussen en trekt `latencyBeats` eraf.

Getest met `scratchpad/seqtest.py` (WS-client): loop-wrap, seek, stop en
note-emissie kloppen. Instrumenten die het nummer gebruikt (`seqTargets`)
blijven geladen (`reconcileLiveInstances`) en worden bij `seq_model` geladen
(`ensurePresetLoaded`, over alle patchsets heen).

## Eén schil (fase 3, 2026-10-24)

Eén WebView: `ui/index.html` is de schil (titelbalk met menu's + view-switcher
Rack/Compose, statusbalk met engine-transport play/stop/positie/loop/metronoom).
De compose-view is een iframe naar de lokale compose-server
(`state.composeUrl`, poort 7683) met `?embed=1`: `ui/compose/embed.css` haalt
de eigen kaart, kop en projectknoppen weg en laat de achtergrond van de
schil doorschijnen. De native TitleBar heeft geen tabs meer, alleen status +
vensterknoppen. `resize_to_content` wordt niet meer gestuurd; het venster houdt
de grootte die de gebruiker kiest, de views scrollen intern.

Schil ↔ compose-frame (cross-origin) praten via `postMessage`:
- schil → frame `{type:'patchwork', action, arg}`: `toggleSection`, `setPadTarget`,
  `undo`, `redo`, `scrollTo`, `query`.
- frame → schil `{type:'compose', event}`: `ready`, `sections {active}`,
  `padTarget {id}`, `switchView {view}` (Ctrl+1/2 met focus in het frame).
De compose-toggles en de pads-instrumentkeuze staan in de titelbalk van de schil
(`#compose-tools`, alleen in Compose-view); undo/redo in de titelbalk gaan in
Compose-view naar het nummer, in Rack-view naar de rack. Engine-relay voor
tests/controllers: `show_view {view}` en `compose_action {action, arg}`.

Eén transport: de statusbalk van de schil (play/stop/positie/loop/metronoom/
tempo/maatsoort/clock). In embed verbergt `embed.css` compose's eigen
play/stop/loop/metronoom/tempo/maatsoort/clock; de Tracks-rij houdt
cursor-navigatie en record (+ count-in). Loop-knop in de schil → `toggleLoop`
naar het frame (loop zit in het songmodel); metronoom in de schil → engine
(`metroOn`), en embedded laat link.js de engine-metronoom met rust. Maatsoort
volgt de engine (`tsNum` in transport → `state.beatsPerBar`). Cursor-sprongen
sturen altijd `transport_seek`, ook gestopt, zodat Play vanuit de schil start
waar de compose-cursor staat; de engine broadcast transport ook bij een
positieverandering in rust.

Opruimpunten voor de compose-fork (alleen laptopgebruik, besloten 2026-10-24):
touch-glide en touch-handlers, mobiele media queries, PWA-manifest + sw.js
(in embed al uitgeschakeld) kunnen eruit. chord-pad standalone houdt dat wel.

Bekende beperkingen fase 1: één live-target voor alle pads/keyboard; MIDI-out
tracks stil in link-modus; `state` bevat alleen presets van de huidige set;
WebSocketBridge logt elk raw bericht (ruis bij 30 Hz / autosave).

## Richting (besloten 2026-10-24)

Eén app: de engine bezit tijd, audio en model; de web-UI is alleen beeld.
- Engine: instrument-slots (plugin-chain) op AudioProcessorGraph, transport +
  MIDI-sequencer in de audio-callback, één projectmodel + undo.
- UI: één pagina met views Rack (patchsets/instrumenten/sources) en Compose
  (pads/keyboard/arrangement/piano roll/chord view) op het engine-model.
- Muziektheorie (CHORD_INTERVALS, voicing, analyzer) blijft in JS; de UI
  stuurt uitgerekende noten naar de engine.
- Web Audio-engine van chord-pad verdwijnt uit Patchwork (chord-pad zelf blijft
  standalone bestaan in zijn eigen repo). Later evt. TinySoundFont in de engine.
- Tracktion Engine is het alternatief als audiotracks/automation gewenst zijn.

## Belangrijke bestanden

```
midi-host/
├── CMakeLists.txt            # JUCE + ixwebsocket + WebView2 via FetchContent, ASIO optioneel
├── engine/
│   ├── Main.cpp              # MainComponent: audio thread, UI, knopen alles vast
│   ├── WebSocketBridge.h     # ix::WebSocketServer wrapper
│   ├── MidiManager.h         # MIDI in/out devices + thru
│   └── PluginHost.h          # VST3 laden + thread-safe process()
├── ui/
│   ├── index.html            # UI layout
│   ├── app.js                # WS client + Web MIDI test keyboard
│   └── style.css
└── build/                    # CMake build dir
    └── MidiHost_artefacts/Release/Patchwork.exe
```

## Dependencies

- **Visual Studio 2022** (Community of Build Tools) met de C++ workload (MSVC)
- **CMake** ≥ 3.22
- **JUCE 8.0.4** — auto-fetched, patches in `patches/` worden bij configure toegepast
- **ixwebsocket v11.4.5** — auto-fetched (TLS + ZLIB uit, localhost only)
- **WebView2 SDK** — auto-download van NuGet bij configure
- **ASIO SDK** — niet redistribueerbaar, zelf downloaden van steinberg.net/asiosdk.
  Standaard zoekt CMake in `../ASIOSDK` (dus `Desktop/ASIOSDK` naast deze repo);
  anders `-DASIO_SDK_DIR=...` of env var `ASIO_SDK_DIR`. Zonder SDK bouwt hij
  zonder ASIO (warning bij configure).
- **compose-view** — `ui/compose/` in deze repo (fork van chord-pad, zonder de SF2;
  die laadt van de GCS-URL). Geserveerd vanuit de source tree (`PATCHWORK_UI_DIR`).
- **loopMIDI** voor testen zonder hardware

## Build + run

Vanuit de repo-root:

```powershell
# Configure (eenmalig of na CMakeLists wijziging)
cmake -S . -B build -G "Visual Studio 17 2022" -A x64

# Bouwen
cmake --build build --config Release --parallel

# Starten
Start-Process "build\MidiHost_artefacts\Release\Patchwork.exe"
```

Rebuild-cyclus tijdens dev: `Get-Process Patchwork | Stop-Process -Force; cmake --build ...; Start-Process ...`

Settings staan in `%APPDATA%\MidiHost\settings.json`.

## Huidige status

Werkend:
- Engine luistert op ws://127.0.0.1:7681
- MIDI in + UI dropdown (1 of 2 inputs via `select_midi_input` / `select_midi_input2`)
- VST3 laden via native file picker (Arturia plugins getest)
- Plugin GUI in apart venster
- Audio settings dialog met device type / device / sample rate / buffer size
- ASIO support (SDK ingelinkt)
- Status-label: `driver | device | SR | block (ms)`
- **Settings persistentie** (`%APPDATA%/MidiHost/settings.json`): audio device XML, MIDI in/in2, plugin pad — restore op startup
- **Arturia full controller integration werkt**: keys + display (preset naam op KeyLab scherm) + macro knobs/faders bedienen plugin parameters + GUI sliders bewegen mee + centrale encoder switcht presets. Vereist twee dingen:
    1. **Windows MIDI Services** geïnstalleerd (Win11): geeft KeyLab multi-client driver gedrag, zodat plugin de poort tegelijk met onze input kan claimen voor display feedback.
    2. **JUCE patch** in `patches/juce-vst3-midi-controller-sync.patch`: bug in JUCE's VST3 host die alleen de audio engine notify'de van MIDI-driven param changes, niet de edit controller. Gevolg was: geluid update wel, plugin GUI niet. Patch wordt elke `cmake configure` auto-applied via `execute_process` in CMakeLists, idempotent.

## Open punten

1. **Geen plugin chain** — maar één plugin tegelijk.
2. **Geen eigen preset management** — VST3 setCurrentProgram exposeert alleen stub-programs, niet de echte Arturia library. Volgende stap: eigen preset save/load via `getStateInformation`/`setStateInformation`, opgeslagen in `presets.json`. (chord-pad's per-track VSTs bewaren hun state al wel.)
3. **Encoding** — em-dash in C++ string literals gaf "â□□"; inmiddels staat `/utf-8` in CMakeLists en gebruikt Main.cpp weer em-dashes in strings; waarschijnlijk opgelost, nog niet expliciet gecontroleerd.

## Conventies die in deze sessie gegroeid zijn

- C++ headers in `engine/` zijn header-only met inline implementaties (kort + simpel).
- JUCE message thread voor UI/state changes (`MessageManager::callAsync`).
- Audio thread roept `plugin.process()` aan, die intern locked.
- MIDI input thread roept handler, push naar `juce::MidiMessageCollector` voor audio-thread consumptie.
- WS broadcast vanuit elke thread — ix::WebSocket::send is thread-safe.
- JSON via `juce::DynamicObject` + `juce::JSON::toString` (geen extra lib).

## Gebruiker

- Jochem (jochem.oosterlee@cleverbase.com), Windows 11.
- Weinig C++ ervaring, vertrouwt op AI voor de implementatie.
- Heeft Arturia VST3 plugins (Pigments etc.) op `C:\Program Files\Common Files\VST3\Arturia\`.
- Heeft ASIO drivers (Steinberg Generic Low Latency + ASIO4ALL).
