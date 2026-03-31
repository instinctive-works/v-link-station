cmake_minimum_required(VERSION 3.20)
project(vcam-helper CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_SYSTEM_VERSION "10.0.26100.0")

set(VCAM_DEFS
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    UNICODE
    _UNICODE
    WINVER=0x0A00
    _WIN32_WINNT=0x0A00
    NTDDI_VERSION=0x0A00000C
)

# --------------------------------------------------------------------------
# vcam-source.dll: DirectShow capture filter (in-proc COM server)
# --------------------------------------------------------------------------
add_library(vcam-source SHARED src/vcam_source.cpp src/vcam_source.def)
target_compile_definitions(vcam-source PRIVATE ${VCAM_DEFS})
target_compile_options(vcam-source PRIVATE /W3 /EHsc /utf-8)
target_link_libraries(vcam-source PRIVATE ole32 oleaut32 strmiids)
set_target_properties(vcam-source PROPERTIES LINK_FLAGS "/SUBSYSTEM:WINDOWS")

# --------------------------------------------------------------------------
# vcam-helper.exe: main process (stdin → shared memory)
# --------------------------------------------------------------------------
add_executable(vcam-helper src/vcam_helper.cpp)
target_compile_definitions(vcam-helper PRIVATE ${VCAM_DEFS})
target_compile_options(vcam-helper PRIVATE /W3 /EHsc /utf-8)
target_link_libraries(vcam-helper PRIVATE ole32 oleaut32 windowscodecs advapi32)
set_target_properties(vcam-helper PROPERTIES LINK_FLAGS "/SUBSYSTEM:CONSOLE")
