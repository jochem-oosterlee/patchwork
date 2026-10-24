// MIDI sequencer + transport, running on the audio thread.
//
// The UI owns the rich song model (chord items, clips, voicings …) and sends
// us a flattened version: per track a sorted list of notes in absolute beats
// plus the instrument they play. We swap that in atomically and, each audio
// block, emit the note-ons/offs that fall inside the block at their exact
// sample offset. Loop wrap, seek and stop release whatever is still sounding.
//
// Threading: setModel/play/stop/seek are called from the message thread and
// only touch atomics or a spin-locked pointer slot. process() runs on the
// audio thread and never allocates: track cursors and the active-note table
// are fixed-size, and the model pointer is taken over with a try-lock.

#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <functional>
#include <memory>
#include <vector>

struct SeqNote
{
    double start = 0.0;    // absolute beat
    double beats = 1.0;    // duration in beats
    int    midi  = 60;
    int    vel   = 100;
};

struct SeqTrack
{
    juce::String         id;
    juce::String         target;    // PluginHost instance id ("" = silent)
    int                  channel = 1;
    bool                 audible = true;   // mute/solo already resolved by the UI
    std::vector<SeqNote> notes;            // sorted by start
};

struct SeqModel
{
    std::vector<SeqTrack> tracks;
    bool   loop      = false;
    double loopStart = 0.0;
    double loopEnd   = 4.0;
};

class Sequencer
{
public:
    static constexpr int kMaxTracks = 64;
    static constexpr int kMaxActive = 512;

    // target, channel, message, sampleOffset
    using Emit = std::function<void (const juce::String&, const juce::MidiMessage&, int)>;

    struct BlockInfo
    {
        bool   playing  = false;
        double startBeat = 0.0;   // position at block start
        double endBeat   = 0.0;   // position at block end (after a wrap: in the new cycle)
        // Beat boundaries crossed inside the block, for the metronome.
        std::array<std::pair<int, bool>, 8> clicks;   // {sampleOffset, accent}
        int clickCount = 0;
    };

    // ---- message thread ---------------------------------------------------

    void setModel (std::shared_ptr<const SeqModel> m)
    {
        const juce::SpinLock::ScopedLockType sl (modelLock);
        pending = std::move (m);
        retired.reset();    // free the previously swapped-out model here, not on the audio thread
    }

    void play (double fromBeat) { pendingBeat.store (fromBeat); pendingCmd.store (CmdPlay); }
    void stop()                 { pendingCmd.store (CmdStop); }
    void seek (double beat)     { pendingBeat.store (beat);     pendingCmd.store (CmdSeek); }

    // ---- any thread -------------------------------------------------------

    bool   isPlaying() const     { return playing.load(); }
    double positionBeats() const { return position.load(); }

    // Snapshot of the loop settings the audio thread is currently using.
    void getLoop (bool& on, double& start, double& end) const
    {
        on = loopOn.load(); start = loopStartA.load(); end = loopEndA.load();
    }

    // ---- audio thread -----------------------------------------------------

    BlockInfo process (int numSamples, double sampleRate, double bpm, int tsNum, const Emit& emit)
    {
        BlockInfo info;
        takeModel();
        handleCommands (emit);

        info.playing   = playing.load();
        info.startBeat = pos;
        if (! info.playing || sampleRate <= 0.0 || bpm <= 0.0 || numSamples <= 0)
        {
            info.endBeat = pos;
            return info;
        }

        const double bps  = bpm / 60.0 / sampleRate;    // beats per sample
        const bool   loop = current && current->loop && current->loopEnd > current->loopStart;
        const double ls   = current ? current->loopStart : 0.0;
        const double le   = current ? current->loopEnd   : 0.0;

        int remaining = numSamples;
        int segStart  = 0;
        while (remaining > 0)
        {
            const double segEndBeat = pos + bps * remaining;
            const bool   wrap       = loop && pos < le && segEndBeat >= le;
            int samplesInSeg = remaining;
            if (wrap)
                samplesInSeg = juce::jlimit (1, remaining, (int) std::ceil ((le - pos) / bps));
            const double segEnd = wrap ? le : segEndBeat;

            emitSegment (pos, segEnd, bps, segStart, samplesInSeg, tsNum, info, emit);

            if (wrap)
            {
                // Everything still sounding is cut at the loop point.
                releaseAll (segStart + samplesInSeg - 1, emit);
                pos = ls;
                resetCursors (pos);
            }
            else
                pos = segEnd;

            segStart  += samplesInSeg;
            remaining -= samplesInSeg;
        }

        position.store (pos);
        info.endBeat = pos;
        return info;
    }

private:
    enum Cmd { CmdNone = 0, CmdPlay, CmdStop, CmdSeek };

    struct Active
    {
        juce::String target;
        int    channel = 1;
        int    midi    = 60;
        double endBeat = 0.0;
        bool   used    = false;
    };

    void takeModel()
    {
        const juce::SpinLock::ScopedTryLockType tl (modelLock);
        if (! tl.isLocked() || pending == nullptr) return;
        retired = std::move (current);
        current = std::move (pending);
        pending.reset();
        loopOn.store (current->loop);
        loopStartA.store (current->loopStart);
        loopEndA.store (current->loopEnd);
        if (playing.load())
            resetCursors (pos);   // the notes changed under us — re-find each track's next note
    }

