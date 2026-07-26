// Persisted settings — a single JSON file at %APPDATA%/MidiHost/settings.json.

#pragma once

#include <juce_core/juce_core.h>

// A configured MIDI source — wraps a physical input device with a user-chosen
// label/icon and an optional channel filter. Lives globally (not per-patchset).
struct Source
{
    juce::String id;                   // stable identifier
    juce::String deviceName;           // matches juce::MidiInput device name
    juce::String label;                // display name (defaults to deviceName)
    juce::String icon = "music";       // lucide icon name
    juce::uint16 channelMask = 0;      // 0 = any channel
    bool         isClockSource = false; // MIDI clock from this source drives tempo
};

struct Preset
{
    juce::String          id;            // stable identifier across renames/reorders
    juce::String          name;
    juce::String          pluginPath;
    juce::String          stateB64;
    juce::StringArray     tags;
    juce::StringArray     inputs;        // legacy
    juce::uint16          channelMask = 0; // legacy
    juce::StringArray     sourceIds;     // empty = accept all (uses default if any)
    bool                  pinned = false; // stays loaded when another preset is selected
    float                 volume = 1.0f;  // linear gain, 0 = mute, 1 = unity, up to 1.5
};

// A Patchset groups a collection of presets that belong together (one song,
// one scene, one rehearsal block, …). Preset 00 "MIDI thru" is implicit and
// the same across every set, so it is not stored here.
struct Patchset
{
    juce::String         name;
    std::vector<Preset>  presets;
    bool                 archived  = false;
    juce::int64          createdMs = 0;   // creation time
    juce::int64          updatedMs = 0;   // last modification
    juce::String         notes;           // free-form note per patchset
};

class Settings
{
public:
    juce::String           audioXml;
    juce::StringArray      enabledDevices; // devices kept open (MIDI settings checkboxes)
    double                 bpm = 120.0;     // manual fallback tempo
    bool                   followMidiClock = true; // when true and clock is present, override manual BPM
    int                    tsNumerator   = 4;
    int                    tsDenominator = 4;
    std::vector<Source>    sources;        // user-defined source pills (rail)
    juce::String           defaultSourceId;
    juce::String           midiOut;
    juce::StringArray      thruInputs;       // legacy
    juce::uint16           thruChannelMask = 0;  // legacy
    juce::StringArray      thruSourceIds;    // empty = uses default (or silent)
    juce::String           kbOut;
    juce::String           pluginPath;
    juce::String           chordPadDir;      // optional override for the chord-pad web-app folder to serve
    // chord-pad's per-channel VSTs (index 1..16) — one always-on plugin per
    // track, persisted so they survive restarts and travel in projects.
    juce::String           cpVstPath[17];
    juce::String           cpVstName[17];
    std::vector<Patchset>  sets;
    int                    currentSet = 0;

    // Convenience — never returns null; lazily inserts a default set when
    // the user wipes them all.
    Patchset& current()
    {
        if (sets.empty()) sets.push_back ({ "Default", {} });
        currentSet = juce::jlimit (0, (int) sets.size() - 1, currentSet);
        return sets[(size_t) currentSet];
    }
    std::vector<Preset>& currentPresets() { return current().presets; }
    const std::vector<Preset>& currentPresets() const
    {
        static const std::vector<Preset> empty;
        if (sets.empty()) return empty;
        const int idx = juce::jlimit (0, (int) sets.size() - 1, currentSet);
        return sets[(size_t) idx].presets;
    }

    static juce::File file()
    {
        auto dir = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                       .getChildFile ("MidiHost");
        dir.createDirectory();
        return dir.getChildFile ("settings.json");
    }

