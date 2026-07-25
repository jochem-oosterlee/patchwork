// Hosts multiple VST3 plugin instances simultaneously, keyed by a string id
// (typically the preset id). The audio thread sums the output of all loaded
// instances into the master buffer.

#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include <functional>
#include <memory>
#include <map>

class PluginEditorWindow : public juce::DocumentWindow
{
public:
    PluginEditorWindow (const juce::String& title, juce::AudioProcessorEditor* editor)
        : DocumentWindow (title, juce::Colours::darkgrey, DocumentWindow::closeButton)
    {
        setUsingNativeTitleBar (true);
        setContentOwned (editor, true);
        setResizable (editor->isResizable(), false);
        centreWithSize (editor->getWidth(), editor->getHeight());
        setVisible (true);
    }

    void closeButtonPressed() override { setVisible (false); }
};

// Host-side play head. All loaded plugins share this so they pick up the
// same tempo (manual or, later, derived from incoming MIDI clock).
class HostPlayHead : public juce::AudioPlayHead
{
public:
    std::atomic<double> bpm         { 120.0 };
    std::atomic<bool>   isPlaying   { false };
    std::atomic<double> ppqPosition { 0.0 };
    std::atomic<int>    tsNum       { 4 };
    std::atomic<int>    tsDen       { 4 };

    juce::Optional<PositionInfo> getPosition() const override
    {
        PositionInfo info;
        info.setBpm (bpm.load());
        info.setIsPlaying (isPlaying.load());
        info.setPpqPosition (ppqPosition.load());
        info.setTimeSignature (TimeSignature { tsNum.load(), tsDen.load() });
        return info;
    }
};

struct LiveInstance
{
    std::unique_ptr<juce::AudioPluginInstance> instance;
    std::unique_ptr<PluginEditorWindow>        editor;
    juce::MidiMessageCollector                 collector;
    std::atomic<float>                         gain        { 1.0f };
    std::atomic<float>                         outputLevel { 0.0f }; // peak abs of last block
    std::atomic<bool>                          broken      { false }; // produced NaN / threw
};

class PluginHost
{
public:
    using LoadedCallback = std::function<void (const juce::String& name, const juce::String& error)>;

    PluginHost() { formats.addDefaultFormats(); }

    HostPlayHead playHead;

    void prepare (double sampleRate, int blockSize)
    {
        const juce::ScopedLock sl (lock);
        currentSR    = sampleRate;
        currentBlock = blockSize;
        for (auto& [id, lp] : live)
        {
            lp->collector.reset (sampleRate);
            if (lp->instance)
            {
                lp->instance->setPlayConfigDetails (0, 2, sampleRate, blockSize);
                lp->instance->prepareToPlay (sampleRate, blockSize);
            }
        }
    }

    // Returns true if at least one instance contributed audio.
    bool process (juce::AudioBuffer<float>& outBuf, int numSamples)
    {
        const juce::ScopedLock sl (lock);
        if (live.empty()) return false;

        const int numCh = outBuf.getNumChannels();
        juce::AudioBuffer<float> temp (numCh, numSamples);

        for (auto& [id, lp] : live)
        {
            if (! lp->instance) continue;
            juce::MidiBuffer midi;
            lp->collector.removeNextBlockOfMessages (midi, numSamples);
            if (lp->broken.load()) continue; // wait for message-thread to reload
            temp.clear();
            try { lp->instance->processBlock (temp, midi); }
            catch (...) { lp->broken.store (true); continue; }

            const float g = lp->gain.load();
            float peak = 0.0f;
            bool  nan  = false;
            for (int ch = 0; ch < numCh; ++ch)
            {
                const float chPeak = temp.getMagnitude (ch, 0, numSamples);
                if (! std::isfinite (chPeak)) { nan = true; break; }
                const float lvl = chPeak * g;
                if (lvl > peak) peak = lvl;
            }
            if (nan) { lp->broken.store (true); continue; }
            lp->outputLevel.store (peak);
            if (g <= 0.0001f) continue;
            for (int ch = 0; ch < numCh; ++ch)
                outBuf.addFrom (ch, 0, temp, ch, 0, numSamples, g);
        }
        return true;
    }

    // Audio-thread: deliver a MIDI message to a specific preset's collector.
    void queueMidi (const juce::String& presetId, const juce::MidiMessage& m)
    {
        const juce::ScopedLock sl (lock);
        auto it = live.find (presetId);
        if (it != live.end() && it->second != nullptr)
            it->second->collector.addMessageToQueue (m);
    }

    juce::StringArray liveIds() const
    {
        const juce::ScopedLock sl (lock);
        juce::StringArray ids;
        for (auto& [id, _] : live) ids.add (id);
        return ids;
    }

    bool has (const juce::String& presetId) const
    {
        const juce::ScopedLock sl (lock);
        return live.find (presetId) != live.end();
    }

    std::function<void(const juce::String&)> logger;

