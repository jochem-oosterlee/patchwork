// Minimal HTTP server that serves a directory from disk. Used to host the
// chord-pad web app locally (http://127.0.0.1:<port>/) so it runs in a
// secure context (Web MIDI) and can open a ws:// link to our engine without
// mixed-content blocking. Files are read fresh per request (no-store), so
// editing chord-pad on disk is picked up on reload.

#pragma once

#include <ixwebsocket/IXHttpServer.h>
#include <ixwebsocket/IXNetSystem.h>
#include <juce_core/juce_core.h>
#include <memory>
#include <string>

class StaticDirServer
{
public:
    // root = directory to serve; indexFile = what "/" maps to.
    void start (int port, juce::File root, juce::String indexFile = "index.html")
    {
        rootDir   = std::move (root);
        indexName = std::move (indexFile);
        ix::initNetSystem();
        server = std::make_unique<ix::HttpServer> (port, "127.0.0.1");

        server->setOnConnectionCallback (
            [this] (ix::HttpRequestPtr req, std::shared_ptr<ix::ConnectionState>)
            {
                ix::WebSocketHttpHeaders headers;
                headers["Cache-Control"] = "no-store";

                // Strip query string / fragment, decode %xx.
                std::string uri = req->uri;
                const auto q = uri.find_first_of ("?#");
                if (q != std::string::npos) uri = uri.substr (0, q);
                if (uri.empty() || uri == "/") uri = "/" + indexName.toStdString();

                juce::String rel = juce::URL::removeEscapeChars (juce::String (uri));
                rel = rel.replaceCharacter ('\\', '/');
                while (rel.startsWith ("/")) rel = rel.substring (1);

                // Reject path traversal outright.
                if (rel.contains (".."))
                    return std::make_shared<ix::HttpResponse> (403, "Forbidden",
                        ix::HttpErrorCode::Ok, headers, std::string ("forbidden"));

                juce::File f = rootDir.getChildFile (rel);
                if (! f.existsAsFile())
                    return std::make_shared<ix::HttpResponse> (404, "Not Found",
                        ix::HttpErrorCode::Ok, headers, std::string ("not found"));

                juce::MemoryBlock mb;
                if (! f.loadFileAsData (mb))
                    return std::make_shared<ix::HttpResponse> (500, "Error",
                        ix::HttpErrorCode::Ok, headers, std::string ("read error"));

                headers["Content-Type"] = mimeFor (f.getFileExtension());
                return std::make_shared<ix::HttpResponse> (200, "OK",
                    ix::HttpErrorCode::Ok, headers,
                    std::string ((const char*) mb.getData(), mb.getSize()));
            });

        auto res = server->listen();
        if (! res.first) { listenError = res.second; server.reset(); return; }
        server->start();
        listening = true;
    }

    bool isListening() const      { return listening; }
    juce::String getError() const { return juce::String (listenError); }

    void stop() { if (server) { server->stop(); server.reset(); } }
    ~StaticDirServer() { stop(); }

private:
    static const char* mimeFor (const juce::String& ext)
    {
        auto e = ext.toLowerCase();
        if (e == ".html" || e == ".htm") return "text/html; charset=utf-8";
        if (e == ".css")   return "text/css; charset=utf-8";
        if (e == ".js" || e == ".mjs") return "application/javascript; charset=utf-8";
        if (e == ".json")  return "application/json; charset=utf-8";
        if (e == ".png")   return "image/png";
        if (e == ".jpg" || e == ".jpeg") return "image/jpeg";
        if (e == ".gif")   return "image/gif";
        if (e == ".svg")   return "image/svg+xml";
        if (e == ".ico")   return "image/x-icon";
        if (e == ".webp")  return "image/webp";
        if (e == ".woff2") return "font/woff2";
        if (e == ".woff")  return "font/woff";
        if (e == ".ttf")   return "font/ttf";
        if (e == ".wasm")  return "application/wasm";
        if (e == ".map")   return "application/json";
        if (e == ".webmanifest") return "application/manifest+json";
        return "application/octet-stream";
    }

    std::unique_ptr<ix::HttpServer> server;
    juce::File   rootDir;
    juce::String indexName;
    bool         listening { false };
    std::string  listenError;
};
