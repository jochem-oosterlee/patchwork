# Patchwork

Een eigen MIDI-router + VST3-host voor Windows, met
[chord-pad](https://github.com/jochem-oosterlee/chord-pad) ingebouwd als tweede tab.
C++ engine (JUCE) + web UI in een ingebedde WebView2, gekoppeld via een localhost WebSocket.

## Architectuur

```
Web UI (WebView2)  ◄──── ws://127.0.0.1:7681 ────►  C++ engine (JUCE)
                         JSON berichten              audio + MIDI + VST3
```

Zie [SESSION_NOTES.md](SESSION_NOTES.md) voor de details.

## Bouwen

Eenmalig nodig:

- Visual Studio 2022 (of de Build Tools) met de C++ workload, en CMake
- Optioneel de [Steinberg ASIO SDK](https://www.steinberg.net/asiosdk), uitgepakt naast
  deze repo als `../ASIOSDK` (of geef `-DASIO_SDK_DIR=...` mee). Zonder SDK bouwt hij zonder ASIO.
- Optioneel `chord-pad` gecloned op het Bureaublad (`Desktop/chord-pad`)

```powershell
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release --parallel
```

Resultaat: `build/MidiHost_artefacts/Release/Patchwork.exe`
