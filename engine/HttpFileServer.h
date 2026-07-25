// Minimal HTTP server that serves the embedded UI (BinaryData).

#pragma once

#include <ixwebsocket/IXHttpServer.h>
#include <ixwebsocket/IXNetSystem.h>
#include <juce_core/juce_core.h>
#include <BinaryData.h>
#include <memory>
#include <string>

class HttpFileServer
{
public:
    void start (int port)
    {
        ix::initNetSystem();
        server = std::make_unique<ix::HttpServer> (port, "127.0.0.1");
        server->setOnConnectionCallback (
            [] (ix::HttpRequestPtr req, std::shared_ptr<ix::ConnectionState>)
            {
                auto path = req->uri;
                if (path == "/" || path.empty()) path = "/index.html";

                int sz = 0;
                const char* data = nullptr;
                const char* mime = "application/octet-stream";

                ix::WebSocketHttpHeaders headers;
                headers["Cache-Control"] = "no-store";

                // Arturia icon route: /arturia-icon/<URL-encoded plugin name>
                const std::string iconPrefix = "/arturia-icon/";
                if (path.rfind (iconPrefix, 0) == 0)
                {
                    auto encoded = juce::String (path.substr (iconPrefix.size()));
                    auto name = juce::URL::removeEscapeChars (encoded);

                    const juce::File iconRoot ("C:\\ProgramData\\Arturia");
                    juce::File iconFile = iconRoot.getChildFile (name)
                                                  .getChildFile ("resources/images/desktop-icon.png");
                    if (! iconFile.existsAsFile())
                    {
                        for (auto& c : iconRoot.findChildFiles (juce::File::findDirectories, false))
                            if (c.getFileName().startsWithIgnoreCase (name) || name.startsWithIgnoreCase (c.getFileName()))
                            {
                                auto i = c.getChildFile ("resources/images/desktop-icon.png");
                                if (i.existsAsFile()) { iconFile = i; break; }
                            }
                    }
                    if (! iconFile.existsAsFile())
                        return std::make_shared<ix::HttpResponse> (404, "Not Found", ix::HttpErrorCode::Ok, headers, std::string ("no icon"));

                    juce::MemoryBlock mb;
                    iconFile.loadFileAsData (mb);
                    headers["Content-Type"] = "image/png";
                    return std::make_shared<ix::HttpResponse> (200, "OK", ix::HttpErrorCode::Ok, headers,
                        std::string ((const char*) mb.getData(), mb.getSize()));
                }

                if      (path == "/index.html") { data = BinaryData::index_html; sz = BinaryData::index_htmlSize; mime = "text/html; charset=utf-8"; }
                else if (path == "/style.css")  { data = BinaryData::style_css;  sz = BinaryData::style_cssSize;  mime = "text/css; charset=utf-8";  }
                else if (path == "/app.js")     { data = BinaryData::app_js;     sz = BinaryData::app_jsSize;     mime = "application/javascript; charset=utf-8"; }

                if (data == nullptr)
                    return std::make_shared<ix::HttpResponse> (404, "Not Found", ix::HttpErrorCode::Ok, headers, std::string ("not found"));
                headers["Content-Type"] = mime;
                return std::make_shared<ix::HttpResponse> (200, "OK", ix::HttpErrorCode::Ok, headers, std::string (data, (size_t) sz));
            });

        auto res = server->listen();
        if (! res.first) { listenError = res.second; server.reset(); return; }
        server->start();
        listening = true;
    }

    bool isListening() const   { return listening; }
    juce::String getError() const { return juce::String (listenError); }

    void stop()
    {
        if (server) { server->stop(); server.reset(); }
    }

    ~HttpFileServer() { stop(); }

private:
    std::unique_ptr<ix::HttpServer> server;
    bool        listening { false };
    std::string listenError;
};