    // Load (or replace) a plugin under the given preset id. Async.
    void load (const juce::String& presetId, const juce::File& file, LoadedCallback cb)
    {
        jassert (juce::MessageManager::existsAndIsCurrentThread());
        auto log = [this] (const juce::String& s) { if (logger) logger (s); };
        log ("PluginHost::load[" + presetId + "] " + file.getFullPathName());

        juce::OwnedArray<juce::PluginDescription> descs;
        juce::KnownPluginList list;
        for (int i = 0; i < formats.getNumFormats(); ++i)
            list.scanAndAddFile (file.getFullPathName(), false, descs, *formats.getFormat (i));

        if (descs.isEmpty()) { cb ({}, "no plugin found in file"); return; }

        const double sr = currentSR;
        const int    bs = currentBlock;

        formats.createPluginInstanceAsync (*descs.getFirst(), sr, bs,
            [this, presetId, cb, sr, bs, log] (std::unique_ptr<juce::AudioPluginInstance> inst, const juce::String& err)
            {
                if (inst == nullptr)
                {
                    cb ({}, err.isEmpty() ? "load failed" : err);
                    return;
                }
                inst->setPlayConfigDetails (0, 2, sr, bs);
                inst->prepareToPlay (sr, bs);
                inst->setPlayHead (&playHead);

                auto lp = std::make_unique<LiveInstance>();
                lp->collector.reset (sr);
                lp->instance = std::move (inst);
                const auto name = lp->instance->getName();
                {
                    const juce::ScopedLock sl (lock);
                    live[presetId] = std::move (lp);
                }
                cb (name, {});
            });
    }

    void unload (const juce::String& presetId)
    {
        jassert (juce::MessageManager::existsAndIsCurrentThread());
        std::unique_ptr<LiveInstance> doomed;
        {
            const juce::ScopedLock sl (lock);
            auto it = live.find (presetId);
            if (it == live.end()) return;
            doomed = std::move (it->second);
            live.erase (it);
        }
        if (doomed) doomed->editor.reset();
        // doomed dtor runs here, off the audio thread.
    }

    void showEditor (const juce::String& presetId)
    {
        jassert (juce::MessageManager::existsAndIsCurrentThread());
        LiveInstance* lp = nullptr;
        {
            const juce::ScopedLock sl (lock);
            auto it = live.find (presetId);
            if (it == live.end()) return;
            lp = it->second.get();
        }
        if (lp == nullptr || lp->instance == nullptr) return;
        if (lp->editor != nullptr)
        {
            lp->editor->setVisible (true);
            lp->editor->toFront (true);
            return;
        }
        auto* ed = lp->instance->createEditorIfNeeded();
        if (ed != nullptr)
            lp->editor = std::make_unique<PluginEditorWindow> (lp->instance->getName(), ed);
    }

    juce::String getStateBase64 (const juce::String& presetId)
    {
        const juce::ScopedLock sl (lock);
        auto it = live.find (presetId);
        if (it == live.end() || it->second->instance == nullptr) return {};
        juce::MemoryBlock mb;
        it->second->instance->getStateInformation (mb);
        return mb.toBase64Encoding();
    }

    void applyStateBase64 (const juce::String& presetId, const juce::String& b64)
    {
        const juce::ScopedLock sl (lock);
        auto it = live.find (presetId);
        if (it == live.end() || it->second->instance == nullptr || b64.isEmpty()) return;
        juce::MemoryBlock mb;
        if (mb.fromBase64Encoding (b64))
            it->second->instance->setStateInformation (mb.getData(), (int) mb.getSize());
    }

    // Take a snapshot of peak levels for all live instances and reset them
    // to zero so the meter naturally decays between calls.
    juce::StringArray takeBrokenIds()
    {
        const juce::ScopedLock sl (lock);
        juce::StringArray ids;
        for (auto& [id, lp] : live)
            if (lp && lp->broken.exchange (false)) ids.add (id);
        return ids;
    }

    std::vector<std::pair<juce::String, float>> takeAndClearLevels()
    {
        const juce::ScopedLock sl (lock);
        std::vector<std::pair<juce::String, float>> out;
        out.reserve (live.size());
        for (auto& [id, lp] : live)
            if (lp) out.emplace_back (id, lp->outputLevel.exchange (0.0f));
        return out;
    }

    void setGain (const juce::String& presetId, float gain)
    {
        const juce::ScopedLock sl (lock);
        auto it = live.find (presetId);
        if (it != live.end() && it->second) it->second->gain.store (gain);
    }

    juce::String getInstanceName (const juce::String& presetId) const
    {
        const juce::ScopedLock sl (lock);
        auto it = live.find (presetId);
        return (it != live.end() && it->second->instance) ? it->second->instance->getName() : juce::String();
    }

    void close()
    {
        std::vector<std::unique_ptr<LiveInstance>> doomed;
        {
            const juce::ScopedLock sl (lock);
            for (auto& [id, lp] : live) doomed.push_back (std::move (lp));
            live.clear();
        }
        for (auto& d : doomed) if (d) d->editor.reset();
    }

    ~PluginHost() { close(); }

private:
    juce::AudioPluginFormatManager formats;
    mutable juce::CriticalSection  lock;
    std::map<juce::String, std::unique_ptr<LiveInstance>> live;
    double currentSR    = 44100.0;
    int    currentBlock = 512;
};
