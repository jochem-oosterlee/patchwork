// MIDI Host — entry point. Native JUCE shell hosts an embedded WebView
// (WebView2 on Windows) that loads the UI from a built-in HTTP server.

#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_gui_extra/juce_gui_extra.h>
#include <array>
#include <cmath>
#include <utility>
#if JUCE_WINDOWS
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
 #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
 #endif
 #include <windows.h>
#endif
#include "WebSocketBridge.h"
#include "HttpFileServer.h"
#include "StaticDirServer.h"
#include "MidiManager.h"
#include "PluginHost.h"
#include "Sequencer.h"
#include "Settings.h"
#include <BinaryData.h>

#if JUCE_WINDOWS
 #include <windows.h>
 #include <processthreadsapi.h>
static void disableTimerResolutionBoost()
{
    // Tell Windows: don't honor this process's timeBeginPeriod requests.
    // Stops the mouse from feeling jittery while the app is open. Audio still
    // works because WASAPI uses its own scheduler, not the multimedia timer.
    PROCESS_POWER_THROTTLING_STATE state {};
    state.Version      = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
    state.ControlMask  = PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
    state.StateMask    = PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
    SetProcessInformation (GetCurrentProcess(), ProcessPowerThrottling, &state, sizeof (state));
}
#endif

struct SplashParams
{
    int   iconSize     = 80;
    int   iconTop      = 324;
    float strokeWidth  = 1.5f;
    int   gapBelowIcon = 19;
    float textPx       = 15.5f;
    float kerning      = 0.32f;
    bool  grid         = false;
};

static juce::Image renderSplashImage (const SplashParams& p)
{
    constexpr int splashW = 1000, splashH = 760;
    auto cableSvg = juce::String::fromUTF8 (BinaryData::cable_svg, BinaryData::cable_svgSize)
                        .replace ("currentColor", "#ffaa33")
                        .replace ("stroke-width=\"2\"", "stroke-width=\"" + juce::String (p.strokeWidth) + "\"");
    auto cableDrawable = juce::Drawable::createFromImageData (cableSvg.toRawUTF8(), (size_t) cableSvg.getNumBytesAsUTF8());

    juce::Image canvas (juce::Image::ARGB, splashW, splashH, true);
    juce::Graphics g (canvas);
    g.fillAll (juce::Colour (0xff0d0e10));

    const float cx = splashW / 2.0f;
    if (cableDrawable != nullptr)
    {
        juce::Rectangle<float> iconArea (cx - p.iconSize / 2.0f, (float) p.iconTop,
                                          (float) p.iconSize, (float) p.iconSize);
        cableDrawable->drawWithin (g, iconArea, juce::RectanglePlacement::centred, 1.0f);
    }

    g.setColour (juce::Colour (0xff8a8780));
    g.setFont (juce::Font (juce::FontOptions ("JetBrains Mono", p.textPx, juce::Font::plain))
                   .withExtraKerningFactor (p.kerning));
    g.drawText ("patchwork",
                0, p.iconTop + p.iconSize + p.gapBelowIcon, splashW,
                (int) std::ceil (p.textPx * 1.4f),
                juce::Justification::centredTop);

    if (p.grid)
    {
        g.setColour (juce::Colour::fromRGBA (255, 255, 255, 30));
        for (int i = 1; i < 10; ++i)
        {
            g.drawVerticalLine   ((int) (splashW * i / 10.0f), 0.0f, (float) splashH);
            g.drawHorizontalLine ((int) (splashH * i / 10.0f), 0.0f, (float) splashW);
        }
    }
    return canvas;
}

static juce::Component::SafePointer<juce::SplashScreen> gSplash;
static void dismissSplash()
{
    if (auto* s = gSplash.getComponent())
        s->deleteAfterDelay (juce::RelativeTime::seconds (0.3), true);
}

static constexpr int kWsPort       = 7681;
static constexpr int kHttpPort     = 7682;
static constexpr int kChordPadPort = 7683;   // serves the chord-pad web app locally

// Window caption / min-max-close buttons drawn as vector glyphs (no unicode
// in source — em-dash etc. mangled the encoding here before).
class WinButton : public juce::Button
{
public:
    enum Glyph { Minimise, Maximise, Close };
    explicit WinButton (Glyph g) : juce::Button ({}), glyph (g) {}
    void paintButton (juce::Graphics& g, bool over, bool down) override
    {
        if (over || down)
            g.fillAll (glyph == Close ? juce::Colour (0xffc0392b) : juce::Colour (0x24ffffff));
        g.setColour (juce::Colour (0xffd8dde3));
        auto c = getLocalBounds().getCentre().toFloat();
        const float s = 4.5f;
        if (glyph == Minimise)      g.drawLine (c.x - s, c.y, c.x + s, c.y, 1.3f);
        else if (glyph == Maximise) g.drawRect (juce::Rectangle<float> (c.x - s, c.y - s, 2 * s, 2 * s), 1.2f);
        else { g.drawLine (c.x - s, c.y - s, c.x + s, c.y + s, 1.3f); g.drawLine (c.x - s, c.y + s, c.x + s, c.y - s, 1.3f); }
    }
    Glyph glyph;
};

// Shared transport button in the title bar: play triangle when stopped, pause
// bars (green) when the engine play-head is running. Drives chord-pad.
class PlayButton : public juce::Button
{
public:
    PlayButton() : juce::Button ({}) {}
    bool playing = false;
    void paintButton (juce::Graphics& g, bool over, bool down) override
    {
        if (over || down) g.fillAll (juce::Colour (0x20ffffff));
        auto c = getLocalBounds().getCentre().toFloat();
        g.setColour (playing ? juce::Colour (0xff3ddc84) : juce::Colour (0xffd8dde3));
        if (playing)
        {
            g.fillRect (juce::Rectangle<float> (c.x - 4.5f, c.y - 5.0f, 3.0f, 10.0f));
            g.fillRect (juce::Rectangle<float> (c.x + 1.5f, c.y - 5.0f, 3.0f, 10.0f));
        }
        else
        {
            juce::Path p; p.addTriangle (c.x - 4.0f, c.y - 5.5f, c.x - 4.0f, c.y + 5.5f, c.x + 5.5f, c.y);
            g.fillPath (p);
        }
    }
};

// Custom in-style title bar for the borderless window: engine status and
// minimise / maximise / close. Dragging the empty caption hands off to the
// native move loop (WM_NCLBUTTONDOWN) so Windows drag + Aero Snap work; the
// maximise button "maximises" to the monitor work area (respects the taskbar).
class TitleBar : public juce::Component
{
public:
    TitleBar()
    {
        setInterceptsMouseClicks (true, true);
        for (auto* b : { &minBtn, &maxBtn, &closeBtn }) addAndMakeVisible (*b);
        minBtn.onClick   = [this] { nativeMinimise(); };
        maxBtn.onClick   = [this] { toggleMaximise(); };
        closeBtn.onClick = [] { juce::JUCEApplication::getInstance()->systemRequestedQuit(); };
    }

    // Engine status shown right of centre (bar.beat + tempo).
    void setStatus (juce::String text, bool playing)
    {
        if (text == statusText && playing == statusPlaying) return;
        statusText = std::move (text); statusPlaying = playing;
        repaint();
    }

    void paint (juce::Graphics& g) override
    {
        g.fillAll (juce::Colour (0xff121212));   // same neutral base as the web UI
        g.setColour (juce::Colour (0x18ffffff));
        g.fillRect (0, getHeight() - 1, getWidth(), 1);

        // Engine status (bar.beat + tempo) with a play/stop dot, drawn just
        // left of the window buttons.
        if (statusText.isNotEmpty())
        {
            const int rightEdge = getWidth() - 3 * 46 - 12;   // before min/max/close
            g.setColour (statusPlaying ? juce::Colour (0xff3ddc84) : juce::Colour (0x40ffffff));
            g.fillEllipse ((float) rightEdge - 6, (float) getHeight() / 2.0f - 3.0f, 6.0f, 6.0f);
            g.setColour (juce::Colour (0xff9aa0a8));
            g.setFont (juce::Font (12.0f));
            g.drawText (statusText, juce::Rectangle<int> (0, 0, rightEdge - 12, getHeight()),
                        juce::Justification::centredRight);
        }
    }

    void resized() override
    {
        auto r = getLocalBounds();
        const int bw = 46;
        closeBtn.setBounds (r.removeFromRight (bw));
        maxBtn  .setBounds (r.removeFromRight (bw));
        minBtn  .setBounds (r.removeFromRight (bw));
    }

    void mouseDown (const juce::MouseEvent&) override
    {
       #if JUCE_WINDOWS
        if (auto* peer = getTopLevelComponent()->getPeer())
        {
            auto hwnd = (HWND) peer->getNativeHandle();
            ReleaseCapture();
            SendMessage (hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);   // native move + Aero Snap
        }
       #endif
    }
    void mouseDoubleClick (const juce::MouseEvent&) override { toggleMaximise(); }

private:
    WinButton minBtn { WinButton::Minimise }, maxBtn { WinButton::Maximise }, closeBtn { WinButton::Close };
    bool maximised = false;
    juce::Rectangle<int> restoreBounds;
    juce::String statusText;
    bool statusPlaying = false;

    void nativeMinimise()
    {
       #if JUCE_WINDOWS
        if (auto* peer = getTopLevelComponent()->getPeer())
            ShowWindow ((HWND) peer->getNativeHandle(), SW_MINIMIZE);
       #endif
    }
    void toggleMaximise()
    {
        auto* top = getTopLevelComponent();
        if (top == nullptr) return;
        if (! maximised)
        {
            restoreBounds = top->getBounds();
            if (auto* d = juce::Desktop::getInstance().getDisplays().getDisplayForPoint (top->getBounds().getCentre()))
                top->setBounds (d->userArea);   // work area = excludes taskbar
            maximised = true;
        }
        else { top->setBounds (restoreBounds); maximised = false; }
    }
};

