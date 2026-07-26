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

// Custom in-style title bar for the borderless window: app name, view tabs,
// and minimise / maximise / close. Dragging the empty caption hands off to the
// native move loop (WM_NCLBUTTONDOWN) so Windows drag + Aero Snap work; the
// maximise button "maximises" to the monitor work area (respects the taskbar).
class TitleBar : public juce::Component
{
public:
    std::function<void (int)> onTab;
    std::function<void ()>    onTransport;   // play/stop toggle → drives chord-pad
    juce::TextButton tabPatchwork { "Patchwork" }, tabChordPad { "chord-pad" };

    TitleBar()
    {
        setInterceptsMouseClicks (true, true);
        addAndMakeVisible (playBtn);
        playBtn.onClick = [this] { if (onTransport) onTransport(); };
        for (auto* t : { &tabPatchwork, &tabChordPad })
        {
            t->setClickingTogglesState (true);
            t->setRadioGroupId (100);
            t->setColour (juce::TextButton::buttonColourId,   juce::Colour (0x00000000));
            t->setColour (juce::TextButton::buttonOnColourId, juce::Colour (0xff23262c));
            t->setColour (juce::TextButton::textColourOffId,  juce::Colour (0xff8a8f98));
            t->setColour (juce::TextButton::textColourOnId,   juce::Colour (0xffffffff));
            addChildComponent (*t);
        }
        tabPatchwork.onClick = [this] { if (onTab) onTab (0); };
        tabChordPad .onClick = [this] { if (onTab) onTab (1); };

        for (auto* b : { &minBtn, &maxBtn, &closeBtn }) addAndMakeVisible (*b);
        minBtn.onClick   = [this] { nativeMinimise(); };
        maxBtn.onClick   = [this] { toggleMaximise(); };
        closeBtn.onClick = [] { juce::JUCEApplication::getInstance()->systemRequestedQuit(); };
    }

    void setTabsVisible (bool v) { tabsShown = v; tabPatchwork.setVisible (v); tabChordPad.setVisible (v); resized(); }
    void setActiveTab (int i)
    {
        tabPatchwork.setToggleState (i == 0, juce::dontSendNotification);
        tabChordPad .setToggleState (i == 1, juce::dontSendNotification);
    }

    // Shared engine status shown centre-right on both tabs (bar.beat + tempo).
    void setStatus (juce::String text, bool playing)
    {
        if (text == statusText && playing == statusPlaying) return;
        statusText = std::move (text); statusPlaying = playing;
        playBtn.playing = playing; playBtn.repaint();
        repaint();
    }

