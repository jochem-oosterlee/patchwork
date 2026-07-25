// MIDI input handling. Forwards every message to a handler callback.

#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <functional>
#include <memory>

class MidiManager : private juce::MidiInputCallback
{
public:
    using MessageHandler = std::function<void (const juce::String& source, const juce::MidiMessage&)>;

    void setHandler (MessageHandler h) { handler = std::move (h); }

    // Virtual input device name for notes arriving over the chord-pad
    // WebSocket link. It's never opened as real hardware (openInputsByNames
    // matches only against getAvailableDevices), but it shows up in the UI's
    // input list so the user can build sources from it and route per channel.
    static constexpr const char* kChordPadInput = "chord-pad";

    juce::StringArray listInputs() const
    {
        juce::StringArray names;
        for (auto& d : juce::MidiInput::getAvailableDevices()) names.add (d.name);
        names.add (kChordPadInput);   // virtual: fed by the WS link, not hardware
        return names;
    }

    juce::StringArray listOutputs() const
    {
        juce::StringArray names;
        for (auto& d : juce::MidiOutput::getAvailableDevices()) names.add (d.name);
        return names;
    }

    std::function<void (const juce::String& opened, const juce::String& error)> onInputOpened;

    // Open the given set of input devices. Closes any inputs no longer in the
    // list. Messages from all open inputs are merged into the handler.
    void openInputsByNames (const juce::StringArray& names)
    {
        juce::MessageManager::callAsync ([this, names]
        {
            for (auto& in : inputs) if (in) in->stop();
            inputs.clear();

            for (auto& name : names)
            {
                if (name.isEmpty()) continue;
                bool opened = false;
                for (auto& d : juce::MidiInput::getAvailableDevices())
                    if (d.name == name)
                    {
                        auto dev = juce::MidiInput::openDevice (d.identifier, this);
                        if (dev != nullptr)
                        {
                            dev->start();
                            inputs.push_back (std::move (dev));
                            if (onInputOpened) onInputOpened (name, {});
                            opened = true;
                        }
                        else if (onInputOpened)
                            onInputOpened ({}, "openDevice returned nullptr for " + name);
                        break;
                    }
                if (! opened && onInputOpened)
                    onInputOpened ({}, "device not found: " + name);
            }
            if (names.isEmpty() && onInputOpened) onInputOpened ({}, {});
        });
    }

    void openOutputByName (const juce::String& name)
    {
        juce::MessageManager::callAsync ([this, name]
        {
            output.reset();
            if (name.isEmpty()) return;
            for (auto& d : juce::MidiOutput::getAvailableDevices())
            {
                if (d.name == name)
                {
                    output = juce::MidiOutput::openDevice (d.identifier);
                    return;
                }
            }
        });
    }

    void openKbOutputByName (const juce::String& name)
    {
        juce::MessageManager::callAsync ([this, name]
        {
            kbOutput.reset();
            if (name.isEmpty()) return;
            for (auto& d : juce::MidiOutput::getAvailableDevices())
            {
                if (d.name == name)
                {
                    kbOutput = juce::MidiOutput::openDevice (d.identifier);
                    return;
                }
            }
        });
    }

    void sendThru (const juce::MidiMessage& m)
    {
        if (output != nullptr) output->sendMessageNow (m);
    }

    void sendKb (const juce::MidiMessage& m)
    {
        if (kbOutput != nullptr) kbOutput->sendMessageNow (m);
    }

    void close()
    {
        for (auto& in : inputs) if (in) in->stop();
        inputs.clear();
        output.reset();
        kbOutput.reset();
    }

    ~MidiManager() override { close(); }

private:
    void handleIncomingMidiMessage (juce::MidiInput* source, const juce::MidiMessage& msg) override
    {
        if (handler) handler (source != nullptr ? source->getName() : juce::String(), msg);
    }

    std::vector<std::unique_ptr<juce::MidiInput>> inputs;
    std::unique_ptr<juce::MidiOutput> output;
    std::unique_ptr<juce::MidiOutput> kbOutput;
    MessageHandler                    handler;
};
