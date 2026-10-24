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

**Let op (2026-10-24):** de chord-pad-kant van de WS-koppeling (hello/transport/
note/cp_set_vst/project_data) is nooit gepusht; `ui/compose/` is de kale
chord-pad van 16 juni zonder link-code. De engine-kant staat wel in Main.cpp.
Plan: niet herstellen maar vervangen — zie "Richting" hieronder.

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