    void handleCommands (const Emit& emit)
    {
        const int cmd = pendingCmd.exchange (CmdNone);
        if (cmd == CmdNone) return;
        if (cmd == CmdStop)
        {
            releaseAll (0, emit);
            playing.store (false);
            return;
        }
        // play / seek
        releaseAll (0, emit);
        double b = juce::jmax (0.0, pendingBeat.load());
        if (current && current->loop && current->loopEnd > current->loopStart)
        {
            if (b >= current->loopEnd || b < current->loopStart) b = current->loopStart;
        }
        pos = b;
        position.store (pos);
        resetCursors (pos);
        if (cmd == CmdPlay) playing.store (true);
    }

    // Point every track's cursor at its first note starting at or after `beat`.
    void resetCursors (double beat)
    {
        if (! current) return;
        const int n = juce::jmin ((int) current->tracks.size(), kMaxTracks);
        for (int t = 0; t < n; ++t)
        {
            const auto& notes = current->tracks[(size_t) t].notes;
            auto it = std::lower_bound (notes.begin(), notes.end(), beat,
                                        [] (const SeqNote& a, double v) { return a.start < v; });
            cursor[(size_t) t] = (int) std::distance (notes.begin(), it);
        }
    }

    void emitSegment (double from, double to, double bps, int segStart, int samplesInSeg,
                      int tsNum, BlockInfo& info, const Emit& emit)
    {
        const int lastOffset = segStart + samplesInSeg - 1;
        auto offsetFor = [&] (double beat)
        {
            const int off = segStart + (int) std::llround ((beat - from) / bps);
            return juce::jlimit (segStart, lastOffset, off);
        };

        // Note-offs for active notes ending in [from, to).
        for (auto& a : active)
            if (a.used && a.endBeat >= from && a.endBeat < to)
            {
                emit (a.target, juce::MidiMessage::noteOff (a.channel, a.midi), offsetFor (a.endBeat));
                a.used = false;
            }

        // Note-ons for notes starting in [from, to).
        if (current)
        {
            const int n = juce::jmin ((int) current->tracks.size(), kMaxTracks);
            for (int t = 0; t < n; ++t)
            {
                const auto& tr    = current->tracks[(size_t) t];
                const auto& notes = tr.notes;
                int& ci = cursor[(size_t) t];
                while (ci < (int) notes.size() && notes[(size_t) ci].start < to)
                {
                    const auto& nt = notes[(size_t) ci];
                    ++ci;
                    if (nt.start < from) continue;          // behind us (shouldn't happen after resetCursors)
                    if (! tr.audible || tr.target.isEmpty()) continue;
                    const int off = offsetFor (nt.start);
                    // A retrigger of a note still sounding on the same target/channel:
                    // release it just before the new attack.
                    for (auto& a : active)
                        if (a.used && a.midi == nt.midi && a.channel == tr.channel && a.target == tr.target)
                        {
                            emit (a.target, juce::MidiMessage::noteOff (a.channel, a.midi), juce::jmax (segStart, off - 1));
                            a.used = false;
                        }
                    emit (tr.target, juce::MidiMessage::noteOn (tr.channel, nt.midi, (juce::uint8) juce::jlimit (1, 127, nt.vel)), off);
                    // Leave a small gap before the nominal end so back-to-back
                    // repeats of the same note articulate.
                    const double gap = juce::jmin (0.0625, nt.beats * 0.1);
                    addActive (tr.target, tr.channel, nt.midi, nt.start + juce::jmax (0.01, nt.beats - gap));
                }
            }
        }

        // Metronome: integer beats in [from, to).
        if (tsNum > 0)
            for (long long b = (long long) std::ceil (from); (double) b < to; ++b)
            {
                if (info.clickCount >= (int) info.clicks.size()) break;
                info.clicks[(size_t) info.clickCount++] = { offsetFor ((double) b), (b % tsNum) == 0 };
            }
    }

    void addActive (const juce::String& target, int channel, int midi, double endBeat)
    {
        for (auto& a : active)
            if (! a.used)
            {
                a.target = target; a.channel = channel; a.midi = midi; a.endBeat = endBeat; a.used = true;
                return;
            }
        // Table full: drop the oldest (lowest endBeat) to make room.
        auto* oldest = &active[0];
        for (auto& a : active) if (a.endBeat < oldest->endBeat) oldest = &a;
        *oldest = { target, channel, midi, endBeat, true };
    }

    void releaseAll (int sampleOffset, const Emit& emit)
    {
        for (auto& a : active)
            if (a.used)
            {
                emit (a.target, juce::MidiMessage::noteOff (a.channel, a.midi), juce::jmax (0, sampleOffset));
                a.used = false;
            }
    }

    // Model handoff.
    juce::SpinLock                   modelLock;
    std::shared_ptr<const SeqModel>  pending;    // set by message thread
    std::shared_ptr<const SeqModel>  current;    // owned by audio thread
    std::shared_ptr<const SeqModel>  retired;    // freed by message thread on next setModel

    // Transport.
    std::atomic<bool>   playing     { false };
    std::atomic<double> position    { 0.0 };    // mirror of `pos` for readers
    std::atomic<int>    pendingCmd  { CmdNone };
    std::atomic<double> pendingBeat { 0.0 };
    std::atomic<bool>   loopOn      { false };
    std::atomic<double> loopStartA  { 0.0 };
    std::atomic<double> loopEndA    { 4.0 };
    double pos = 0.0;                           // audio-thread position

    std::array<int, kMaxTracks>    cursor {};
    std::array<Active, kMaxActive> active {};
};