    void paint (juce::Graphics& g) override
    {
        g.fillAll (juce::Colour (0xff141619));
        g.setColour (juce::Colour (0x18ffffff));
        g.fillRect (0, getHeight() - 1, getWidth(), 1);
        g.setColour (juce::Colour (0xffc3c9d1));
        g.setFont (juce::Font (13.0f, juce::Font::bold));
        g.drawText ("Patchwork", 12, 0, 110, getHeight(), juce::Justification::centredLeft);

        // Shared engine status (bar.beat + tempo) with a play/stop dot, drawn
        // just left of the window buttons — visible on both tabs.
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
        playBtn.setBounds (getWidth() / 2 - 14, (getHeight() - 28) / 2, 28, 28);
        if (tabsShown)
        {
            auto tabs = r.withTrimmedLeft (100).reduced (0, 5);
            tabPatchwork.setBounds (tabs.removeFromLeft (118));
            tabs.removeFromLeft (4);
            tabChordPad.setBounds (tabs.removeFromLeft (118));
        }
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
    PlayButton playBtn;
    bool tabsShown = false, maximised = false;
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

        // Serve the chord-pad web app locally so it runs in a secure context
        // (Web MIDI) and can open a ws:// link to us without mixed-content
        // blocking. Default location: Desktop/chord-pad (override via
        // settings.chordPadDir). Optional — skipped silently if absent.
        {
            juce::File cpDir = settings.chordPadDir.isNotEmpty()
                ? juce::File (settings.chordPadDir)
                : juce::File::getSpecialLocation (juce::File::userDesktopDirectory)
                      .getChildFile ("chord-pad");
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

        // Custom in-style title bar (the window is borderless): app name, view
        // tabs, and window buttons. Handles drag + Aero Snap natively.
        titleBar.onTab = [this] (int t) { showTab (t); };
        titleBar.onTransport = [this]
        {
            // Play/stop from the title bar → ask chord-pad (the sequencer) to
            // toggle; it drives our play-head back over the link.
            juce::DynamicObject::Ptr o = new juce::DynamicObject();
            o->setProperty ("event",  "transport_request");
            o->setProperty ("action", "toggle");
            ws.broadcast (juce::var (o.get()));
        };
        addAndMakeVisible (titleBar);

        // Embed chord-pad as a second view in the same window (one app). Only
        // when its local server is up. The tabs switch between the two; both
        // stay loaded (withKeepPageLoadedWhenBrowserIsHidden) so chord-pad keeps
        // its WS link + transport while you're on the Patchwork tab.
        if (chordPad.isListening())
        {
            auto* cb = new Browser (opts);
            chordBrowser.reset (cb);
            addChildComponent (*chordBrowser);
            chordBrowser->goToURL ("http://127.0.0.1:" + juce::String (kChordPadPort) + "/chord-pad.html");
            titleBar.setTabsVisible (true);
            hasTabs = true;
        }
        showTab (0);

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
        cpLoadPersisted();            // chord-pad's per-track VSTs
        broadcastState();
    }

    // ---- Unified project (song + rack + routing) ------------------------
    // A project bundles Patchwork's settings (sets/presets/plugin state/sources
    // /tempo) with chord-pad's arrangement, fetched over the WS link. Patchwork
    // owns the file; chord-pad's half round-trips through get_project/load_project.
    void startProjectSave()
    {
        projectChooser = std::make_unique<juce::FileChooser> ("Save project", juce::File(), "*.pwproj");
        projectChooser->launchAsync (juce::FileBrowserComponent::saveMode
                                     | juce::FileBrowserComponent::canSelectFiles
                                     | juce::FileBrowserComponent::warnAboutOverwriting,
            [this] (const juce::FileChooser& fc)
            {
                auto f = fc.getResult();
                if (f == juce::File()) return;
                if (f.getFileExtension().isEmpty()) f = f.withFileExtension ("pwproj");
                settings.save();                    // flush current rack/routing to settings.json
                pendingSaveFile = f;
                juce::DynamicObject::Ptr req = new juce::DynamicObject();
                req->setProperty ("event", "get_project");
                ws.broadcast (juce::var (req.get()));   // chord-pad answers via project_data
                // Fallback: if chord-pad isn't linked, still save the Patchwork side.
                juce::Timer::callAfterDelay (1500, [this]
                {
                    if (pendingSaveFile == juce::File()) return;   // already completed
                    juce::DynamicObject::Ptr proj = new juce::DynamicObject();
                    proj->setProperty ("format", "patchwork-project");
                    proj->setProperty ("version", 1);
                    proj->setProperty ("patchwork", juce::JSON::parse (Settings::file()));
                    pendingSaveFile.replaceWithText (juce::JSON::toString (juce::var (proj.get()), true));
                    logToUi ("project saved (Patchwork only — chord-pad not linked): " + pendingSaveFile.getFullPathName());
                    pendingSaveFile = juce::File();
                });
            });
    }

    void startProjectOpen()
    {
        projectChooser = std::make_unique<juce::FileChooser> ("Open project", juce::File(), "*.pwproj;*.json");
        projectChooser->launchAsync (juce::FileBrowserComponent::openMode
                                     | juce::FileBrowserComponent::canSelectFiles,
            [this] (const juce::FileChooser& fc)
            {
                auto f = fc.getResult();
                if (! f.existsAsFile()) return;
                auto v = juce::JSON::parse (f);
                if (! v.isObject()) { logToUi ("not a valid project file"); return; }
                auto patchVar = v.getProperty ("patchwork", juce::var());
                if (patchVar.isObject())
                {
                    Settings::file().replaceWithText (juce::JSON::toString (patchVar, true));
                    plugin.unloadAll();
                    settings.load();
                    restoreFromSettings();
                }
                juce::DynamicObject::Ptr msg = new juce::DynamicObject();
                msg->setProperty ("event", "load_project");
                msg->setProperty ("data", v.getProperty ("chordpad", juce::var()));
                ws.broadcast (juce::var (msg.get()));   // chord-pad applies its half
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

        // When chord-pad is the transport master, advance the play-head's
        // ppqPosition ourselves so hosted plugins (arps, tempo-synced FX)
        // keep running between the sparse transport messages over the WS.
        const bool   advancing = wsClockMaster.load() && plugin.playHead.isPlaying.load() && sr > 0.0;
        const double startPpq  = plugin.playHead.ppqPosition.load();
        const double bps       = plugin.playHead.bpm.load() / 60.0 / (sr > 0.0 ? sr : 44100.0);
        if (advancing)
            plugin.playHead.ppqPosition.store (startPpq + bps * n);

        // Collect metronome click onsets that fall inside this block (half-open
        // [startPpq, endPpq) so a beat on a block boundary fires exactly once).
        std::array<std::pair<int, bool>, 8> clicks;   // {sampleOffset, accent}
        int clickCount = 0;
        if (metroOn.load() && advancing && bps > 0.0)
        {
            const int    tsNum  = juce::jmax (1, (int) plugin.playHead.tsNum.load());
            const double endPpq = startPpq + bps * n;
            for (long long b = (long long) std::ceil (startPpq); b < (long long) std::ceil (endPpq); ++b)
            {
                int off = (int) std::llround ((b - startPpq) / bps);
                off = juce::jlimit (0, n - 1, off);
                clicks[(size_t) clickCount] = { off, (b % tsNum) == 0 };
                if (++clickCount >= (int) clicks.size()) break;
            }
        }

        info.clearActiveBufferRegion();
        juce::AudioBuffer<float> slice (info.buffer->getArrayOfWritePointers(),
                                        info.buffer->getNumChannels(),
                                        info.startSample,
                                        n);
        plugin.process (slice, n);

        // One-shot count-in click (fires even when transport isn't playing).
        const int pc = pendingClick.exchange (0);
        if (pc != 0) { metroEnv = 1.0; metroPhase = 0.0; metroFreq = (pc == 2 ? 1600.0 : 1000.0); }

        renderMetronome (slice, n, clicks, clickCount);
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

    void paint (juce::Graphics& g) override { g.fillAll (juce::Colour (0xff0d0e10)); }

    void resized() override
    {
        auto r = getLocalBounds();
        titleBar.setBounds (r.removeFromTop (34));   // custom title bar / caption
        if (browser      != nullptr) browser->setBounds (r);
        if (chordBrowser != nullptr) chordBrowser->setBounds (r);
    }

    // Switch the embedded view. Both browsers stay loaded; we only toggle
    // visibility so chord-pad keeps its WS link while you're on Patchwork.
    void showTab (int tab)
    {
        activeTab = tab;
        if (browser      != nullptr) browser->setVisible (tab == 0);
        if (chordBrowser != nullptr) chordBrowser->setVisible (tab == 1);
        titleBar.setActiveTab (tab);
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
        // chord-pad (over the WS) wins over external MIDI clock while linked.
        if (wsClockMaster.load()) return;
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
            clockPpq += 1.0 / 24.0;
            plugin.playHead.ppqPosition.store (clockPpq);
            clockActive = true;
            if (++clockTickCounter >= 24) { clockTickCounter = 0; beatPulseDue.store (true); }
        }
        else if (m.isMidiStart() || m.isMidiContinue())
        {
            plugin.playHead.isPlaying.store (true);
            if (m.isMidiStart()) { clockPpq = 0.0; plugin.playHead.ppqPosition.store (0.0); }
        }
        else if (m.isMidiStop())
        {
            plugin.playHead.isPlaying.store (false);
        }
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
        // Shared engine status in the title bar (bar.beat + tempo), visible on
        // both tabs so the two apps read as one.
        {
            const bool   playing = plugin.playHead.isPlaying.load();
            const double bpm     = plugin.playHead.bpm.load();
            const double ppq     = plugin.playHead.ppqPosition.load();
            const int    tsN     = juce::jmax (1, (int) plugin.playHead.tsNum.load());
            juce::String s;
            if (playing)
            {
                const int bar  = (int) std::floor (ppq / tsN) + 1;
                const int beat = (int) std::floor (std::fmod (ppq, (double) tsN)) + 1;
                s << bar << "." << beat << "   ";
            }
            s << juce::String (juce::roundToInt (bpm)) << " BPM";
            titleBar.setStatus (s, playing);
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
            plugin.playHead.isPlaying.store (false);
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
        if (cmd != "kb_note" && cmd != "transport")
            logToUi ("ws cmd: " + cmd);

        // ---- chord-pad link (private handshake + transport) --------------
        if (cmd == "hello")
        {
            const auto role = v.getProperty ("role", "").toString();
            const int  ver  = (int) v.getProperty ("version", 0);
            if (role == "chordpad")
            {
                logToUi ("chord-pad linked (v" + juce::String (ver) + ")");
                juce::DynamicObject::Ptr ack = new juce::DynamicObject();
                ack->setProperty ("event",   "chordpad_ack");
                ack->setProperty ("engine",  "midi-host");
                ack->setProperty ("version", 1);
                ws.broadcast (juce::var (ack.get()));
                juce::MessageManager::callAsync ([this] { broadcastState(); broadcastCpState(); });
            }
            return;
        }
        else if (cmd == "transport")
        {
            const bool   playing = (bool)   v.getProperty ("playing", false);
            const double beat    = (double) v.getProperty ("beat", 0.0);
            const bool   hasBpm  = v.hasProperty ("bpm");
            const double bpm     = (double) v.getProperty ("bpm", 0.0);
            wsClockMaster.store (true);
            if (hasBpm && bpm > 0.0) plugin.playHead.bpm.store (bpm);
            if (playing) plugin.playHead.ppqPosition.store (beat);
            plugin.playHead.isPlaying.store (playing);
            return;
        }
        else if (cmd == "unlink_transport")
        {
            // chord-pad hands transport back (e.g. on disconnect / standalone).
            wsClockMaster.store (false);
            plugin.playHead.isPlaying.store (false);
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
        else if (cmd == "cp_set_vst")
        {
            const int  channel = (int) v.getProperty ("channel", 1);
            const auto path    = v.getProperty ("path", "").toString();
            const auto name    = v.getProperty ("name", "").toString();
            juce::MessageManager::callAsync ([this, channel, path, name] { cpSetVst (channel, juce::File (path), name); });
            return;
        }
        else if (cmd == "cp_clear_vst")
        {
            const int channel = (int) v.getProperty ("channel", 1);
            juce::MessageManager::callAsync ([this, channel] { cpClearVst (channel); });
            return;
        }
        else if (cmd == "list_cp_vsts")
        {
            juce::MessageManager::callAsync ([this] { broadcastCpState(); });
            return;
        }
        else if (cmd == "cp_open_editor")
        {
            const int channel = (int) v.getProperty ("channel", 1);
            juce::MessageManager::callAsync ([this, channel] { plugin.showEditor (cpVstId (juce::jlimit (1, 16, channel))); });
            return;
        }
        else if (cmd == "route_channel")
        {
            // chord-pad routing: map a track channel to a plugin by managing a
            // per-channel virtual "chord-pad" source and its preset assignment.
            const int  channel  = juce::jlimit (1, 16, (int) v.getProperty ("channel", 1));
            const auto presetId = v.getProperty ("presetId", "").toString();
            const bool on       = (bool) v.getProperty ("on", true);
            juce::MessageManager::callAsync ([this, channel, presetId, on]
            {
                pushUndo();
                const juce::uint16 mask = (juce::uint16) (1u << (channel - 1));
                juce::String srcId;
                for (auto& s : settings.sources)
                    if (s.deviceName == MidiManager::kChordPadInput && s.channelMask == mask) { srcId = s.id; break; }
                if (srcId.isEmpty())
                {
                    Source s;
                    s.id          = juce::Uuid().toString();
                    s.deviceName  = MidiManager::kChordPadInput;
                    s.label       = "chord-pad ch" + juce::String (channel);
                    s.icon        = "music";
                    s.channelMask = mask;
                    srcId = s.id;
                    settings.sources.push_back (std::move (s));
                }
                for (auto& set : settings.sets)
                    for (auto& pr : set.presets)
                        if (pr.id == presetId)
                        {
                            if (on) { if (! pr.sourceIds.contains (srcId)) pr.sourceIds.add (srcId); }
                            else    { pr.sourceIds.removeString (srcId); sendPanic (pr.id); }
                        }
                settings.save();
                broadcastState();
            });
            return;
        }
        else if (cmd == "set_channel_target")
        {
            // Exclusive routing: a track channel plays exactly one plugin (or
            // none). Ensures the per-channel chord-pad source, then assigns it
            // to only the target preset. Powers chord-pad's per-track VST picker.
            const int  channel  = juce::jlimit (1, 16, (int) v.getProperty ("channel", 1));
            const auto presetId = v.getProperty ("presetId", "").toString();   // empty = none
            juce::MessageManager::callAsync ([this, channel, presetId]
            {
                pushUndo();
                const juce::uint16 mask = (juce::uint16) (1u << (channel - 1));
                juce::String srcId;
                for (auto& s : settings.sources)
                    if (s.deviceName == MidiManager::kChordPadInput && s.channelMask == mask) { srcId = s.id; break; }
                if (srcId.isEmpty())
                {
                    Source s;
                    s.id = juce::Uuid().toString(); s.deviceName = MidiManager::kChordPadInput;
                    s.label = "chord-pad ch" + juce::String (channel); s.icon = "music"; s.channelMask = mask;
                    srcId = s.id; settings.sources.push_back (std::move (s));
                }
                for (auto& set : settings.sets)
                    for (auto& pr : set.presets)
                    {
                        const bool had = pr.sourceIds.contains (srcId);
                        if (pr.id == presetId) { if (! had) pr.sourceIds.add (srcId); }
                        else if (had)          { pr.sourceIds.removeString (srcId); sendPanic (pr.id); }
                    }
                settings.save();
                broadcastState();
            });
            return;
        }
        else if (cmd == "project_save") { juce::MessageManager::callAsync ([this] { startProjectSave(); }); return; }
        else if (cmd == "project_open") { juce::MessageManager::callAsync ([this] { startProjectOpen(); }); return; }
        else if (cmd == "project_data")
        {
            // chord-pad's answer to our get_project request — complete the save.
            if (pendingSaveFile != juce::File())
            {
                auto chordVar = v.getProperty ("data", juce::var());
                juce::var patchVar = juce::JSON::parse (Settings::file());
                juce::DynamicObject::Ptr proj = new juce::DynamicObject();
                proj->setProperty ("format",    "patchwork-project");
                proj->setProperty ("version",   1);
                proj->setProperty ("patchwork", patchVar);
                proj->setProperty ("chordpad",  chordVar);
                const auto ok = pendingSaveFile.replaceWithText (juce::JSON::toString (juce::var (proj.get()), true));
                logToUi (ok ? ("project saved: " + pendingSaveFile.getFullPathName())
                            : ("project save FAILED: " + pendingSaveFile.getFullPathName()));
                pendingSaveFile = juce::File();
            }
            return;
        }

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
            // chord-pad note over the link. The note carries its track channel
            // (1-16). Primary model: each channel plays chord-pad's own always-on
            // VST (cp-ch{n}). If none is set for the channel, fall back to any
            // live Patchwork plugin so it still sounds.
            const int  note = juce::jlimit (0, 127, (int) v.getProperty ("note", 60));
            const int  vel  = juce::jlimit (0, 127, (int) v.getProperty ("vel",  100));
            const bool on   = (bool) v.getProperty ("on", true);
            const int  ch   = juce::jlimit (1, 16, (int) v.getProperty ("ch", 1));
            auto m = (on && vel > 0) ? juce::MidiMessage::noteOn  (ch, note, (juce::uint8) vel)
                                     : juce::MidiMessage::noteOff (ch, note);

            const auto cpId = cpVstId (ch);
            if (plugin.has (cpId))
            {
                plugin.queueMidi (cpId, m);                // chord-pad's own VST for this channel
            }
            else
            {
                for (auto& p : settings.currentPresets())  // fallback: any live plugin
                    if (plugin.has (p.id))
                        plugin.queueMidi (p.id, m);
            }
            midiInActivity.store (true);
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

        ws.broadcast (juce::var (obj.get()));
    }

    void broadcastArturiaPlugins()
    {
        const juce::File vstDir ("C:\\Program Files\\Common Files\\VST3\\Arturia");

        juce::Array<juce::var> items;
        if (vstDir.isDirectory())
        {
            auto files = vstDir.findChildFiles (juce::File::findFilesAndDirectories, false, "*.vst3");
            files.sort();
            for (auto& f : files)
            {
                const auto name = f.getFileNameWithoutExtension();

                juce::DynamicObject::Ptr o = new juce::DynamicObject();
                o->setProperty ("name", name);
                o->setProperty ("path", f.getFullPathName());
                o->setProperty ("iconUrl", "/arturia-icon/" + juce::URL::addEscapeChars (name, false));
                items.add (juce::var (o.get()));
            }
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

    // ---- chord-pad VST hosting (per channel, always active) --------------
    static juce::String cpVstId (int channel) { return "cp-ch" + juce::String (channel); }

    void cpSetVst (int channel, const juce::File& file, const juce::String& name)
    {
        channel = juce::jlimit (1, 16, channel);
        const auto id = cpVstId (channel);
        plugin.unload (id);
        if (! file.exists())
        {
            settings.cpVstPath[channel] = {}; settings.cpVstName[channel] = {};
            settings.save(); broadcastCpState(); return;
        }
        settings.cpVstPath[channel] = file.getFullPathName();
        settings.cpVstName[channel] = name;
        settings.save();
        plugin.load (id, file, [this, channel] (const juce::String&, const juce::String& err)
        {
            if (err.isNotEmpty()) logToUi ("chord-pad VST ch" + juce::String (channel) + " load failed: " + err);
            broadcastCpState();
        });
        broadcastCpState();
    }

    void cpClearVst (int channel)
    {
        channel = juce::jlimit (1, 16, channel);
        plugin.unload (cpVstId (channel));
        settings.cpVstPath[channel] = {}; settings.cpVstName[channel] = {};
        settings.save();
        broadcastCpState();
    }

    // Load the persisted chord-pad VSTs (called on startup).
    void cpLoadPersisted()
    {
        for (int ch = 1; ch <= 16; ++ch)
        {
            juce::File f (settings.cpVstPath[ch]);
            if (settings.cpVstPath[ch].isNotEmpty() && f.exists())
                plugin.load (cpVstId (ch), f, [this] (const juce::String&, const juce::String&) { broadcastCpState(); });
        }
    }

    void broadcastCpState()
    {
        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        obj->setProperty ("event", "cp_state");
        juce::DynamicObject::Ptr chans = new juce::DynamicObject();
        for (int ch = 1; ch <= 16; ++ch)
            if (settings.cpVstPath[ch].isNotEmpty())
            {
                juce::DynamicObject::Ptr c = new juce::DynamicObject();
                c->setProperty ("name",   settings.cpVstName[ch]);
                c->setProperty ("path",   settings.cpVstPath[ch]);
                c->setProperty ("loaded", plugin.has (cpVstId (ch)));
                chans->setProperty (juce::String (ch), juce::var (c.get()));
            }
        obj->setProperty ("channels", juce::var (chans.get()));
        ws.broadcast (juce::var (obj.get()));
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
    // chord-pad transport link: when true, chord-pad drives the play-head over
    // the WebSocket and we free-run ppqPosition in the audio callback. Takes
    // precedence over incoming MIDI clock so the two never fight.
    std::atomic<bool> wsClockMaster { false };

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

    // chord-pad's own VST hosting: one always-on plugin per channel (1-16),
    // hosted in PluginHost under instance id "cp-ch{n}", independent of
    // Patchwork's presets/sets/pins. The per-channel path/name persist in
    // Settings (settings.cpVstPath/cpVstName).
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
    juce::File                                  pendingSaveFile;  // awaiting chord-pad's data
    std::unique_ptr<juce::WebBrowserComponent>  browser;
    std::unique_ptr<juce::WebBrowserComponent>  chordBrowser;   // embedded chord-pad
    TitleBar titleBar;                                          // custom caption + tabs + window buttons
    bool hasTabs  = false;
    int  activeTab = 0;
};

class MainWindow : public juce::DocumentWindow
{
public:
    MainWindow()
        : juce::DocumentWindow ("Patchwork",
                                juce::Colour (0xff0d0e10),
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
