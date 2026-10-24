// Minimal WebSocket bridge between the engine and the web UI.
// Wraps an ix::WebSocketServer; broadcasts JSON to all clients and
// hands incoming text messages to a callback.

#pragma once

#include <ixwebsocket/IXWebSocketServer.h>
#include <ixwebsocket/IXNetSystem.h>
#include <juce_core/juce_core.h>
#include <functional>
#include <memory>

class WebSocketBridge
{
public:
    using MessageHandler = std::function<void (const juce::String& jsonText)>;
    std::function<void (const juce::String&)> logger;

    void start (int port, MessageHandler handler)
    {
        onMessage = std::move (handler);
        ix::initNetSystem();
        server = std::make_unique<ix::WebSocketServer> (port, "127.0.0.1");

        server->setOnClientMessageCallback (
            [this] (std::shared_ptr<ix::ConnectionState>,
                    ix::WebSocket&,
                    const ix::WebSocketMessagePtr& msg)
            {
                if (msg->type == ix::WebSocketMessageType::Message && onMessage)
                    onMessage (juce::String::fromUTF8 (msg->str.c_str(), (int) msg->str.size()));
            });

        auto res = server->listen();
        if (! res.first)
        {
            listenError = res.second;
            server.reset();
            return;
        }
        server->start();
        listening = true;
    }

    bool isListening() const { return listening; }
    juce::String getError() const { return juce::String (listenError); }

    void stop()
    {
        if (server)
        {
            server->stop();
            server.reset();
        }
    }

    void broadcast (const juce::var& json)
    {
        if (! server) return;
        const auto text = juce::JSON::toString (json, true).toStdString();
        for (auto& client : server->getClients())
            client->send (text);
    }

    ~WebSocketBridge() { stop(); }

private:
    std::unique_ptr<ix::WebSocketServer> server;
    MessageHandler                        onMessage;
    bool                                  listening { false };
    std::string                           listenError;
};
