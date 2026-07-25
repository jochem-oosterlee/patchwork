# MIDI Host — session notes

Handoff context voor een nieuwe Claude Code sessie.

## Doel

Eigen MIDI-router + VST3-host op Windows. MIDI in → optionele VST3-plugin → audio out, met optionele MIDI thru naar een externe out. Eigen web-UI in Chrome, native engine in C++.

## Architectuur

```
Browser UI (HTML/JS)  ◄── WebSocket ws://127.0.0.1:7681 ──►  C++ engine (JUCE)
  - device dropdowns                JSON berichten           - juce::AudioAppComponent
  - test keyboard (Web MIDI)                                  - VST3 hosting
  - activity log                                              - MIDI in/out
                                                              - ix::WebSocketServer
```

UI wordt geserveerd via Python `http.server` op `http://127.0.0.1:8000/`
(file:// URL's mogen geen Web MIDI gebruiken — secure context vereist).

## Belangrijke bestanden

```
midi-host/
├── CMakeLists.txt            # JUCE + ixwebsocket via FetchContent, JUCE_ASIO=1
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
    └── MidiHost_artefacts/Release/MIDI Host.exe
```

## Dependencies

- **Visual Studio 2022 Community** met Native Desktop C++ workload (MSVC compiler)
- **CMake** in `C:\Program Files\CMake\bin\cmake.exe`
- **JUCE 8.0.4** — auto-fetched
- **ixwebsocket v11.4.5** — auto-fetched (TLS + ZLIB uit, localhost only)
- **ASIO SDK** — handmatig gedownload, staat op `C:\Users\joost\Desktop\ASIOSDK\common`
  (pad hard-coded in CMakeLists.txt, JUCE_ASIO=1)
- **loopMIDI** voor testen zonder hardware
- **Python** voor `http.server` om UI te serven

## Build + run

```powershell
# Configure (eenmalig of na CMakeLists wijziging)
& "C:\Program Files\CMake\bin\cmake.exe" -S "C:\Users\joost\Desktop\midi-host" `
    -B "C:\Users\joost\Desktop\midi-host\build" -G "Visual Studio 17 2022" -A x64

# Bouwen
& "C:\Program Files\CMake\bin\cmake.exe" --build "C:\Users\joost\Desktop\midi-host\build" `
    --config Release --parallel

# Engine starten
Start-Process "C:\Users\joost\Desktop\midi-host\build\MidiHost_artefacts\Release\MIDI Host.exe"

# UI serven
python -m http.server 8000 --directory "C:\Users\joost\Desktop\midi-host\ui" --bind 127.0.0.1
# Open http://127.0.0.1:8000/index.html
```

Rebuild-cyclus tijdens dev: `Get-Process "MIDI Host" | Stop-Process -Force; cmake --build ...; Start-Process ...`

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

1. **CMake hard-codeert** absoluut pad naar ASIO SDK. Maak relatief of via env var.
2. **Geen plugin chain** — maar één plugin tegelijk.
3. **Geen eigen preset management** — VST3 setCurrentProgram exposeert alleen stub-programs, niet de echte Arturia library. Volgende stap: eigen preset save/load via `getStateInformation`/`setStateInformation`, opgeslagen in `presets.json`.
4. **Encoding** — em-dash in C++ string literals gaf "â□□"; vervangen door ASCII `-`. Niet verder uitgezocht.
5. **UI nog niet ingebed** — losse Chrome tab, geen WebView2 single-window experience.
6. **Git** — nog geen `git init`.

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