    void load()
    {
        auto f = file();
        if (! f.existsAsFile()) return;
        auto v = juce::JSON::parse (f);
        if (! v.isObject()) return;
        audioXml   = v.getProperty ("audioXml",   "").toString();
        enabledDevices.clear();
        if (auto* arr = v.getProperty ("enabledDevices", juce::var()).getArray())
            for (auto& it : *arr) enabledDevices.add (it.toString());
        else if (auto* a = v.getProperty ("midiIns", juce::var()).getArray())
            for (auto& it : *a) enabledDevices.add (it.toString());
        else if (v.hasProperty ("midiIn"))
            enabledDevices.add (v.getProperty ("midiIn", "").toString());

        defaultSourceId = v.getProperty ("defaultSourceId", "").toString();
        bpm = (double) v.getProperty ("bpm", 120.0);
        followMidiClock = (bool) v.getProperty ("followMidiClock", true);
        tsNumerator   = (int) v.getProperty ("tsNumerator",   4);
        tsDenominator = (int) v.getProperty ("tsDenominator", 4);
        sources.clear();
        if (auto* arr = v.getProperty ("sources", juce::var()).getArray())
        {
            for (auto& it : *arr)
            {
                Source s;
                s.id          = it.getProperty ("id",         "").toString();
                s.deviceName  = it.getProperty ("deviceName", "").toString();
                s.label       = it.getProperty ("label",      s.deviceName).toString();
                s.icon        = it.getProperty ("icon",       "music").toString();
                s.channelMask    = (juce::uint16) (int) it.getProperty ("channelMask", 0);
                s.isClockSource  = (bool) it.getProperty ("isClockSource", false);
                if (s.id.isEmpty()) s.id = juce::Uuid().toString();
                sources.push_back (std::move (s));
            }
        }
        else
        {
            // First-run migration: one default source per legacy enabled device.
            for (auto& name : enabledDevices)
            {
                if (name.isEmpty()) continue;
                Source s;
                s.id         = juce::Uuid().toString();
                s.deviceName = name;
                s.label      = name;
                sources.push_back (std::move (s));
            }
        }
        midiOut    = v.getProperty ("midiOut",    "").toString();
        thruInputs.clear();
        if (auto* arr = v.getProperty ("thruInputs", juce::var()).getArray())
            for (auto& it : *arr) thruInputs.add (it.toString());
        thruChannelMask = (juce::uint16) (int) v.getProperty ("thruChannelMask", 0);
        thruSourceIds.clear();
        if (auto* a = v.getProperty ("thruSourceIds", juce::var()).getArray())
            for (auto& it : *a) thruSourceIds.add (it.toString());
        kbOut      = v.getProperty ("kbOut",      "").toString();
        pluginPath = v.getProperty ("pluginPath", "").toString();
        chordPadDir = v.getProperty ("chordPadDir", "").toString();
        for (int ch = 0; ch <= 16; ++ch) { cpVstPath[ch] = {}; cpVstName[ch] = {}; }
        if (auto* cp = v.getProperty ("cpVsts", juce::var()).getDynamicObject())
            for (int ch = 1; ch <= 16; ++ch)
            {
                auto c = cp->getProperty (juce::String (ch));
                if (c.isObject())
                {
                    cpVstPath[ch] = c.getProperty ("path", "").toString();
                    cpVstName[ch] = c.getProperty ("name", "").toString();
                }
            }
        sets.clear();
        currentSet = (int) v.getProperty ("currentSet", 0);

        auto readPresets = [] (const juce::var& arr, std::vector<Preset>& out)
        {
            if (auto* a = arr.getArray())
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
                    out.push_back (std::move (p));
                }
        };

        if (auto* setArr = v.getProperty ("sets", juce::var()).getArray())
        {
            for (auto& s : *setArr)
            {
                Patchset ps;
                ps.name      = s.getProperty ("name", "Untitled").toString();
                ps.archived  = (bool) s.getProperty ("archived", false);
                ps.createdMs = (juce::int64) (double) s.getProperty ("createdMs", 0);
                ps.updatedMs = (juce::int64) (double) s.getProperty ("updatedMs", 0);
                ps.notes     = s.getProperty ("notes", "").toString();
                readPresets (s.getProperty ("presets", juce::var()), ps.presets);
                if (ps.createdMs == 0) ps.createdMs = juce::Time::currentTimeMillis();
                sets.push_back (std::move (ps));
            }
        }
        else if (v.hasProperty ("presets"))
        {
            // Legacy single-list format — migrate into one default patchset.
            Patchset ps;
            ps.name = "Default";
            readPresets (v.getProperty ("presets", juce::var()), ps.presets);
            sets.push_back (std::move (ps));
        }

