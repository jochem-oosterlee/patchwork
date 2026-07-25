# MIDI Host

Een eigen MIDI-router + VST3-host voor Windows.
C++ engine (JUCE) + web UI, gekoppeld via een localhost WebSocket.

## Architectuur

```
Web UI (Chrome)  ◄──── ws://127.0.0.1:7681 ────►  C++ engine (JUCE)
                       JSON berichten              audio + MIDI + VST3
```

## Bouwen

Eenmalig: Visual Studio 2022 (C++ workload) en CMake installeren.

```powershell
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

Resultaat: `build/MidiHost_artefacts/Release/MIDI Host.exe`

## UI draaien

Open `ui/index.html` in Chrome (of serveer met een mini http server tijdens dev).
De UI verbindt automatisch met de engine wanneer die draait.

## Iteraties

- [x] 0 — skeleton (leeg JUCE-venster, UI-stub)
- [ ] 1 — audio engine + test toon
- [ ] 2 — MIDI input + WebSocket koppeling met UI
- [ ] 3 — VST3 plugin laden + plugin GUI tonen
- [ ] 4 — volledige keten: MIDI in → plugin → audio out, plus MIDI thru
