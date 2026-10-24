cmake_minimum_required(VERSION 3.22)
project(MidiHost VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)

# JUCE — audio framework + VST3 hosting
FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        8.0.4
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(JUCE)

# Apply JUCE patches every configure (idempotent: skips if already applied).
function(apply_juce_patch patch_file)
    execute_process(
        COMMAND git -C "${juce_SOURCE_DIR}" apply --reverse --check "${patch_file}"
        RESULT_VARIABLE patch_already_applied
        OUTPUT_QUIET ERROR_QUIET
    )
    if (NOT patch_already_applied EQUAL 0)
        execute_process(
            COMMAND git -C "${juce_SOURCE_DIR}" apply "${patch_file}"
            RESULT_VARIABLE patch_apply_result
        )
        if (NOT patch_apply_result EQUAL 0)
            message(FATAL_ERROR "Failed to apply JUCE patch: ${patch_file}")
        endif()
        message(STATUS "Applied JUCE patch: ${patch_file}")
    endif()
endfunction()

apply_juce_patch("${CMAKE_CURRENT_SOURCE_DIR}/patches/juce-vst3-midi-controller-sync.patch")
apply_juce_patch("${CMAKE_CURRENT_SOURCE_DIR}/patches/juce-webview2-devtools.patch")

# IXWebSocket — small WS server, TLS disabled for localhost
set(USE_TLS OFF CACHE BOOL "" FORCE)
set(USE_OPEN_SSL OFF CACHE BOOL "" FORCE)
set(USE_MBED_TLS OFF CACHE BOOL "" FORCE)
set(USE_ZLIB OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    ixwebsocket
    GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git
    GIT_TAG        v11.4.5
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(ixwebsocket)

# Microsoft WebView2 SDK (NuGet) — fetch directly, FetchContent_Declare
# has trouble with NuGet's archive layout on Windows.
set(WEBVIEW2_VERSION "1.0.2792.45")
set(webview2_SOURCE_DIR "${CMAKE_BINARY_DIR}/webview2")
if(NOT EXISTS "${webview2_SOURCE_DIR}/build/native/include/WebView2.h")
    file(MAKE_DIRECTORY "${webview2_SOURCE_DIR}")
    message(STATUS "Downloading Microsoft.Web.WebView2 ${WEBVIEW2_VERSION}")
    file(DOWNLOAD
        "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${WEBVIEW2_VERSION}"
        "${CMAKE_BINARY_DIR}/webview2.nupkg"
        SHOW_PROGRESS)
    file(ARCHIVE_EXTRACT
        INPUT "${CMAKE_BINARY_DIR}/webview2.nupkg"
        DESTINATION "${webview2_SOURCE_DIR}")
endif()

# Steinberg ASIO SDK — not redistributable, download it yourself. Point
# ASIO_SDK_DIR (cache var or env var) at the SDK root; default is a sibling
# folder ../ASIOSDK. Without it we build without ASIO (WASAPI etc. still work).
if(NOT ASIO_SDK_DIR AND DEFINED ENV{ASIO_SDK_DIR})
    set(ASIO_SDK_DIR "$ENV{ASIO_SDK_DIR}")
endif()
set(ASIO_SDK_DIR "${ASIO_SDK_DIR}" CACHE PATH "Steinberg ASIO SDK root (contains common/iasiodrv.h)")
if(NOT ASIO_SDK_DIR)
    get_filename_component(ASIO_SDK_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../ASIOSDK" ABSOLUTE)
endif()
if(EXISTS "${ASIO_SDK_DIR}/common/iasiodrv.h")
    set(ASIO_INCLUDE_DIR "${ASIO_SDK_DIR}/common")
    set(USE_ASIO 1)
    message(STATUS "ASIO SDK: ${ASIO_INCLUDE_DIR}")
else()
    set(ASIO_INCLUDE_DIR "")
    set(USE_ASIO 0)
    message(WARNING "ASIO SDK not found at ${ASIO_SDK_DIR} — building without ASIO. Set ASIO_SDK_DIR to enable it.")
endif()

juce_add_gui_app(MidiHost
    PRODUCT_NAME "Patchwork"
    COMPANY_NAME "Jochem"
    ICON_BIG "${CMAKE_CURRENT_SOURCE_DIR}/resources/patchwork-icon.png"
)

if (MSVC)
    target_compile_options(MidiHost PRIVATE /utf-8)
endif()

target_compile_definitions(MidiHost PRIVATE
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_VST=0
    JUCE_PLUGINHOST_AU=0
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=1
    JUCE_USE_WIN_WEBVIEW2=1
    JUCE_DISPLAY_SPLASH_SCREEN=0
    JUCE_ASIO=${USE_ASIO}
)

target_include_directories(MidiHost PRIVATE
    ${ASIO_INCLUDE_DIR}
    "${webview2_SOURCE_DIR}/build/native/include"
)

# Copy WebView2Loader.dll next to the exe at build time.
add_custom_command(TARGET MidiHost POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${webview2_SOURCE_DIR}/build/native/x64/WebView2Loader.dll"
        "$<TARGET_FILE_DIR:MidiHost>/WebView2Loader.dll"
)

# Bundle the UI as resources so we can serve them from the engine without
# requiring an external folder at runtime.
juce_add_binary_data(MidiHost_UI SOURCES
    ui/index.html
    ui/style.css
    ui/app.js
    resources/patchwork-icon.png
    resources/cable.svg
)

target_sources(MidiHost PRIVATE
    engine/Main.cpp
)

target_link_libraries(MidiHost PRIVATE
    MidiHost_UI
    juce::juce_audio_utils
    juce::juce_audio_processors
    juce::juce_audio_devices
    juce::juce_core
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_gui_extra
    ixwebsocket
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags
)