class MainComponent : public juce::AudioAppComponent,
                      private juce::ChangeListener,
                      private juce::Timer
{
public:
    MainComponent()
    {
        settings.load();

        midi.setHandler ([this] (const juce::String& src, const juce::MidiMessage& m) { onMidi (src, m); });
        midi.onInputOpened = [this] (const juce::String& opened, const juce::String& err)
        {
            if (err.isNotEmpty())
                logToUi ("midi input open FAILED: " + err);
            else if (opened.isEmpty())
                logToUi ("midi input closed");
            else
            {
                gotFirstMidi.store (false);
                logToUi ("midi input opened: " + opened);
            }
        };
        plugin.logger = [this] (const juce::String& s) { logToUi (s); };

        ws.logger = [this] (const juce::String& s) { logToUi (s); };
        ws.start (kWsPort, [this] (const juce::String& json) { onWsMessage (json); });
        http.start (kHttpPort);

        // Serve the compose view (our fork of chord-pad) locally so it runs in
        // a secure context (Web MIDI) and can open a ws:// link to us without
        // mixed-content blocking. Looked up in this order: settings.chordPadDir,
        // compose/ next to the exe (portable install), the source tree
        // (dev, picks up edits on reload). Skipped silently if none exists.
        {
            const auto exeDir = juce::File::getSpecialLocation (juce::File::currentExecutableFile).getParentDirectory();
            juce::File cpDir;
            if (settings.chordPadDir.isNotEmpty())
                cpDir = juce::File (settings.chordPadDir);
            else if (exeDir.getChildFile ("compose").getChildFile ("chord-pad.html").existsAsFile()
                     && ! juce::File (PATCHWORK_UI_DIR).getChildFile ("compose").isDirectory())
                cpDir = exeDir.getChildFile ("compose");
            else if (juce::File (PATCHWORK_UI_DIR).getChildFile ("compose").isDirectory())
                cpDir = juce::File (PATCHWORK_UI_DIR).getChildFile ("compose");
            else
                cpDir = exeDir.getChildFile ("compose");
            if (cpDir.isDirectory())
            {
                chordPad.start (kChordPadPort, cpDir, "chord-pad.html");
                if (chordPad.isListening())
                    logToUi ("chord-pad served at http://127.0.0.1:"
                             + juce::String (kChordPadPort) + "/  (" + cpDir.getFullPathName() + ")");
                else
                    logToUi ("chord-pad server failed: " + chordPad.getError());
            }
            else
            {
                logToUi ("chord-pad dir not found (" + cpDir.getFullPathName() + ") — link server not started");
            }
        }

        // Embedded browser pointed at our local HTTP server.
        juce::WebBrowserComponent::Options opts;
       #if JUCE_WINDOWS
        opts = opts.withBackend (juce::WebBrowserComponent::Options::Backend::webview2);
       #endif
        opts = opts.withKeepPageLoadedWhenBrowserIsHidden();
        struct Browser : juce::WebBrowserComponent
        {
            using WebBrowserComponent::WebBrowserComponent;
            std::function<void()> onPageReady;
            void pageFinishedLoading (const juce::String&) override { if (onPageReady) onPageReady(); }
        };
        auto* b = new Browser (opts);
        b->onPageReady = [] { dismissSplash(); };
        browser.reset (b);
        addAndMakeVisible (*browser);
        browser->goToURL ("http://127.0.0.1:" + juce::String (kHttpPort) + "/");

        // Custom in-style title bar (the window is borderless): app name,
        // engine status and window buttons. Handles drag + Aero Snap natively.
        // The views (Rack / Compose) live inside the single web page; the
        // compose view is an iframe onto the local compose server.
        addAndMakeVisible (titleBar);

        deviceManager.addChangeListener (this);

        setSize (1000, 760);

        // Defer audio init: setAudioChannels can stall the message thread for
        // many seconds while it enumerates drivers (especially WMS/ASIO/BT).
        // Let WebView2 + the UI come up first.
        juce::MessageManager::callAsync ([this]
        {
            juce::String wantedDevice;
            std::unique_ptr<juce::XmlElement> audioXml;
            if (settings.audioXml.isNotEmpty())
            {
                audioXml = juce::XmlDocument::parse (settings.audioXml);
                if (audioXml != nullptr)
                    wantedDevice = audioXml->getStringAttribute ("audioOutputDeviceName");
            }
            setAudioChannels (0, 2, audioXml.get());

            // Did the device we wanted actually open? If not, tell the UI so
            // the user can pick a new one.
            const auto setup  = deviceManager.getAudioDeviceSetup();
            const auto opened = setup.outputDeviceName;
            const bool missing = wantedDevice.isNotEmpty()
                              && (opened.isEmpty() || opened != wantedDevice);
            if (missing)
            {
                juce::DynamicObject::Ptr obj = new juce::DynamicObject();
                obj->setProperty ("event",   "audio_device_missing");
                obj->setProperty ("wanted",  wantedDevice);
                obj->setProperty ("opened",  opened);
                ws.broadcast (juce::var (obj.get()));
                logToUi ("audio device '" + wantedDevice + "' not available; opened '" + opened + "'");
            }
            restoreFromSettings();
        });

        startTimerHz (30);
    }

    ~MainComponent() override
    {
        deviceManager.removeChangeListener (this);
        ws.stop();
        http.stop();
        midi.close();
        plugin.close();
        shutdownAudio();
    }

    void changeListenerCallback (juce::ChangeBroadcaster*) override
    {
        if (auto xml = std::unique_ptr<juce::XmlElement> (deviceManager.createStateXml()))
        {
            const auto s = xml->toString();
            if (s != settings.audioXml)
            {
                settings.audioXml = s;
                settings.save();
            }
        }
    }

    // Send All-Notes-Off + All-Sound-Off on every channel to a loaded preset
    // so cutting a source mid-note doesn't leave anything ringing.
    void sendPanic (const juce::String& presetId)
    {
        if (! plugin.has (presetId)) return;
        for (int ch = 1; ch <= 16; ++ch)
        {
            plugin.queueMidi (presetId, juce::MidiMessage::allNotesOff (ch));
            plugin.queueMidi (presetId, juce::MidiMessage::allSoundOff (ch));
            plugin.queueMidi (presetId, juce::MidiMessage::allControllersOff (ch));
        }
    }

    void touchCurrentSet()
    {
        if (settings.currentSet >= 0 && settings.currentSet < (int) settings.sets.size())
            settings.sets[(size_t) settings.currentSet].updatedMs = juce::Time::currentTimeMillis();
    }

    void loadPinnedForCurrentSet()
    {
        for (auto& p : settings.currentPresets())
        {
            if (! p.pinned || p.pluginPath.isEmpty()) continue;
            juce::File f (p.pluginPath);
            if (! f.exists()) continue;
            const auto id = p.id;
            const auto state = p.stateB64;
            loadPluginForPreset (id, f, [this, id, state]
            {
                if (state.isNotEmpty()) plugin.applyStateBase64 (id, state);
            });
        }
    }

    void restoreFromSettings()
    {
        midi.openInputsByNames (settings.enabledDevices);
        if (settings.midiOut.isNotEmpty())
            midi.openOutputByName (settings.midiOut);
        if (settings.kbOut.isNotEmpty())
            midi.openKbOutputByName (settings.kbOut);

        plugin.playHead.bpm.store (settings.bpm);
        plugin.playHead.tsNum.store (settings.tsNumerator);
        plugin.playHead.tsDen.store (settings.tsDenominator);
        bypassPlugin.store (true);
        loadPinnedForCurrentSet();
        for (auto& id : seqTargets) ensurePresetLoaded (id);   // instruments the song plays
        broadcastState();
    }

    // ---- Unified project (song + rack + routing) ------------------------
    // A project bundles Patchwork's settings (sets/presets/plugin state/sources
    // /tempo) with the compose view's song. Both live on disk here: settings.json
    // and compose.json (the compose view autosaves to us), so saving is a plain
    // read of the two.
    // Save to the current project file, or ask for one if there is none yet.
    void startProjectSave (bool forceChooser = false)
    {
        juce::File current (settings.projectPath);
        if (! forceChooser && settings.projectPath.isNotEmpty() && current.getParentDirectory().isDirectory())
        {
            writeProject (current);
            return;
        }
        auto startAt = current.existsAsFile() ? current : juce::File::getSpecialLocation (juce::File::userDocumentsDirectory);
        projectChooser = std::make_unique<juce::FileChooser> ("Save project", startAt, "*.pwproj");
        projectChooser->launchAsync (juce::FileBrowserComponent::saveMode
                                     | juce::FileBrowserComponent::canSelectFiles
                                     | juce::FileBrowserComponent::warnAboutOverwriting,
            [this] (const juce::FileChooser& fc)
            {
                auto f = fc.getResult();
                if (f == juce::File()) return;
                if (f.getFileExtension().isEmpty()) f = f.withFileExtension ("pwproj");
                writeProject (f);
            });
    }

    void writeProject (const juce::File& f)
    {
        settings.projectPath = f.getFullPathName();
        settings.save();                    // flush current rack/routing (+ the project path) to settings.json
        juce::DynamicObject::Ptr proj = new juce::DynamicObject();
        proj->setProperty ("format",    "patchwork-project");
        proj->setProperty ("version",   2);
        proj->setProperty ("patchwork", juce::JSON::parse (Settings::file()));
        const auto cf = Settings::composeFile();
        proj->setProperty ("chordpad",  cf.existsAsFile() ? juce::JSON::parse (cf) : juce::var());
        const bool ok = f.replaceWithText (juce::JSON::toString (juce::var (proj.get()), true));
        logToUi (ok ? ("project saved: " + f.getFullPathName())
                    : ("project save FAILED: " + f.getFullPathName()));
        broadcastState();
    }

    // New song: the compose half starts empty, the rack stays as it is, and
    // the next Save asks for a file.
    void newProject()
    {
        seq.stop();
        settings.projectPath.clear();
        settings.save();
        Settings::composeFile().deleteFile();
        juce::DynamicObject::Ptr empty = new juce::DynamicObject();
        empty->setProperty ("tracksList", juce::Array<juce::var>());
        empty->setProperty ("loopStart", 0.0);
        empty->setProperty ("loopEnd",   4.0);
        empty->setProperty ("loop",      false);
        juce::DynamicObject::Ptr msg = new juce::DynamicObject();
        msg->setProperty ("event", "load_project");
        msg->setProperty ("data",  juce::var (empty.get()));
        ws.broadcast (juce::var (msg.get()));
        logToUi ("new song");
        broadcastState();
    }

    void startProjectOpen()
    {
        juce::File current (settings.projectPath);
        auto startAt = current.existsAsFile() ? current.getParentDirectory() : juce::File::getSpecialLocation (juce::File::userDocumentsDirectory);
        projectChooser = std::make_unique<juce::FileChooser> ("Open project", startAt, "*.pwproj;*.json");
        projectChooser->launchAsync (juce::FileBrowserComponent::openMode
                                     | juce::FileBrowserComponent::canSelectFiles,
            [this] (const juce::FileChooser& fc)
            {
                auto f = fc.getResult();
                if (! f.existsAsFile()) return;
                auto v = juce::JSON::parse (f);
                if (! v.isObject()) { logToUi ("not a valid project file"); return; }
                seq.stop();
                auto patchVar = v.getProperty ("patchwork", juce::var());
                if (patchVar.isObject())
                {
                    Settings::file().replaceWithText (juce::JSON::toString (patchVar, true));
                    plugin.unloadAll();
                    settings.load();
                    restoreFromSettings();
                }
                settings.projectPath = f.getFullPathName();   // this file is now what Save writes to
                settings.save();
                auto chordVar = v.getProperty ("chordpad", juce::var());
                if (! chordVar.isVoid())
                    Settings::composeFile().replaceWithText (juce::JSON::toString (chordVar, true));
                juce::DynamicObject::Ptr msg = new juce::DynamicObject();
                msg->setProperty ("event", "load_project");
                msg->setProperty ("data",  chordVar);
                ws.broadcast (juce::var (msg.get()));   // the compose view applies its half and re-sends the seq model
                logToUi ("project opened: " + f.getFullPathName());
            });
    }

    void prepareToPlay (int samplesPerBlock, double sampleRate) override
    {
        currentSampleRate = sampleRate;
        currentBlockSize  = samplesPerBlock;
        plugin.prepare (sampleRate, samplesPerBlock);
    }

    void getNextAudioBlock (const juce::AudioSourceChannelInfo& info) override
    {
        const int    n  = info.numSamples;
        const double sr = currentSampleRate;

        // The sequencer owns the transport: it advances the position, drops its
        // note events sample-accurately into the target plugins' block buffers
        // and reports where the beats fall for the metronome. The play-head
        // mirrors it so hosted plugins (arps, tempo-synced FX) follow along.
        const double bpm   = plugin.playHead.bpm.load();
        const int    tsNum = juce::jmax (1, (int) plugin.playHead.tsNum.load());
        const auto blk = seq.process (n, sr, bpm, tsNum,
            [this] (const juce::String& target, const juce::MidiMessage& m, int offset)
            {
                plugin.addBlockMidi (target, m, offset);
                if (m.isNoteOn()) seqNotesFired.fetch_add (1);
            });
        plugin.playHead.isPlaying.store (blk.playing);
        plugin.playHead.ppqPosition.store (blk.startBeat);
        const int clickCount = metroOn.load() ? blk.clickCount : 0;

        info.clearActiveBufferRegion();
        juce::AudioBuffer<float> slice (info.buffer->getArrayOfWritePointers(),
                                        info.buffer->getNumChannels(),
                                        info.startSample,
                                        n);
        plugin.process (slice, n);

        // One-shot count-in click (fires even when transport isn't playing).
        const int pc = pendingClick.exchange (0);
        if (pc != 0) { metroEnv = 1.0; metroPhase = 0.0; metroFreq = (pc == 2 ? 1600.0 : 1000.0); }

        renderMetronome (slice, n, blk.clicks, clickCount);
    }

    // Mix the metronome click into the buffer. A short decaying sine, restarted
    // at each click onset; the envelope carries across blocks so a click near
    // the block edge rings out cleanly.
    void renderMetronome (juce::AudioBuffer<float>& buf, int n,
                          const std::array<std::pair<int, bool>, 8>& clicks, int clickCount)
    {
        const double sr = currentSampleRate;
        if (sr <= 0.0) return;
        if (clickCount == 0 && metroEnv <= 0.0002) return;   // nothing ringing, nothing new

        const double decay = std::exp (-1.0 / (0.025 * sr));      // ~25 ms click
        const double twoPi = 2.0 * juce::MathConstants<double>::pi;
        const float  gain  = metroGain.load();
        const int    nCh   = buf.getNumChannels();
        int ci = 0;
        for (int i = 0; i < n; ++i)
        {
            while (ci < clickCount && clicks[(size_t) ci].first == i)
            {
                metroEnv  = 1.0;
                metroPhase = 0.0;
                metroFreq = clicks[(size_t) ci].second ? 1600.0 : 1000.0;
                ++ci;
            }
            if (metroEnv > 0.0002)
            {
                const float s = (float) (std::sin (metroPhase) * metroEnv) * gain;
                for (int ch = 0; ch < nCh; ++ch)
                    buf.getWritePointer (ch)[i] += s;
                metroPhase += twoPi * metroFreq / sr;
                if (metroPhase > twoPi) metroPhase -= twoPi;
                metroEnv *= decay;
            }
        }
    }

    void releaseResources() override {}

    void paint (juce::Graphics& g) override { g.fillAll (juce::Colour (0xff121212)); }

    void resized() override
    {
        auto r = getLocalBounds();
        titleBar.setBounds (r.removeFromTop (34));   // custom title bar / caption
        if (browser != nullptr) browser->setBounds (r);
    }

private:
    void onMidi (const juce::String& source, const juce::MidiMessage& m)
    {
        if (! gotFirstMidi.exchange (true))
            logToUi ("first MIDI message received: " + m.getDescription());
        // The general in-LED ignores clock/transport real-time bytes — those
        // have their own beat indicator and would otherwise hold the LED solid.
        if (! m.isMidiClock() && ! m.isActiveSense() && ! m.isMidiStart()
            && ! m.isMidiStop() && ! m.isMidiContinue() && ! m.isQuarterFrame())
            midiInActivity.store (true);

        // MIDI clock / transport tracking. Updates the host play-head so
        // plugins (arpeggiators, LFOs, etc.) lock to the incoming tempo.
        if (m.isMidiClock() || m.isMidiStart() || m.isMidiStop() || m.isMidiContinue())
        {
            if (isAllowedClockSource (source))
                handleClockMessage (m);
            else if (m.isMidiClock())
            {
                if (! loggedClockBlocked.contains (source))
                {
                    loggedClockBlocked.add (source);
                    logToUi ("clock from '" + source + "' ignored — another source is flagged as clock master");
                }
            }
        }
        // Thru-row only routes when it's the active "preset" (bypass on).
        if (bypassPlugin.load() && thruSourceMatches (source, m))
        {
            midi.sendThru (m);
            midiOutActivity.store (true);
            const juce::ScopedLock sl (presetActivityLock);
            pendingActivePresets.addIfNotAlreadyThere ("__thru__");
        }

        // Route to every live preset whose source filter matches.
        for (auto& p : settings.currentPresets())
        {
            if (! plugin.has (p.id)) continue;
            if (matchesSourceFilter (p, source, m))
            {
                plugin.queueMidi (p.id, m);
                const juce::ScopedLock sl (presetActivityLock);
                pendingActivePresets.addIfNotAlreadyThere (p.id);
            }
        }
    }

    bool thruSourceMatches (const juce::String& source, const juce::MidiMessage& m)
    {
        juce::StringArray effIds = settings.thruSourceIds;
        if (effIds.isEmpty() && settings.defaultSourceId.isNotEmpty())
            effIds.add (settings.defaultSourceId);
        if (effIds.isEmpty()) return false;
        for (auto& s : settings.sources)
        {
            if (! effIds.contains (s.id)) continue;
            if (s.deviceName != source)   continue;
            if (s.channelMask != 0 && m.getChannel() > 0)
            {
                const auto bit = (juce::uint16) (1u << (m.getChannel() - 1));
                if ((s.channelMask & bit) == 0) continue;
            }
            return true;
        }
        return false;
    }

    bool isAllowedClockSource (const juce::String& deviceName)
    {
        bool anyFlagged = false;
        for (auto& s : settings.sources)
        {
            if (s.isClockSource)
            {
                anyFlagged = true;
                if (s.deviceName == deviceName) return true;
            }
        }
        return ! anyFlagged; // no specific source flagged → accept from any
    }

    void handleClockMessage (const juce::MidiMessage& m)
    {
        // External clock sets the tempo and starts/stops our transport; the
        // sequencer itself stays the source of the position.
        if (m.isMidiClock())
        {
            if (! clockActive) logToUi ("MIDI clock detected");
            const auto now = juce::Time::getMillisecondCounterHiRes();
            if (lastClockMs > 0)
            {
                const double interval = now - lastClockMs;
                if (interval > 0.5 && interval < 200.0) // sanity (10–2000 BPM)
                {
                    const double instant = 60000.0 / (interval * 24.0);
                    clockBpm = clockBpm > 0 ? (clockBpm * 0.85 + instant * 0.15) : instant;
                    if (settings.followMidiClock) plugin.playHead.bpm.store (clockBpm);
                }
            }
            lastClockMs = now;
            clockActive = true;
            if (++clockTickCounter >= 24) { clockTickCounter = 0; beatPulseDue.store (true); }
        }
        else if (m.isMidiStart())    seq.play (0.0);
        else if (m.isMidiContinue()) seq.play (seq.positionBeats());
        else if (m.isMidiStop())     seq.stop();
    }

    bool matchesSourceFilter (const Preset& p, const juce::String& source, const juce::MidiMessage& m)
    {
        // No connected sources and no default → preset is silent.
        juce::StringArray effIds = p.sourceIds;
        if (effIds.isEmpty() && settings.defaultSourceId.isNotEmpty())
            effIds.add (settings.defaultSourceId);
        if (effIds.isEmpty()) return false;
        for (auto& s : settings.sources)
        {
            if (! effIds.contains (s.id)) continue;
            if (s.deviceName != source)   continue;
            if (s.channelMask != 0 && m.getChannel() > 0)
            {
                const auto bit = (juce::uint16) (1u << (m.getChannel() - 1));
                if ((s.channelMask & bit) == 0) continue;
            }
            return true;
        }
        return false;
    }

    void timerCallback() override
    {
        // Transport position for the UIs' playheads: every tick while playing,
        // plus one message when play/stop flips or the cursor moves while stopped.
        {
            const bool   p    = seq.isPlaying();
            const double beat = seq.positionBeats();
            if (p || p != lastTransportPlaying || beat != lastTransportBeat) broadcastTransport();
            lastTransportPlaying = p;
            lastTransportBeat    = beat;
        }

        // Re-scan available MIDI devices every couple of seconds. If the set
        // changes, reopen anything that should be open, refresh the rail and
        // the MIDI-settings checkbox list.
        if (++deviceScanCounter >= kDeviceScanEveryTicks)
        {
            deviceScanCounter = 0;
            auto avail = midi.listInputs();
            if (avail != lastAvailableMidiIns)
            {
                lastAvailableMidiIns = avail;
                midi.openInputsByNames (settings.enabledDevices); // re-open any that came back
                broadcastDeviceList ("midi_inputs",  avail);
                broadcastDeviceList ("midi_outputs", midi.listOutputs());
                broadcastState();
            }
        }

        // Recover plugins that produced NaN or threw — reload them with their
        // saved state, no app restart required.
        auto broken = plugin.takeBrokenIds();
        for (auto& id : broken)
        {
            logToUi ("plugin produced NaN/exception — reloading: " + id);
            const Preset* p = findPresetById (id);
            if (p == nullptr || p->pluginPath.isEmpty()) continue;
            const auto path = p->pluginPath;
            const auto state = p->stateB64;
            plugin.unload (id);
            juce::File f (path);
            if (! f.exists()) continue;
            loadPluginForPreset (id, f, [this, id, state]
            {
                if (state.isNotEmpty()) plugin.applyStateBase64 (id, state);
            });
        }

        // Detect a lapsed MIDI clock (>1000ms of silence) → fall back to manual.
        if (clockActive && (juce::Time::getMillisecondCounterHiRes() - lastClockMs) > 1000.0)
        {
            clockActive = false;
            clockBpm    = 0.0;
            plugin.playHead.bpm.store (settings.bpm);
        }

        const bool in  = midiInActivity.exchange  (false);
        const bool out = midiOutActivity.exchange (false);
        const bool kb  = kbOutActivity.exchange   (false);

        juce::StringArray activePresets;
        {
            const juce::ScopedLock sl (presetActivityLock);
            activePresets.swapWith (pendingActivePresets);
        }
        const bool beat = beatPulseDue.exchange (false);
        auto levels = plugin.takeAndClearLevels();
        bool anyLevel = false;
        for (auto& [id, lv] : levels) if (lv > 0.001f) { anyLevel = true; break; }
        if (! in && ! out && ! kb && ! beat && ! anyLevel && activePresets.isEmpty()) return;

        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        obj->setProperty ("event", "midi_activity");
        obj->setProperty ("in",  in);
        obj->setProperty ("out", out);
        obj->setProperty ("kb",  kb);
        obj->setProperty ("beat", beat);
        if (clockActive) obj->setProperty ("effectiveBpm", plugin.playHead.bpm.load());
        juce::Array<juce::var> arr;
        for (auto& id : activePresets) arr.add (id);
        obj->setProperty ("presets", arr);
        if (! levels.empty())
        {
            juce::DynamicObject::Ptr levObj = new juce::DynamicObject();
            for (auto& [id, lv] : levels) levObj->setProperty (id, lv);
            obj->setProperty ("levels", juce::var (levObj.get()));
        }
        ws.broadcast (juce::var (obj.get()));
    }

    void onWsMessage (const juce::String& jsonText)
    {
        auto v = juce::JSON::parse (jsonText);
        if (! v.isObject())
        {
            logToUi ("ws msg not object: " + jsonText.substring (0, 200));
            return;
        }
        const auto cmd = v.getProperty ("cmd", "").toString();
        // High-frequency / autosave traffic stays out of the log.
        if (cmd != "kb_note" && cmd != "note" && cmd != "seq_model" && cmd != "compose_save"
            && cmd != "transport_seek" && cmd != "get_state")
            logToUi ("ws cmd: " + cmd);

        // ---- compose view link (handshake, transport, song model) ---------
        if (cmd == "hello")
        {
            const auto role = v.getProperty ("role", "").toString();
            const int  ver  = (int) v.getProperty ("version", 0);
            if (role == "chordpad")
            {
                logToUi ("compose view linked (v" + juce::String (ver) + ")");
                juce::MessageManager::callAsync ([this]
                {
                    juce::DynamicObject::Ptr ack = new juce::DynamicObject();
                    ack->setProperty ("event",   "chordpad_ack");
                    ack->setProperty ("engine",  "patchwork");
                    ack->setProperty ("version", 2);
                    ws.broadcast (juce::var (ack.get()));
                    broadcastState();
                    // Hand the compose view its last autosaved song; it answers
                    // with a fresh seq_model.
                    const auto cf = Settings::composeFile();
                    if (cf.existsAsFile())
                    {
                        juce::DynamicObject::Ptr msg = new juce::DynamicObject();
                        msg->setProperty ("event", "load_project");
                        msg->setProperty ("data",  juce::JSON::parse (cf));
                        ws.broadcast (juce::var (msg.get()));
                    }
                    broadcastTransport();
                });
            }
            return;
        }
        else if (cmd == "transport_play")
        {
            seq.play (v.hasProperty ("beat") ? (double) v.getProperty ("beat", 0.0) : seq.positionBeats());
            return;
        }
        else if (cmd == "transport_stop") { seq.stop(); return; }
        else if (cmd == "compose_action")
        {
            // Relay to the shell, which forwards it into the compose frame
            // (toggleSection / setPadTarget / undo / redo / scrollTo).
            juce::DynamicObject::Ptr o = new juce::DynamicObject();
            o->setProperty ("event",  "compose_action");
            o->setProperty ("action", v.getProperty ("action", "").toString());
            o->setProperty ("arg",    v.getProperty ("arg", juce::var()));
            ws.broadcast (juce::var (o.get()));
            return;
        }
        else if (cmd == "show_view")
        {
            // Ask the shell to switch view (rack / compose) — relayed to every
            // client so it can come from anywhere (test client, later a controller).
            juce::DynamicObject::Ptr o = new juce::DynamicObject();
            o->setProperty ("event", "show_view");
            o->setProperty ("view",  v.getProperty ("view", "rack").toString());
            ws.broadcast (juce::var (o.get()));
            return;
        }
        else if (cmd == "transport_seek") { seq.seek ((double) v.getProperty ("beat", 0.0)); return; }
        else if (cmd == "seq_model")
        {
            // The flattened song (tracks → notes in absolute beats + target instrument).
            const auto model = v.getProperty ("model", juce::var());
            juce::MessageManager::callAsync ([this, model] { applySeqModel (model); });
            return;
        }
        else if (cmd == "compose_save")
        {
            // Autosave of the compose view's rich project — we own the file.
            const auto data = v.getProperty ("data", juce::var());
            juce::MessageManager::callAsync ([data]
            {
                Settings::composeFile().replaceWithText (juce::JSON::toString (data, true));
            });
            return;
        }
        else if (cmd == "metronome")
        {
            metroOn.store ((bool) v.getProperty ("on", false));
            if (v.hasProperty ("gain"))
                metroGain.store (juce::jlimit (0.0f, 1.0f, (float) (double) v.getProperty ("gain", 0.35)));
            return;
        }
        else if (cmd == "click")
        {
            // One-shot metronome click (chord-pad's record count-in).
            pendingClick.store ((bool) v.getProperty ("accent", false) ? 2 : 1);
            return;
        }
        else if (cmd == "project_save")    { juce::MessageManager::callAsync ([this] { startProjectSave (false); }); return; }
        else if (cmd == "project_save_as") { juce::MessageManager::callAsync ([this] { startProjectSave (true);  }); return; }
        else if (cmd == "project_open")    { juce::MessageManager::callAsync ([this] { startProjectOpen(); });      return; }
        else if (cmd == "project_new")     { juce::MessageManager::callAsync ([this] { newProject(); });            return; }

        if (cmd == "list_midi_inputs")
        {
            broadcastDeviceList ("midi_inputs", midi.listInputs());
        }
        else if (cmd == "list_midi_outputs")
        {
            broadcastDeviceList ("midi_outputs", midi.listOutputs());
        }
        else if (cmd == "set_enabled_devices")
        {
            juce::StringArray names;
            if (auto* arr = v.getProperty ("names", juce::var()).getArray())
                for (auto& it : *arr) names.add (it.toString());
            juce::MessageManager::callAsync ([this, names]
            {
                settings.enabledDevices = names;
                midi.openInputsByNames (names);
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "set_default_source")
        {
            const auto id = v.getProperty ("id", "").toString();
            juce::MessageManager::callAsync ([this, id]
            {
                settings.defaultSourceId = (settings.defaultSourceId == id) ? juce::String() : id;
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "create_source")
        {
            const auto deviceName  = v.getProperty ("deviceName", "").toString();
            const auto label       = v.getProperty ("label",      deviceName).toString();
            const auto icon        = v.getProperty ("icon",       "music").toString();
            const int  channelMask = (int) v.getProperty ("channelMask", 0);
            juce::MessageManager::callAsync ([this, deviceName, label, icon, channelMask]
            {
                Source s;
                s.id          = juce::Uuid().toString();
                s.deviceName  = deviceName;
                s.label       = label.isEmpty() ? deviceName : label;
                s.icon        = icon.isEmpty()  ? juce::String ("music") : icon;
                s.channelMask = (juce::uint16) channelMask;
                settings.sources.push_back (std::move (s));
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "delete_source")
        {
            const auto id = v.getProperty ("id", "").toString();
            juce::MessageManager::callAsync ([this, id]
            {
                settings.sources.erase (
                    std::remove_if (settings.sources.begin(), settings.sources.end(),
                                    [&id] (const Source& s) { return s.id == id; }),
                    settings.sources.end());
                if (settings.defaultSourceId == id) settings.defaultSourceId.clear();
                // Drop this source id from any preset that referenced it, and
                // panic the affected live ones so no note hangs.
                for (auto& set : settings.sets)
                    for (auto& p : set.presets)
                        if (p.sourceIds.contains (id))
                        {
                            p.sourceIds.removeString (id);
                            if (plugin.has (p.id)) sendPanic (p.id);
                        }
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "update_source")
        {
            const auto id          = v.getProperty ("id", "").toString();
            const auto label       = v.getProperty ("label", "").toString();
            const auto icon        = v.getProperty ("icon",  "").toString();
            const auto deviceName  = v.getProperty ("deviceName", "").toString();
            const int  channelMask = (int) v.getProperty ("channelMask", 0);
            const bool hasClock    = v.hasProperty ("isClockSource");
            const bool isClock     = (bool) v.getProperty ("isClockSource", false);
            juce::MessageManager::callAsync ([this, id, label, icon, deviceName, channelMask, hasClock, isClock]
            {
                for (auto& s : settings.sources)
                    if (s.id == id)
                    {
                        if (label.isNotEmpty())      s.label      = label;
                        if (icon.isNotEmpty())       s.icon       = icon;
                        if (deviceName.isNotEmpty()) s.deviceName = deviceName;
                        s.channelMask = (juce::uint16) channelMask;
                        if (hasClock) s.isClockSource = isClock;
                        break;
                    }
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "select_midi_output")
        {
            const auto name = v.getProperty ("name", "").toString();
            midi.openOutputByName (name);
            if (name != settings.midiOut) { settings.midiOut = name; settings.save(); }
            broadcastState();
        }
        else if (cmd == "select_kb_output")
        {
            const auto name = v.getProperty ("name", "").toString();
            midi.openKbOutputByName (name);
            if (name != settings.kbOut) { settings.kbOut = name; settings.save(); }
        }
        else if (cmd == "kb_note")
        {
            const int  note = (int)  v.getProperty ("note", 60);
            const int  vel  = (int)  v.getProperty ("vel",  100);
            const bool on   = (bool) v.getProperty ("on",   true);
            auto m = on ? juce::MidiMessage::noteOn  (1, note, (juce::uint8) vel)
                        : juce::MidiMessage::noteOff (1, note);
            midi.sendKb (m);
            kbOutActivity.store (true);
        }
        else if (cmd == "note")
        {
            // Live note from the compose view (pads, keyboard, previews). With a
            // target it goes straight to that instrument; without one it enters
            // the normal routing as the virtual "chord-pad" input, so the pads
            // behave like any other controller feeding the rack.
            const int  note   = juce::jlimit (0, 127, (int) v.getProperty ("note", 60));
            const int  vel    = juce::jlimit (0, 127, (int) v.getProperty ("vel",  100));
            const bool on     = (bool) v.getProperty ("on", true);
            const int  ch     = juce::jlimit (1, 16, (int) v.getProperty ("ch", 1));
            const auto target = v.getProperty ("target", "").toString();
            auto m = (on && vel > 0) ? juce::MidiMessage::noteOn  (ch, note, (juce::uint8) vel)
                                     : juce::MidiMessage::noteOff (ch, note);
            if (target.isNotEmpty())
            {
                if (plugin.has (target)) plugin.queueMidi (target, m);
                midiInActivity.store (true);
            }
            else
                onMidi (MidiManager::kChordPadInput, m);
        }
        else if (cmd == "panic")
        {
            // All-notes-off / all-sound-off on every live plugin, all channels.
            for (auto& p : settings.currentPresets())
            {
                if (! plugin.has (p.id)) continue;
                for (int ch = 1; ch <= 16; ++ch)
                {
                    plugin.queueMidi (p.id, juce::MidiMessage::allNotesOff (ch));
                    plugin.queueMidi (p.id, juce::MidiMessage::allSoundOff (ch));
                }
            }
        }
        else if (cmd == "set_bypass")
        {
            const bool on = (bool) v.getProperty ("on", false);
            juce::MessageManager::callAsync ([this, on]
            {
                bypassPlugin.store (on);
                if (on)
                {
                    currentPresetIndex = -1;
                    reconcileLiveInstances(); // drops non-pinned plugins
                }
                broadcastState();
            });
        }
        else if (cmd == "open_plugin_picker")
        {
            juce::MessageManager::callAsync ([this] { openPluginPicker(); });
        }
        else if (cmd == "add_preset_with_plugin")
        {
            const auto path = v.getProperty ("path", "").toString();
            const auto name = v.getProperty ("name", "").toString();
            juce::MessageManager::callAsync ([this, path, name]
            {
                addPresetWithPlugin (path, name);
            });
        }
        else if (cmd == "toggle_pin_preset")
        {
            const int idx = (int) v.getProperty ("index", -1);
            juce::MessageManager::callAsync ([this, idx]
            {
                if (idx < 0 || idx >= (int) settings.currentPresets().size()) return;
                pushUndo();
                auto& p = settings.currentPresets()[(size_t) idx];
                p.pinned = ! p.pinned;
                if (! p.pinned) reconcileLiveInstances();
                else if (! plugin.has (p.id) && p.pluginPath.isNotEmpty())
                {
                    juce::File f (p.pluginPath);
                    if (f.exists())
                    {
                        const auto id = p.id;
                        const auto stateB64 = p.stateB64;
                        loadPluginForPreset (id, f, [this, id, stateB64]
                        {
                            if (stateB64.isNotEmpty()) plugin.applyStateBase64 (id, stateB64);
                        });
                    }
                }
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "add_fx")
        {
            // Append an effect to a preset's chain; loads right away if the
            // preset is live and opens its editor.
            const int  idx  = (int) v.getProperty ("index", -1);
            const auto path = v.getProperty ("path", "").toString();
            juce::MessageManager::callAsync ([this, idx, path]
            {
                if (idx < 0 || idx >= (int) settings.currentPresets().size()) return;
                juce::File f (path);
                if (! (f.existsAsFile() || f.isDirectory())) { logToUi ("fx not found: " + path); return; }
                pushUndo();
                auto& p = settings.currentPresets()[(size_t) idx];
                p.fx.push_back ({ f.getFullPathName(), {}, false });
                const int slot = (int) p.fx.size() - 1;
                settings.save();
                broadcastState();
                if (plugin.has (p.id))
                {
                    const auto id = p.id;
                    plugin.loadFx (id, slot, f, [this, id, slot] (const juce::String&, const juce::String& err)
                    {
                        if (err.isNotEmpty()) logToUi ("fx load failed: " + err);
                        else plugin.showFxEditor (id, slot);
                        broadcastState();
                    });
                }
            });
        }
        else if (cmd == "remove_fx")
        {
            const int idx = (int) v.getProperty ("index", -1);
            const int fxi = (int) v.getProperty ("fxIndex", -1);
            juce::MessageManager::callAsync ([this, idx, fxi]
            {
                if (idx < 0 || idx >= (int) settings.currentPresets().size()) return;
                auto& p = settings.currentPresets()[(size_t) idx];
                if (fxi < 0 || fxi >= (int) p.fx.size()) return;
                pushUndo();
                p.fx.erase (p.fx.begin() + fxi);
                plugin.removeFx (p.id, fxi);
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "move_fx")
        {
            const int idx  = (int) v.getProperty ("index", -1);
            const int from = (int) v.getProperty ("from", -1);
            const int to   = (int) v.getProperty ("to", -1);
            juce::MessageManager::callAsync ([this, idx, from, to]
            {
                if (idx < 0 || idx >= (int) settings.currentPresets().size()) return;
                auto& p = settings.currentPresets()[(size_t) idx];
                const int n = (int) p.fx.size();
                if (from < 0 || from >= n || to < 0 || to >= n || from == to) return;
                pushUndo();
                auto slot = p.fx[(size_t) from];
                p.fx.erase (p.fx.begin() + from);
                p.fx.insert (p.fx.begin() + to, slot);
                plugin.moveFx (p.id, from, to);
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "set_fx_bypass")
        {
            const int  idx = (int) v.getProperty ("index", -1);
            const int  fxi = (int) v.getProperty ("fxIndex", -1);
            const bool on  = (bool) v.getProperty ("on", false);
            juce::MessageManager::callAsync ([this, idx, fxi, on]
            {
                if (idx < 0 || idx >= (int) settings.currentPresets().size()) return;
                auto& p = settings.currentPresets()[(size_t) idx];
                if (fxi < 0 || fxi >= (int) p.fx.size()) return;
                p.fx[(size_t) fxi].bypass = on;
                plugin.setFxBypass (p.id, fxi, on);
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "show_fx_editor")
        {
            const int idx = (int) v.getProperty ("index", -1);
            const int fxi = (int) v.getProperty ("fxIndex", -1);
            juce::MessageManager::callAsync ([this, idx, fxi]
            {
                if (idx < 0 || idx >= (int) settings.currentPresets().size()) return;
                plugin.showFxEditor (settings.currentPresets()[(size_t) idx].id, fxi);
            });
        }
        else if (cmd == "list_vst3_plugins")
        {
            juce::MessageManager::callAsync ([this] { broadcastVst3Plugins(); });
        }
        else if (cmd == "list_arturia_plugins")
        {
            juce::MessageManager::callAsync ([this] { broadcastArturiaPlugins(); });
        }
        else if (cmd == "open_audio_settings")
        {
            juce::MessageManager::callAsync ([this] { openAudioSettings(); });
        }
        else if (cmd == "get_audio_state")
        {
            juce::MessageManager::callAsync ([this] { broadcastAudioState(); });
        }
        else if (cmd == "apply_audio_setup")
        {
            const auto deviceType = v.getProperty ("deviceType",  "").toString();
            const auto device     = v.getProperty ("device",      "").toString();
            const int  bufferSize = (int) v.getProperty ("bufferSize", 0);
            const double sr       = (double) v.getProperty ("sampleRate", 0.0);
            juce::MessageManager::callAsync ([this, deviceType, device, bufferSize, sr]
            {
                applyAudioSetup (deviceType, device, bufferSize, sr);
            });
        }
        else if (cmd == "select_set")
        {
            const int idx = (int) v.getProperty ("index", -1);
            juce::MessageManager::callAsync ([this, idx]
            {
                if (idx >= 0 && idx < (int) settings.sets.size())
                {
                    settings.currentSet = idx;
                    currentPresetIndex = -1;
                    bypassPlugin.store (true);
                    plugin.close();
                    settings.save();
                    loadPinnedForCurrentSet();
                    broadcastState();
                }
            });
        }
        else if (cmd == "create_set")
        {
            const auto name = v.getProperty ("name", "New set").toString();
            juce::MessageManager::callAsync ([this, name]
            {
                pushUndo();
                Patchset ns;
                ns.name      = name;
                ns.createdMs = juce::Time::currentTimeMillis();
                ns.updatedMs = ns.createdMs;
                settings.sets.push_back (std::move (ns));
                settings.currentSet = (int) settings.sets.size() - 1;
                currentPresetIndex  = -1;
                bypassPlugin.store (true);
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "set_archived")
        {
            const int  idx      = (int) v.getProperty ("index",    -1);
            const bool archived = (bool) v.getProperty ("archived", true);
            juce::MessageManager::callAsync ([this, idx, archived]
            {
                if (idx < 0 || idx >= (int) settings.sets.size()) return;
                pushUndo();
                settings.sets[(size_t) idx].archived  = archived;
                settings.sets[(size_t) idx].updatedMs = juce::Time::currentTimeMillis();
                if (archived && idx == settings.currentSet)
                {
                    // jump to next non-archived set
                    for (int i = 0; i < (int) settings.sets.size(); ++i)
                        if (! settings.sets[(size_t) i].archived) { settings.currentSet = i; break; }
                    currentPresetIndex = -1;
                    bypassPlugin.store (true);
                    plugin.close();
                    loadPinnedForCurrentSet();
                }
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "set_notes")
        {
            const int  idx   = (int) v.getProperty ("index", -1);
            const auto notes = v.getProperty ("notes", "").toString();
            juce::MessageManager::callAsync ([this, idx, notes]
            {
                if (idx < 0 || idx >= (int) settings.sets.size()) return;
                settings.sets[(size_t) idx].notes     = notes;
                settings.sets[(size_t) idx].updatedMs = juce::Time::currentTimeMillis();
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "clear_set")
        {
            juce::MessageManager::callAsync ([this]
            {
                pushUndo();
                settings.currentPresets().clear();
                currentPresetIndex = -1;
                bypassPlugin.store (true);
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "undo")
        {
            juce::MessageManager::callAsync ([this]
            {
                if (undoStack.empty()) return;
                redoStack.push_back (snapshot());
                applySnapshot (undoStack.back());
                undoStack.pop_back();
                broadcastState();
            });
        }
        else if (cmd == "redo")
        {
            juce::MessageManager::callAsync ([this]
            {
                if (redoStack.empty()) return;
                undoStack.push_back (snapshot());
                applySnapshot (redoStack.back());
                redoStack.pop_back();
                broadcastState();
            });
        }
        else if (cmd == "rename_set")
        {
            const int idx = (int) v.getProperty ("index", -1);
            const auto name = v.getProperty ("name", "").toString();
            juce::MessageManager::callAsync ([this, idx, name]
            {
                if (idx >= 0 && idx < (int) settings.sets.size() && name.isNotEmpty())
                {
                    pushUndo();
                    settings.sets[(size_t) idx].name = name;
                    settings.save();
                    broadcastState();
                }
            });
        }
        else if (cmd == "delete_set")
        {
            const int idx = (int) v.getProperty ("index", -1);
            juce::MessageManager::callAsync ([this, idx]
            {
                if (idx < 0 || idx >= (int) settings.sets.size()) return;
                if (settings.sets.size() == 1) return; // keep at least one
                pushUndo();
                settings.sets.erase (settings.sets.begin() + idx);
                if (settings.currentSet >= (int) settings.sets.size())
                    settings.currentSet = (int) settings.sets.size() - 1;
                currentPresetIndex = -1;
                bypassPlugin.store (true);
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "duplicate_set")
        {
            const int idx = (int) v.getProperty ("index", settings.currentSet);
            juce::MessageManager::callAsync ([this, idx]
            {
                if (idx < 0 || idx >= (int) settings.sets.size()) return;
                pushUndo();
                auto copy = settings.sets[(size_t) idx];
                copy.name += " copy";
                settings.sets.insert (settings.sets.begin() + idx + 1, std::move (copy));
                settings.currentSet = idx + 1;
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "copy_preset_to_set")
        {
            const int srcIdx = (int) v.getProperty ("presetIndex", -1);
            const int dstSet = (int) v.getProperty ("destSet",     -1);
            juce::MessageManager::callAsync ([this, srcIdx, dstSet]
            {
                if (srcIdx < 0 || srcIdx >= (int) settings.currentPresets().size()) return;
                if (dstSet < 0 || dstSet >= (int) settings.sets.size())            return;
                pushUndo();
                auto copy = settings.currentPresets()[(size_t) srcIdx];
                copy.id = juce::Uuid().toString(); // new identity so it can co-exist
                settings.sets[(size_t) dstSet].presets.push_back (std::move (copy));
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "move_preset_to_set")
        {
            const int srcIdx = (int) v.getProperty ("presetIndex", -1);
            const int dstSet = (int) v.getProperty ("destSet",     -1);
            juce::MessageManager::callAsync ([this, srcIdx, dstSet]
            {
                if (srcIdx < 0 || srcIdx >= (int) settings.currentPresets().size()) return;
                if (dstSet < 0 || dstSet >= (int) settings.sets.size())            return;
                pushUndo();
                auto moved = std::move (settings.currentPresets()[(size_t) srcIdx]);
                plugin.unload (moved.id);
                settings.currentPresets().erase (settings.currentPresets().begin() + srcIdx);
                settings.sets[(size_t) dstSet].presets.push_back (std::move (moved));
                if (currentPresetIndex == srcIdx) currentPresetIndex = -1;
                else if (currentPresetIndex > srcIdx) --currentPresetIndex;
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "create_preset")
        {
            const auto name = v.getProperty ("name", "").toString();
            juce::MessageManager::callAsync ([this, name]
            {
                pushUndo();
                Preset p;
                p.id   = juce::Uuid().toString();
                p.name = name;
                settings.currentPresets().push_back (std::move (p));
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "load_preset")
        {
            const int index = (int) v.getProperty ("index", -1);
            const bool show = (bool) v.getProperty ("showEditor", false);
            juce::MessageManager::callAsync ([this, index, show] { loadPreset (index, show); });
        }
        else if (cmd == "show_plugin_editor")
        {
            const int idx = (int) v.getProperty ("index", currentPresetIndex);
            juce::MessageManager::callAsync ([this, idx]
            {
                if (idx >= 0 && idx < (int) settings.currentPresets().size())
                    plugin.showEditor (settings.currentPresets()[(size_t) idx].id);
            });
        }
        else if (cmd == "reorder_preset")
        {
            const int from = (int) v.getProperty ("from", -1);
            const int to   = (int) v.getProperty ("to",   -1);
            juce::MessageManager::callAsync ([this, from, to]
            {
                auto& list = settings.currentPresets();
                if (from < 0 || from >= (int) list.size()) return;
                if (to   < 0 || to   >  (int) list.size()) return;
                if (from == to) return;
                pushUndo();
                auto moved = std::move (list[(size_t) from]);
                list.erase (list.begin() + from);
                const int dst = to > (int) list.size() ? (int) list.size() : to;
                list.insert (list.begin() + dst, std::move (moved));
                // Adjust currentPresetIndex so the selected preset travels along.
                if (currentPresetIndex == from) currentPresetIndex = dst;
                else if (from < currentPresetIndex && dst >= currentPresetIndex) --currentPresetIndex;
                else if (from > currentPresetIndex && dst <= currentPresetIndex) ++currentPresetIndex;
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "delete_preset")
        {
            const int index = (int) v.getProperty ("index", -1);
            juce::MessageManager::callAsync ([this, index]
            {
                if (index >= 0 && index < (int) settings.currentPresets().size())
                {
                    pushUndo();
                    const auto id = settings.currentPresets()[(size_t) index].id;
                    plugin.unload (id);
                    settings.currentPresets().erase (settings.currentPresets().begin() + index);
                    if (currentPresetIndex == index) currentPresetIndex = -1;
                    else if (currentPresetIndex > index) --currentPresetIndex;
                    settings.save();
                    broadcastState();
                }
            });
        }
        else if (cmd == "set_bpm")
        {
            const double newBpm = juce::jlimit (20.0, 999.0, (double) v.getProperty ("bpm", 120.0));
            juce::MessageManager::callAsync ([this, newBpm]
            {
                settings.bpm = newBpm;
                // Manual edit overrides clock-follow: typing a value means the
                // user wants that exact tempo, so stop chasing the clock.
                if (settings.followMidiClock && clockActive)
                    settings.followMidiClock = false;
                plugin.playHead.bpm.store (newBpm);
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "set_time_signature")
        {
            int num = (int) v.getProperty ("num", 4);
            int den = (int) v.getProperty ("den", 4);
            num = juce::jlimit (1, 32, num);
            // den should be a power of 2 (1,2,4,8,16,32)
            const int allowed[] = { 1, 2, 4, 8, 16, 32 };
            int snapped = 4;
            for (int d : allowed) if (d <= den) snapped = d;
            den = snapped;
            juce::MessageManager::callAsync ([this, num, den]
            {
                settings.tsNumerator   = num;
                settings.tsDenominator = den;
                plugin.playHead.tsNum.store (num);
                plugin.playHead.tsDen.store (den);
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "set_follow_clock")
        {
            const bool on = (bool) v.getProperty ("on", true);
            juce::MessageManager::callAsync ([this, on]
            {
                settings.followMidiClock = on;
                if (! on) plugin.playHead.bpm.store (settings.bpm);
                else if (clockActive && clockBpm > 0) plugin.playHead.bpm.store (clockBpm);
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "panic")
        {
            juce::MessageManager::callAsync ([this]
            {
                for (auto& id : plugin.liveIds()) sendPanic (id);
                for (int ch = 1; ch <= 16; ++ch)
                {
                    midi.sendThru (juce::MidiMessage::allNotesOff   (ch));
                    midi.sendThru (juce::MidiMessage::allSoundOff   (ch));
                    midi.sendThru (juce::MidiMessage::allControllersOff (ch));
                }
                logToUi ("MIDI panic sent");
            });
        }
        else if (cmd == "set_preset_volume_live")
        {
            // Live drag: change plugin gain only, no disk write or broadcast.
            const int   index  = (int) v.getProperty ("index", -1);
            const float volume = juce::jlimit (0.0f, 1.5f, (float) (double) v.getProperty ("volume", 1.0));
            juce::MessageManager::callAsync ([this, index, volume]
            {
                if (index < 0 || index >= (int) settings.currentPresets().size()) return;
                auto& p = settings.currentPresets()[(size_t) index];
                p.volume = volume; // keep in-memory in sync; written on commit
                plugin.setGain (p.id, volume);
            });
        }
        else if (cmd == "set_preset_volume")
        {
            const int   index  = (int) v.getProperty ("index", -1);
            const float volume = juce::jlimit (0.0f, 1.5f, (float) (double) v.getProperty ("volume", 1.0));
            juce::MessageManager::callAsync ([this, index, volume]
            {
                if (index < 0 || index >= (int) settings.currentPresets().size()) return;
                auto& p = settings.currentPresets()[(size_t) index];
                p.volume = volume;
                plugin.setGain (p.id, volume);
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "update_preset_state")
        {
            const int index = (int) v.getProperty ("index", -1);
            juce::MessageManager::callAsync ([this, index]
            {
                if (index >= 0 && index < (int) settings.currentPresets().size())
                {
                    pushUndo();
                    auto& p = settings.currentPresets()[(size_t) index];
                    p.stateB64 = plugin.getStateBase64 (p.id);
                    for (int i = 0; i < (int) p.fx.size(); ++i)
                    {
                        const auto s = plugin.getFxStateBase64 (p.id, i);
                        if (s.isNotEmpty()) p.fx[(size_t) i].stateB64 = s;
                    }
                    settings.save();
                    broadcastState();
                }
            });
        }
        else if (cmd == "toggle_thru_source")
        {
            const auto sid = v.getProperty ("sourceId", "").toString();
            juce::MessageManager::callAsync ([this, sid]
            {
                if (settings.thruSourceIds.contains (sid)) settings.thruSourceIds.removeString (sid);
                else                                       settings.thruSourceIds.add (sid);
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "set_thru_routing")
        {
            juce::StringArray inputs;
            if (auto* arr = v.getProperty ("inputs", juce::var()).getArray())
                for (auto& it : *arr) inputs.add (it.toString());
            const int channelMask = (int) v.getProperty ("channelMask", 0);
            juce::MessageManager::callAsync ([this, inputs, channelMask]
            {
                settings.thruInputs      = inputs;
                settings.thruChannelMask = (juce::uint16) channelMask;
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "set_preset_sources")
        {
            const int index = (int) v.getProperty ("index", -1);
            juce::StringArray ids;
            if (auto* arr = v.getProperty ("sourceIds", juce::var()).getArray())
                for (auto& it : *arr) ids.add (it.toString());
            juce::MessageManager::callAsync ([this, index, ids]
            {
                if (index >= 0 && index < (int) settings.currentPresets().size())
                {
                    pushUndo();
                    settings.currentPresets()[(size_t) index].sourceIds = ids;
                    settings.save();
                    broadcastState();
                }
            });
        }
        else if (cmd == "toggle_preset_source")
        {
            const int  index = (int) v.getProperty ("index", -1);
            const auto sid   = v.getProperty ("sourceId", "").toString();
            juce::MessageManager::callAsync ([this, index, sid]
            {
                if (index < 0 || index >= (int) settings.currentPresets().size()) return;
                pushUndo();
                auto& p    = settings.currentPresets()[(size_t) index];
                auto& list = p.sourceIds;
                const bool removing = list.contains (sid);
                if (removing) { list.removeString (sid); sendPanic (p.id); }
                else          { list.add (sid); }
                settings.save();
                broadcastState();
            });
        }
        else if (cmd == "set_preset_routing")
        {
            const int index = (int) v.getProperty ("index", -1);
            juce::StringArray inputs;
            if (auto* arr = v.getProperty ("inputs", juce::var()).getArray())
                for (auto& it : *arr) inputs.add (it.toString());
            const int channelMask = (int) v.getProperty ("channelMask", 0);
            juce::MessageManager::callAsync ([this, index, inputs, channelMask]
            {
                if (index >= 0 && index < (int) settings.currentPresets().size())
                {
                    pushUndo();
                    settings.currentPresets()[(size_t) index].inputs      = inputs;
                    settings.currentPresets()[(size_t) index].channelMask = (juce::uint16) channelMask;
                    settings.save();
                    broadcastState();
                }
            });
        }
        else if (cmd == "set_preset_tags")
        {
            const int index = (int) v.getProperty ("index", -1);
            juce::StringArray tags;
            if (auto* arr = v.getProperty ("tags", juce::var()).getArray())
                for (auto& t : *arr) tags.add (t.toString());
            juce::MessageManager::callAsync ([this, index, tags]
            {
                if (index >= 0 && index < (int) settings.currentPresets().size())
                {
                    pushUndo();
                    settings.currentPresets()[(size_t) index].tags = tags;
                    settings.save();
                    broadcastState();
                }
            });
        }
        else if (cmd == "rename_preset")
        {
            const int index = (int) v.getProperty ("index", -1);
            const auto name = v.getProperty ("name", "").toString();
            juce::MessageManager::callAsync ([this, index, name]
            {
                if (index >= 0 && index < (int) settings.currentPresets().size())
                {
                    pushUndo();
                    settings.currentPresets()[(size_t) index].name = name;
                    settings.save();
                    broadcastState();
                }
            });
        }
        else if (cmd == "window_move_by")
        {
            const int dx = (int) v.getProperty ("dx", 0);
            const int dy = (int) v.getProperty ("dy", 0);
            juce::MessageManager::callAsync ([this, dx, dy]
            {
                if (auto* t = getTopLevelComponent())
                    t->setBounds (t->getBounds().translated (dx, dy));
            });
        }
        else if (cmd == "window_minimize")
        {
            juce::MessageManager::callAsync ([this] { if (auto* t = getTopLevelComponent()) if (auto* p = t->getPeer()) p->setMinimised (true); });
        }
        else if (cmd == "window_maximize")
        {
            juce::MessageManager::callAsync ([this]
            {
                if (auto* t = getTopLevelComponent())
                    if (auto* p = t->getPeer())
                        p->setFullScreen (! p->isFullScreen());
            });
        }
        else if (cmd == "window_close")
        {
            juce::MessageManager::callAsync ([] { juce::JUCEApplication::getInstance()->systemRequestedQuit(); });
        }
        else if (cmd == "resize_to_content")
        {
            const int h = (int) v.getProperty ("height", 0);
            juce::MessageManager::callAsync ([this, h] { resizeToContentHeight (h); });
        }
        else if (cmd == "get_state")
        {
            broadcastState();
        }
    }

    void broadcastState()
    {
        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        obj->setProperty ("event",         "state");
        const auto avail = midi.listInputs();
        juce::Array<juce::var> srcArr;
        for (auto& s : settings.sources)
        {
            juce::DynamicObject::Ptr so = new juce::DynamicObject();
            so->setProperty ("id",          s.id);
            so->setProperty ("deviceName",  s.deviceName);
            so->setProperty ("label",       s.label);
            so->setProperty ("icon",        s.icon);
            so->setProperty ("channelMask",   (int) s.channelMask);
            so->setProperty ("isClockSource", s.isClockSource);
            so->setProperty ("online",        avail.contains (s.deviceName));
            srcArr.add (juce::var (so.get()));
        }
        obj->setProperty ("sources", srcArr);
        obj->setProperty ("defaultSourceId", settings.defaultSourceId);
        juce::Array<juce::var> enArr;
        for (auto& n : settings.enabledDevices) enArr.add (n);
        obj->setProperty ("enabledDevices", enArr);
        juce::Array<juce::var> thruIn;
        for (auto& n : settings.thruInputs) thruIn.add (n);
        obj->setProperty ("thruInputs",       thruIn);
        obj->setProperty ("thruChannelMask",  (int) settings.thruChannelMask);
        juce::Array<juce::var> thruSid;
        for (auto& s : settings.thruSourceIds) thruSid.add (s);
        obj->setProperty ("thruSourceIds",    thruSid);
        obj->setProperty ("midiOut",       settings.midiOut);
        obj->setProperty ("kbOut",         settings.kbOut);
        obj->setProperty ("pluginPath",    settings.pluginPath);
        juce::String activeName;
        if (currentPresetIndex >= 0 && currentPresetIndex < (int) settings.currentPresets().size())
            activeName = plugin.getInstanceName (settings.currentPresets()[(size_t) currentPresetIndex].id);
        obj->setProperty ("pluginName", activeName);
        obj->setProperty ("bypass",        bypassPlugin.load());
        obj->setProperty ("currentPreset", currentPresetIndex);
        obj->setProperty ("loading",       loading);
        juce::Array<juce::var> loadIds;
        for (auto& id : loadingPresetIds) loadIds.add (id);
        obj->setProperty ("loadingIds",    loadIds);

        juce::Array<juce::var> presetArr;
        for (auto& p : settings.currentPresets())
        {
            juce::DynamicObject::Ptr po = new juce::DynamicObject();
            po->setProperty ("id",         p.id);
            po->setProperty ("name",       p.name);
            po->setProperty ("pluginPath", p.pluginPath);
            po->setProperty ("pinned",     p.pinned);
            po->setProperty ("loaded",     plugin.has (p.id));
            po->setProperty ("volume",     (double) p.volume);
            juce::Array<juce::var> tagArr;
            for (auto& t : p.tags) tagArr.add (t);
            po->setProperty ("tags", tagArr);
            juce::Array<juce::var> presetInArr;
            for (auto& t : p.inputs) presetInArr.add (t);
            po->setProperty ("inputs",      presetInArr);
            po->setProperty ("channelMask", (int) p.channelMask);
            juce::Array<juce::var> sidArr;
            for (auto& t : p.sourceIds) sidArr.add (t);
            po->setProperty ("sourceIds",   sidArr);
            // Effect chain: configured slots merged with what's actually live.
            const auto infos = plugin.fxInfos (p.id);
            juce::Array<juce::var> fxArr;
            for (int i = 0; i < (int) p.fx.size(); ++i)
            {
                const auto& s = p.fx[(size_t) i];
                juce::DynamicObject::Ptr fo = new juce::DynamicObject();
                const bool live = i < (int) infos.size() && infos[(size_t) i].loaded;
                fo->setProperty ("name",   live && infos[(size_t) i].name.isNotEmpty()
                                            ? infos[(size_t) i].name
                                            : juce::File (s.pluginPath).getFileNameWithoutExtension());
                fo->setProperty ("path",   s.pluginPath);
                fo->setProperty ("bypass", s.bypass);
                fo->setProperty ("loaded", live);
                fxArr.add (juce::var (fo.get()));
            }
            po->setProperty ("fx", fxArr);
            presetArr.add (juce::var (po.get()));
        }
        obj->setProperty ("presets", presetArr);

        juce::Array<juce::var> setArr;
        for (auto& s : settings.sets)
        {
            juce::DynamicObject::Ptr so = new juce::DynamicObject();
            so->setProperty ("name",      s.name);
            so->setProperty ("count",     (int) s.presets.size());
            so->setProperty ("archived",  s.archived);
            so->setProperty ("createdMs", (double) s.createdMs);
            so->setProperty ("updatedMs", (double) s.updatedMs);
            so->setProperty ("notes",     s.notes);
            juce::Array<juce::var> presetNames;
            for (auto& pp : s.presets) presetNames.add (pp.name);
            so->setProperty ("presetNames", presetNames);
            setArr.add (juce::var (so.get()));
        }
        obj->setProperty ("sets",       setArr);
        obj->setProperty ("currentSet", settings.currentSet);
        obj->setProperty ("canUndo",    ! undoStack.empty());
        obj->setProperty ("canRedo",    ! redoStack.empty());
        obj->setProperty ("bpm",            settings.bpm);
        obj->setProperty ("followMidiClock", settings.followMidiClock);
        obj->setProperty ("tsNumerator",     settings.tsNumerator);
        obj->setProperty ("tsDenominator",   settings.tsDenominator);
        obj->setProperty ("clockActive",     clockActive);
        obj->setProperty ("effectiveBpm",    plugin.playHead.bpm.load());
        obj->setProperty ("projectPath", settings.projectPath);
        obj->setProperty ("projectName", settings.projectPath.isNotEmpty()
            ? juce::File (settings.projectPath).getFileNameWithoutExtension() : juce::String());
        // Where the shell finds the compose view ("" = not being served).
        obj->setProperty ("composeUrl", chordPad.isListening()
            ? "http://127.0.0.1:" + juce::String (kChordPadPort) + "/chord-pad.html" : juce::String());

        ws.broadcast (juce::var (obj.get()));
    }

    // The instrument library: every VST3 on the system, with vendor (its
    // folder under the VST3 root) and, for Arturia, the icon we can serve.
    void broadcastArturiaPlugins()
    {
        const juce::File root ("C:\\Program Files\\Common Files\\VST3");
        juce::Array<juce::File> files;
        if (root.isDirectory()) collectVst3 (root, files, 0);
        std::sort (files.begin(), files.end(), [] (const juce::File& a, const juce::File& b)
        {
            return a.getFileNameWithoutExtension().compareIgnoreCase (b.getFileNameWithoutExtension()) < 0;
        });
        juce::Array<juce::var> items;
        for (auto& f : files)
        {
            const auto name   = f.getFileNameWithoutExtension();
            const auto vendor = f.getParentDirectory() == root ? juce::String() : f.getParentDirectory().getFileName();
            juce::DynamicObject::Ptr o = new juce::DynamicObject();
            o->setProperty ("name",   name);
            o->setProperty ("path",   f.getFullPathName());
            o->setProperty ("vendor", vendor);
            if (vendor.equalsIgnoreCase ("Arturia"))
                o->setProperty ("iconUrl", "/arturia-icon/" + juce::URL::addEscapeChars (name, false));
            items.add (juce::var (o.get()));
        }

        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        obj->setProperty ("event", "arturia_plugins");
        obj->setProperty ("items", items);
        ws.broadcast (juce::var (obj.get()));
    }

    void logToUi (const juce::String& msg)
    {
        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        obj->setProperty ("event", "log");
        obj->setProperty ("msg",   msg);
        ws.broadcast (juce::var (obj.get()));
    }

    void broadcastDeviceList (const juce::String& eventName, const juce::StringArray& devs)
    {
        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        obj->setProperty ("event", eventName);
        juce::Array<juce::var> arr;
        for (auto& n : devs) arr.add (n);
        obj->setProperty ("devices", arr);
        ws.broadcast (juce::var (obj.get()));
    }

    void resizeToContentHeight (int contentHeight)
    {
        auto* top = getTopLevelComponent();
        if (top == nullptr) return;
        auto displayArea = juce::Desktop::getInstance().getDisplays()
                              .getDisplayForRect (top->getScreenBounds())->userArea;
        const int maxH = (int) (displayArea.getHeight() * 0.80);
        const int targetH = juce::jlimit (300, maxH, contentHeight);
        const auto cur = top->getBounds();
        if (cur.getHeight() == targetH) return;
        top->setBounds (cur.withHeight (targetH));
    }

    void broadcastAudioState()
    {
        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        obj->setProperty ("event", "audio_state");

        juce::Array<juce::var> types;
        for (auto* t : deviceManager.getAvailableDeviceTypes())
            types.add (t->getTypeName());
        obj->setProperty ("deviceTypes", types);

        auto* type = deviceManager.getCurrentDeviceTypeObject();
        const juce::String typeName = type ? type->getTypeName() : juce::String();
        obj->setProperty ("currentDeviceType", typeName);

        juce::Array<juce::var> devices;
        if (type != nullptr)
        {
            type->scanForDevices();
            for (auto& d : type->getDeviceNames (false))
                devices.add (d);
        }
        obj->setProperty ("devices", devices);

        auto setup = deviceManager.getAudioDeviceSetup();
        obj->setProperty ("currentDevice", setup.outputDeviceName);
        obj->setProperty ("currentSampleRate", setup.sampleRate);
        obj->setProperty ("currentBufferSize", setup.bufferSize);

        juce::Array<juce::var> sampleRates, bufferSizes;
        if (auto* dev = deviceManager.getCurrentAudioDevice())
        {
            for (auto r : dev->getAvailableSampleRates()) sampleRates.add (r);
            for (auto b : dev->getAvailableBufferSizes()) bufferSizes.add (b);
        }
        obj->setProperty ("sampleRates", sampleRates);
        obj->setProperty ("bufferSizes", bufferSizes);

        ws.broadcast (juce::var (obj.get()));
    }

    void applyAudioSetup (const juce::String& deviceType, const juce::String& device,
                          int bufferSize, double sampleRate)
    {
        if (deviceType.isNotEmpty())
        {
            auto* curType = deviceManager.getCurrentDeviceTypeObject();
            if (curType == nullptr || curType->getTypeName() != deviceType)
                deviceManager.setCurrentAudioDeviceType (deviceType, true);
        }
        auto setup = deviceManager.getAudioDeviceSetup();
        if (device.isNotEmpty())      setup.outputDeviceName = device;
        if (sampleRate > 0)           setup.sampleRate       = sampleRate;
        if (bufferSize > 0)           setup.bufferSize       = bufferSize;
        setup.useDefaultInputChannels  = false;
        setup.useDefaultOutputChannels = true;
        deviceManager.setAudioDeviceSetup (setup, true);
        broadcastAudioState();
    }

    void openAudioSettings()
    {
        auto selector = std::make_unique<juce::AudioDeviceSelectorComponent> (
            deviceManager,
            0, 0,   // min/max input channels
            1, 2,   // min/max output channels
            false,  // show MIDI inputs
            false,  // show MIDI output
            false,  // stereo pair treatment
            false); // hide advanced options
        selector->setSize (500, 380);

        juce::DialogWindow::LaunchOptions opts;
        opts.content.setOwned (selector.release());
        opts.dialogTitle                  = "Audio settings";
        opts.dialogBackgroundColour       = juce::Colour (0xff16181c);
        opts.escapeKeyTriggersCloseButton = true;
        opts.useNativeTitleBar            = true;
        opts.resizable                    = false;
        opts.launchAsync();
    }

    void openPluginPicker()
    {
        auto startDir = juce::File ("C:\\Program Files\\Common Files\\VST3");
        if (settings.pluginPath.isNotEmpty())
        {
            juce::File prev (settings.pluginPath);
            if (prev.getParentDirectory().isDirectory())
                startDir = prev.getParentDirectory();
        }

        chooser = std::make_unique<juce::FileChooser> (
            "Pick a VST3 plugin", startDir, "*.vst3");

        chooser->launchAsync (juce::FileBrowserComponent::openMode
                              | juce::FileBrowserComponent::canSelectFiles
                              | juce::FileBrowserComponent::canSelectDirectories,
            [this] (const juce::FileChooser& fc)
            {
                auto file = fc.getResult();
                if (file == juce::File()) return;
                addPresetWithPlugin (file.getFullPathName(), file.getFileNameWithoutExtension());
            });
    }

    void addPresetWithPlugin (const juce::String& path, const juce::String& nameIn)
    {
        logToUi ("addPresetWithPlugin: " + path);
        juce::File f (path);
        if (! (f.existsAsFile() || f.isDirectory())) { logToUi (" -> not found"); return; }

        pushUndo();
        Preset p;
        p.id         = juce::Uuid().toString();
        p.name       = nameIn.isEmpty() ? f.getFileNameWithoutExtension() : nameIn;
        p.pluginPath = path;
        settings.currentPresets().push_back (p);
        const int newIdx = (int) settings.currentPresets().size() - 1;
        bypassPlugin.store (false);
        currentPresetIndex = newIdx;
        reconcileLiveInstances();
        settings.save();
        broadcastState();

        const auto presetId = p.id;
        loadPluginForPreset (presetId, f, [this, presetId]
        {
            plugin.showEditor (presetId);
        });
    }

    // Re-evaluate which instances should be live and unload anything that is
    // neither selected nor pinned.
    void reconcileLiveInstances()
    {
        const auto& presets = settings.currentPresets();
        juce::StringArray keep;
        if (currentPresetIndex >= 0 && currentPresetIndex < (int) presets.size())
            keep.addIfNotAlreadyThere (presets[(size_t) currentPresetIndex].id);
        for (auto& p : presets) if (p.pinned) keep.addIfNotAlreadyThere (p.id);
        for (auto& id : seqTargets) keep.addIfNotAlreadyThere (id);   // the song's instruments stay up

        for (auto& id : plugin.liveIds())
            if (! keep.contains (id)) plugin.unload (id);
    }

    void loadPreset (int index, bool showEditor = false)
    {
        if (index < 0 || index >= (int) settings.currentPresets().size()) return;
        const auto& p = settings.currentPresets()[(size_t) index];
        if (p.pluginPath.isEmpty()) return;

        bypassPlugin.store (false);
        currentPresetIndex = index;
        reconcileLiveInstances();
        broadcastState();

        const auto presetId = p.id;

        const auto finish = [this, presetId, showEditor]
        {
            const auto* p2 = findPresetById (presetId);
            if (p2 != nullptr && p2->stateB64.isNotEmpty())
                plugin.applyStateBase64 (presetId, p2->stateB64);
            if (showEditor) plugin.showEditor (presetId);
        };

        if (plugin.has (presetId))
        {
            finish();
            return;
        }

        juce::File f (p.pluginPath);
        if (! f.exists()) return;
        loadPluginForPreset (presetId, f, [finish] { finish(); });
    }

    const Preset* findPresetById (const juce::String& id) const
    {
        for (auto& p : settings.currentPresets())
            if (p.id == id) return &p;
        return nullptr;
    }

    // ---- Sequencer model + transport reporting ---------------------------

    // Parse the compose view's flattened song and hand it to the sequencer.
    // Instruments it references are loaded (and kept loaded by reconcile).
    void applySeqModel (const juce::var& v)
    {
        auto m = std::make_shared<SeqModel>();
        m->loop      = (bool)   v.getProperty ("loop",      false);
        m->loopStart = (double) v.getProperty ("loopStart", 0.0);
        m->loopEnd   = (double) v.getProperty ("loopEnd",   4.0);
        juce::StringArray targets;
        if (auto* arr = v.getProperty ("tracks", juce::var()).getArray())
            for (auto& t : *arr)
            {
                SeqTrack tr;
                tr.id      = t.getProperty ("id",     "").toString();
                tr.target  = t.getProperty ("target", "").toString();
                tr.channel = juce::jlimit (1, 16, (int) t.getProperty ("channel", 1));
                tr.audible = (bool) t.getProperty ("audible", true);
                if (auto* na = t.getProperty ("notes", juce::var()).getArray())
                    for (auto& n : *na)
                    {
                        SeqNote nt;
                        nt.start = (double) n.getProperty ("start", 0.0);
                        nt.beats = juce::jmax (0.01, (double) n.getProperty ("beats", 1.0));
                        nt.midi  = juce::jlimit (0, 127, (int) n.getProperty ("midi", 60));
                        nt.vel   = juce::jlimit (1, 127, (int) n.getProperty ("vel",  100));
                        tr.notes.push_back (nt);
                    }
                std::sort (tr.notes.begin(), tr.notes.end(),
                           [] (const SeqNote& a, const SeqNote& b) { return a.start < b.start; });
                if (tr.target.isNotEmpty()) targets.addIfNotAlreadyThere (tr.target);
                m->tracks.push_back (std::move (tr));
            }
        seqTargets = targets;
        for (auto& id : targets) ensurePresetLoaded (id);
        seq.setModel (std::move (m));
    }

    // Load a preset's plugin (with its saved state) if it isn't live yet.
    // Looks across all patchsets: a song may play instruments from any set.
    void ensurePresetLoaded (const juce::String& id)
    {
        if (plugin.has (id) || loadingPresetIds.contains (id)) return;
        for (auto& set : settings.sets)
            for (auto& p : set.presets)
                if (p.id == id)
                {
                    juce::File f (p.pluginPath);
                    if (! f.exists()) return;
                    const auto st = p.stateB64;
                    loadPluginForPreset (id, f, [this, id, st]
                    {
                        if (st.isNotEmpty()) plugin.applyStateBase64 (id, st);
                    });
                    return;
                }
    }

    // ---- effect chains ---------------------------------------------------

    Preset* findPresetAnySet (const juce::String& id)
    {
        for (auto& set : settings.sets)
            for (auto& p : set.presets)
                if (p.id == id) return &p;
        return nullptr;
    }

    // Load a preset's configured effects into its live chain (called once the
    // instrument is up), restoring each one's state and bypass.
    void loadFxChainForPreset (const juce::String& presetId)
    {
        auto* pp = findPresetAnySet (presetId);
        if (pp == nullptr) return;
        for (int i = 0; i < (int) pp->fx.size(); ++i)
        {
            juce::File f (pp->fx[(size_t) i].pluginPath);
            if (! f.exists()) { logToUi ("fx not found: " + f.getFullPathName()); continue; }
            const auto st  = pp->fx[(size_t) i].stateB64;
            const bool byp = pp->fx[(size_t) i].bypass;
            plugin.loadFx (presetId, i, f, [this, presetId, i, st, byp] (const juce::String&, const juce::String& err)
            {
                if (err.isNotEmpty()) logToUi ("fx load failed: " + err);
                else
                {
                    if (st.isNotEmpty()) plugin.applyFxStateBase64 (presetId, i, st);
                    plugin.setFxBypass (presetId, i, byp);
                }
                broadcastState();
            });
        }
    }

    // Every .vst3 under the system VST3 folder. Bundles are directories named
    // *.vst3; we don't descend into them.
    static void collectVst3 (const juce::File& dir, juce::Array<juce::File>& out, int depth)
    {
        if (depth > 6) return;
        for (const auto& entry : juce::RangedDirectoryIterator (dir, false, "*", juce::File::findFilesAndDirectories))
        {
            const auto f = entry.getFile();
            if (f.hasFileExtension ("vst3")) out.add (f);
            else if (f.isDirectory()) collectVst3 (f, out, depth + 1);
        }
    }

    void broadcastVst3Plugins()
    {
        const juce::File root ("C:\\Program Files\\Common Files\\VST3");
        juce::Array<juce::File> files;
        if (root.isDirectory()) collectVst3 (root, files, 0);
        std::sort (files.begin(), files.end(), [] (const juce::File& a, const juce::File& b)
        {
            return a.getFileNameWithoutExtension().compareIgnoreCase (b.getFileNameWithoutExtension()) < 0;
        });
        juce::Array<juce::var> items;
        for (auto& f : files)
        {
            juce::DynamicObject::Ptr o = new juce::DynamicObject();
            o->setProperty ("name",   f.getFileNameWithoutExtension());
            o->setProperty ("path",   f.getFullPathName());
            const auto vendor = f.getParentDirectory() == root ? juce::String() : f.getParentDirectory().getFileName();
            o->setProperty ("vendor", vendor);
            items.add (juce::var (o.get()));
        }
        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        obj->setProperty ("event", "vst3_plugins");
        obj->setProperty ("items", items);
        ws.broadcast (juce::var (obj.get()));
    }

    void broadcastTransport()
    {
        bool loop = false; double ls = 0.0, le = 4.0;
        seq.getLoop (loop, ls, le);
        const double bpm = plugin.playHead.bpm.load();
        // Output latency in beats, so the UIs can draw the playhead where the
        // listener actually is rather than where we are rendering.
        double latencyBeats = 0.0;
        if (auto* dev = deviceManager.getCurrentAudioDevice())
            if (dev->getCurrentSampleRate() > 0.0)
                latencyBeats = dev->getOutputLatencyInSamples() / dev->getCurrentSampleRate() * bpm / 60.0;
        juce::DynamicObject::Ptr o = new juce::DynamicObject();
        o->setProperty ("event",        "transport");
        o->setProperty ("playing",      seq.isPlaying());
        o->setProperty ("beat",         seq.positionBeats());
        o->setProperty ("bpm",          bpm);
        o->setProperty ("tsNum",        (int) plugin.playHead.tsNum.load());
        o->setProperty ("loop",         loop);
        o->setProperty ("loopStart",    ls);
        o->setProperty ("loopEnd",      le);
        o->setProperty ("latencyBeats", latencyBeats);
        o->setProperty ("metro",        metroOn.load());
        o->setProperty ("notesFired",   (int) seqNotesFired.load());   // running count, for diagnostics
        ws.broadcast (juce::var (o.get()));
    }

    void loadPluginForPreset (const juce::String& presetId, const juce::File& file,
                              std::function<void()> onLoaded = {})
    {
        loadingPresetIds.addIfNotAlreadyThere (presetId);
        loading = ! loadingPresetIds.isEmpty();
        broadcastState();
        plugin.load (presetId, file,
            [this, presetId, path = file.getFullPathName(), onLoaded]
            (const juce::String& name, const juce::String& err)
            {
                loadingPresetIds.removeString (presetId);
                loading = ! loadingPresetIds.isEmpty();
                juce::DynamicObject::Ptr obj = new juce::DynamicObject();
                if (err.isNotEmpty())
                {
                    obj->setProperty ("event", "plugin_error");
                    obj->setProperty ("error", err);
                }
                else
                {
                    obj->setProperty ("event", "plugin_loaded");
                    obj->setProperty ("name",  name);
                    (void) name; // pluginName now derived from active preset's instance
                    // Make sure the preset's stored path matches what we loaded.
                    for (auto& p : settings.currentPresets())
                        if (p.id == presetId)
                        {
                            if (p.pluginPath != path) { p.pluginPath = path; settings.save(); }
                            plugin.setGain (presetId, p.volume);
                            break;
                        }
                    if (path != settings.pluginPath)
                    {
                        settings.pluginPath = path;
                        settings.save();
                    }
                    loadFxChainForPreset (presetId);
                    if (onLoaded) onLoaded();
                }
                ws.broadcast (juce::var (obj.get()));
                broadcastState();
            });
    }

    // Device-availability watcher. Re-scans periodically so the rail's
    // online/offline status, plugin auto-reconnect and clock-source detection
    // stay current when a device is plugged in or removed mid-session.
    juce::StringArray lastAvailableMidiIns;
    int               deviceScanCounter = 0;
    static constexpr int kDeviceScanEveryTicks = 60; // 30Hz timer → 2s

    // MIDI-clock derived tempo tracking.
    double lastClockMs = 0.0;
    double clockBpm    = 0.0;
    double clockPpq    = 0.0;
    bool   clockActive = false;
    int    clockTickCounter = 0;
    std::atomic<bool> beatPulseDue { false };
    // The sequencer owns transport + position; the play-head mirrors it.
    Sequencer         seq;
    juce::StringArray seqTargets;                 // instrument ids the current song uses (kept loaded)
    bool              lastTransportPlaying = false;
    double            lastTransportBeat    = -1.0;
    std::atomic<int>  seqNotesFired { 0 };

    // Engine metronome — clicks on each beat of the (chord-pad-driven) play-head,
    // mixed into our own audio output so it comes out the same interface (ASIO)
    // as the plugins. Toggled/leveled over the WS. Voice state is only touched
    // on the audio thread.
    std::atomic<bool>  metroOn   { false };
    std::atomic<float> metroGain { 0.35f };
    double metroPhase = 0.0;    // radians
    double metroEnv   = 0.0;    // 0..1 amplitude envelope
    double metroFreq  = 1000.0; // Hz (accent = higher)
    // One-shot click request (chord-pad's record count-in): 0 none, 1 normal,
    // 2 accent. Fires regardless of transport state so the pre-count is audible
    // out the interface before playback starts.
    std::atomic<int> pendingClick { 0 };
    juce::StringArray loggedClockBlocked;

    std::atomic<bool> bypassPlugin { false };
    bool loading = false;
    juce::StringArray loadingPresetIds;

    // Undo/redo via full Settings snapshots — small enough that the cost of
    // serialising on each mutation is negligible.
    std::vector<juce::String> undoStack, redoStack;
    static constexpr size_t kMaxUndo = 100;

    juce::String snapshot() const
    {
        // Reuse Settings.save() output by going through JSON.
        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        juce::Array<juce::var> setArr;
        for (auto& s : settings.sets)
        {
            juce::DynamicObject::Ptr so = new juce::DynamicObject();
            so->setProperty ("name", s.name);
            juce::Array<juce::var> presetArr;
            for (auto& p : s.presets)
            {
                juce::DynamicObject::Ptr po = new juce::DynamicObject();
                po->setProperty ("id",         p.id);
                po->setProperty ("name",       p.name);
                po->setProperty ("pluginPath", p.pluginPath);
                po->setProperty ("stateB64",   p.stateB64);
                juce::Array<juce::var> tagArr;
                for (auto& t : p.tags) tagArr.add (t);
                po->setProperty ("tags", tagArr);
                juce::Array<juce::var> presetInArr;
                for (auto& t : p.inputs) presetInArr.add (t);
                po->setProperty ("inputs", presetInArr);
                po->setProperty ("channelMask", (int) p.channelMask);
                juce::Array<juce::var> sidArr;
                for (auto& t : p.sourceIds) sidArr.add (t);
                po->setProperty ("sourceIds", sidArr);
                po->setProperty ("pinned",    p.pinned);
                po->setProperty ("volume",    (double) p.volume);
                po->setProperty ("fx",        Settings::fxToVar (p.fx));
                presetArr.add (juce::var (po.get()));
            }
            so->setProperty ("presets", presetArr);
            setArr.add (juce::var (so.get()));
        }
        obj->setProperty ("sets",       setArr);
        obj->setProperty ("currentSet", settings.currentSet);
        return juce::JSON::toString (juce::var (obj.get()), true);
    }

    void applySnapshot (const juce::String& json)
    {
        auto v = juce::JSON::parse (json);
        if (! v.isObject()) return;
        settings.sets.clear();
        if (auto* setArr = v.getProperty ("sets", juce::var()).getArray())
        {
            for (auto& s : *setArr)
            {
                Patchset ps;
                ps.name = s.getProperty ("name", "Untitled").toString();
                if (auto* a = s.getProperty ("presets", juce::var()).getArray())
                    for (auto& item : *a)
                    {
                        Preset p;
                        p.id         = item.getProperty ("id",         "").toString();
                        p.name       = item.getProperty ("name",       "").toString();
                        p.pluginPath = item.getProperty ("pluginPath", "").toString();
                        p.stateB64   = item.getProperty ("stateB64",   "").toString();
                        if (auto* tagArr = item.getProperty ("tags", juce::var()).getArray())
                            for (auto& t : *tagArr) p.tags.add (t.toString());
                        if (auto* inArr  = item.getProperty ("inputs", juce::var()).getArray())
                            for (auto& t : *inArr) p.inputs.add (t.toString());
                        p.channelMask = (juce::uint16) (int) item.getProperty ("channelMask", 0);
                        if (auto* sidArr = item.getProperty ("sourceIds", juce::var()).getArray())
                            for (auto& t : *sidArr) p.sourceIds.add (t.toString());
                        p.pinned = (bool) item.getProperty ("pinned", false);
                        p.volume = (float) (double) item.getProperty ("volume", 1.0);
                        Settings::fxFromVar (item.getProperty ("fx", juce::var()), p.fx);
                        if (p.id.isEmpty()) p.id = juce::Uuid().toString();
                        ps.presets.push_back (std::move (p));
                    }
                settings.sets.push_back (std::move (ps));
            }
        }
        settings.currentSet = juce::jlimit (0, (int) settings.sets.size() - 1,
                                            (int) v.getProperty ("currentSet", 0));
        currentPresetIndex = -1;
        bypassPlugin.store (true);
        settings.save();
    }

    void pushUndo()
    {
        undoStack.push_back (snapshot());
        if (undoStack.size() > kMaxUndo) undoStack.erase (undoStack.begin());
        redoStack.clear();
    }
    std::atomic<bool> midiInActivity  { false };
    std::atomic<bool> midiOutActivity { false };
    std::atomic<bool> kbOutActivity   { false };
    juce::CriticalSection presetActivityLock;
    juce::StringArray     pendingActivePresets;
    std::atomic<bool> gotFirstMidi    { false };
    double currentSampleRate = 44100.0;
    int    currentBlockSize  = 512;

    MidiManager        midi;
    WebSocketBridge    ws;
    HttpFileServer     http;
    StaticDirServer    chordPad;   // local http server for the chord-pad web app
    PluginHost         plugin;
    Settings           settings;
    int                currentPresetIndex = -1;
    std::unique_ptr<juce::FileChooser>          chooser;
    std::unique_ptr<juce::FileChooser>          projectChooser;   // save/open project
    std::unique_ptr<juce::WebBrowserComponent>  browser;
    TitleBar titleBar;                                          // custom caption + status + window buttons
};

class MainWindow : public juce::DocumentWindow
{
public:
    MainWindow()
        : juce::DocumentWindow ("Patchwork",
                                juce::Colour (0xff121212),
                                0)
    {
        setUsingNativeTitleBar (false);
        setTitleBarHeight (0);
        setResizable (true, false);
        setContentOwned (new MainComponent(), true);
        centreWithSize (1000, 760);
        setVisible (true);
    }

    void closeButtonPressed() override
    {
        juce::JUCEApplication::getInstance()->systemRequestedQuit();
    }
};

class MidiHostApp : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override    { return "Patchwork"; }
    const juce::String getApplicationVersion() override { return "0.2.0"; }

    void initialise (const juce::String&) override
    {
       #if JUCE_WINDOWS
        disableTimerResolutionBoost();
       #endif

        auto canvas = renderSplashImage ({});
        auto* s = new juce::SplashScreen ("Patchwork", canvas, true);
        gSplash = s;
        s->deleteAfterDelay (juce::RelativeTime::seconds (10), false);

        window = std::make_unique<MainWindow>();
    }
    void shutdown() override                       { dismissSplash(); window = nullptr; }

private:
    std::unique_ptr<MainWindow> window;
};

START_JUCE_APPLICATION (MidiHostApp)