        if (sets.empty()) sets.push_back ({ "Default", {} });
        currentSet = juce::jlimit (0, (int) sets.size() - 1, currentSet);

        // Persist any migrations (e.g. fresh uuids assigned to legacy data) so
        // subsequent loads don't drift. Stale source-id references are kept
        // intact so the UI can still flag them as "missing source".
        save();
    }

    void save() const
    {
        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        obj->setProperty ("audioXml",   audioXml);
        juce::Array<juce::var> enArr;
        for (auto& n : enabledDevices) enArr.add (n);
        obj->setProperty ("enabledDevices", enArr);

        juce::Array<juce::var> srcArr;
        for (auto& s : sources)
        {
            juce::DynamicObject::Ptr so = new juce::DynamicObject();
            so->setProperty ("id",          s.id);
            so->setProperty ("deviceName",  s.deviceName);
            so->setProperty ("label",       s.label);
            so->setProperty ("icon",        s.icon);
            so->setProperty ("channelMask",   (int) s.channelMask);
            so->setProperty ("isClockSource", s.isClockSource);
            srcArr.add (juce::var (so.get()));
        }
        obj->setProperty ("sources", srcArr);
        obj->setProperty ("defaultSourceId", defaultSourceId);
        obj->setProperty ("bpm",             bpm);
        obj->setProperty ("followMidiClock", followMidiClock);
        obj->setProperty ("tsNumerator",     tsNumerator);
        obj->setProperty ("tsDenominator",   tsDenominator);
        obj->setProperty ("midiOut",    midiOut);
        juce::Array<juce::var> thruIn;
        for (auto& n : thruInputs) thruIn.add (n);
        obj->setProperty ("thruInputs",      thruIn);
        obj->setProperty ("thruChannelMask", (int) thruChannelMask);
        juce::Array<juce::var> thruSid;
        for (auto& s : thruSourceIds) thruSid.add (s);
        obj->setProperty ("thruSourceIds",   thruSid);
        obj->setProperty ("kbOut",      kbOut);
        obj->setProperty ("pluginPath", pluginPath);
        obj->setProperty ("chordPadDir", chordPadDir);
        {
            juce::DynamicObject::Ptr cp = new juce::DynamicObject();
            for (int ch = 1; ch <= 16; ++ch)
                if (cpVstPath[ch].isNotEmpty())
                {
                    juce::DynamicObject::Ptr c = new juce::DynamicObject();
                    c->setProperty ("path", cpVstPath[ch]);
                    c->setProperty ("name", cpVstName[ch]);
                    cp->setProperty (juce::String (ch), juce::var (c.get()));
                }
            obj->setProperty ("cpVsts", juce::var (cp.get()));
        }
        obj->setProperty ("currentSet", currentSet);

        juce::Array<juce::var> setArr;
        for (auto& s : sets)
        {
            juce::DynamicObject::Ptr so = new juce::DynamicObject();
            so->setProperty ("name",      s.name);
            so->setProperty ("archived",  s.archived);
            so->setProperty ("createdMs", (double) s.createdMs);
            so->setProperty ("updatedMs", (double) s.updatedMs);
            so->setProperty ("notes",     s.notes);
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
                po->setProperty ("inputs",      presetInArr);
                po->setProperty ("channelMask", (int) p.channelMask);
                juce::Array<juce::var> sidArr;
                for (auto& t : p.sourceIds) sidArr.add (t);
                po->setProperty ("sourceIds",   sidArr);
                po->setProperty ("pinned",      p.pinned);
                po->setProperty ("volume",      (double) p.volume);
                presetArr.add (juce::var (po.get()));
            }
            so->setProperty ("presets", presetArr);
            setArr.add (juce::var (so.get()));
        }
        obj->setProperty ("sets", setArr);
        file().replaceWithText (juce::JSON::toString (juce::var (obj.get()), true));
    }
};
