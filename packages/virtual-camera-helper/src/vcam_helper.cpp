// vcam_helper.cpp
// Helper process: registers vcam-source.dll as a DirectShow capture filter,
// reads JPEG frames from stdin, decodes to BGRA, writes to shared memory.
//
// Registration strategy:
//   1. Check if HKLM already has the correct entry (no UAC needed).
//   2. If not, spawn self with "--register" argument elevated (UAC prompt, once only).
//   3. The elevated instance writes HKLM and exits with code 0.
//   4. Main instance waits for elevated child, then continues.
//
// HKLM entries written (require admin, done once):
//   HKLM\Software\Classes\CLSID\{CLSID}\                FriendlyName
//   HKLM\Software\Classes\CLSID\{CLSID}\InprocServer32  = <dll path>
//   HKLM\Software\Classes\CLSID\{CLSID}\InprocServer32\ThreadingModel = Both
//   HKLM\Software\Classes\CLSID\{VideoCapture}\Instance\{CLSID}\  CLSID / FriendlyName
//
// HKCU entries are also written on every launch (no admin, instant cleanup on exit).

#define NTDDI_VERSION   0x0A00000C
#define _WIN32_WINNT    0x0A00
#define WINVER          0x0A00
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <vector>
#include <string>
#include "vcam_shared.h"

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "shell32.lib")

using namespace Microsoft::WRL;

// WIN32_LEAN_AND_MEAN omits these predefined registry root handles
#ifndef HKEY_LOCAL_MACHINE
#define HKLM  ((HKEY)(ULONG_PTR)((LONG)0x80000002))
#define HKCU  ((HKEY)(ULONG_PTR)((LONG)0x80000001))
#else
#define HKLM  HKEY_LOCAL_MACHINE
#define HKCU  HKEY_CURRENT_USER
#endif

static const WCHAR kVideoCaptureCategory[] =
    L"{860BB310-5D01-11d0-BD3B-00A0C911CE86}";
static const WCHAR kFriendlyName[] = L"V-Link Station Camera";

static const GUID CLSID_VLinkCameraSource =
    { 0xA1C3E5F7, 0x2B4D, 0x6E8A,
      { 0x0C, 0x2E, 0x4F, 0x6A, 0x8C, 0x0E, 0x2F, 0x4A } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
static std::wstring GuidStr(const GUID& g)
{
    WCHAR buf[48];
    StringFromGUID2(g, buf, 48);
    return buf;
}

static bool ReadExact(HANDLE h, void* buf, DWORD n)
{
    auto p = static_cast<BYTE*>(buf);
    while (n) {
        DWORD r = 0;
        if (!ReadFile(h, p, n, &r, nullptr) || r == 0) return false;
        p += r; n -= r;
    }
    return true;
}

static HRESULT DecodeJpeg(const BYTE* data, DWORD size,
    UINT* outW, UINT* outH, std::vector<BYTE>& bgra)
{
    ComPtr<IWICImagingFactory> wic;
    HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr,
        CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&wic));
    if (FAILED(hr)) return hr;

    ComPtr<IWICStream> st;
    hr = wic->CreateStream(&st); if (FAILED(hr)) return hr;
    hr = st->InitializeFromMemory(const_cast<BYTE*>(data), size); if (FAILED(hr)) return hr;

    ComPtr<IWICBitmapDecoder> dec;
    hr = wic->CreateDecoderFromStream(st.Get(), nullptr,
        WICDecodeMetadataCacheOnLoad, &dec); if (FAILED(hr)) return hr;

    ComPtr<IWICBitmapFrameDecode> frame;
    hr = dec->GetFrame(0, &frame); if (FAILED(hr)) return hr;

    UINT w, h2;
    hr = frame->GetSize(&w, &h2); if (FAILED(hr)) return hr;
    *outW = w; *outH = h2;

    ComPtr<IWICFormatConverter> conv;
    hr = wic->CreateFormatConverter(&conv); if (FAILED(hr)) return hr;
    hr = conv->Initialize(frame.Get(), GUID_WICPixelFormat32bppBGRA,
        WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom);
    if (FAILED(hr)) return hr;

    UINT stride = w * 4;
    bgra.resize(stride * h2);
    return conv->CopyPixels(nullptr, stride, (UINT)bgra.size(), bgra.data());
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------
static bool RegSetSz(HKEY root, const wchar_t* path,
    const wchar_t* valName, const wchar_t* value)
{
    HKEY hk = nullptr;
    if (RegCreateKeyExW(root, path, 0, nullptr,
            REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, nullptr, &hk, nullptr))
        return false;
    bool ok = (RegSetValueExW(hk, valName, 0, REG_SZ,
        reinterpret_cast<const BYTE*>(value),
        (DWORD)((wcslen(value) + 1) * sizeof(WCHAR))) == ERROR_SUCCESS);
    RegCloseKey(hk);
    return ok;
}

static bool RegGetSz(HKEY root, const wchar_t* path,
    const wchar_t* valName, std::wstring& out)
{
    HKEY hk = nullptr;
    if (RegOpenKeyExW(root, path, 0, KEY_QUERY_VALUE, &hk) != ERROR_SUCCESS)
        return false;
    WCHAR buf[MAX_PATH] = {};
    DWORD sz = sizeof(buf);
    DWORD type = REG_SZ;
    bool ok = (RegQueryValueExW(hk, valName, nullptr, &type,
        reinterpret_cast<BYTE*>(buf), &sz) == ERROR_SUCCESS);
    RegCloseKey(hk);
    if (ok) out = buf;
    return ok;
}

// Write all registry entries to the given hive (HKLM or HKCU)
static bool WriteRegistration(HKEY hive,
    const std::wstring& clsid, const std::wstring& dllPath)
{
    auto base   = L"SOFTWARE\\Classes\\CLSID\\" + clsid;
    auto inproc = base + L"\\InprocServer32";
    auto cat    = std::wstring(L"SOFTWARE\\Classes\\CLSID\\") + kVideoCaptureCategory
                  + L"\\Instance\\" + clsid;

    if (!RegSetSz(hive, base.c_str(),   L"FriendlyName",  kFriendlyName))    return false;
    if (!RegSetSz(hive, inproc.c_str(), nullptr,           dllPath.c_str()))  return false;
    if (!RegSetSz(hive, inproc.c_str(), L"ThreadingModel", L"Both"))          return false;
    if (!RegSetSz(hive, cat.c_str(),    L"CLSID",          clsid.c_str()))    return false;
    if (!RegSetSz(hive, cat.c_str(),    L"FriendlyName",   kFriendlyName))    return false;
    return true;
}

static void DeleteRegistration(HKEY hive, const std::wstring& clsid)
{
    auto cat  = std::wstring(L"SOFTWARE\\Classes\\CLSID\\") + kVideoCaptureCategory
                + L"\\Instance\\" + clsid;
    auto base = L"SOFTWARE\\Classes\\CLSID\\" + clsid;
    RegDeleteTreeW(hive, cat.c_str());
    RegDeleteTreeW(hive, base.c_str());
}

// Check whether HKLM already has the correct DLL path registered
static bool HklmRegistrationCurrent(const std::wstring& clsid,
    const std::wstring& dllPath)
{
    auto inproc = L"SOFTWARE\\Classes\\CLSID\\" + clsid + L"\\InprocServer32";
    std::wstring existing;
    if (!RegGetSz(HKLM, inproc.c_str(), nullptr, existing)) return false;
    // Case-insensitive compare
    WCHAR a[MAX_PATH], b[MAX_PATH];
    wcsncpy_s(a, existing.c_str(), _TRUNCATE);
    wcsncpy_s(b, dllPath.c_str(),  _TRUNCATE);
    _wcslwr_s(a); _wcslwr_s(b);
    return (wcscmp(a, b) == 0);
}

// ===========================================================================
// --register mode: write HKLM and exit (runs elevated)
// ===========================================================================
static int RunRegister(const std::wstring& clsid, const std::wstring& dllPath)
{
    if (!WriteRegistration(HKLM, clsid, dllPath)) {
        fwprintf(stderr, L"[vcam] HKLM registration failed\n");
        return 2;
    }
    fwprintf(stderr, L"[vcam] HKLM registration OK\n");
    return 0;
}

// ===========================================================================
// main
// ===========================================================================
int main()
{
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    // Locate vcam-source.dll (same directory as this EXE)
    WCHAR exePath[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, exePath, MAX_PATH);
    std::wstring dir = exePath;
    dir = dir.substr(0, dir.rfind(L'\\') + 1);
    std::wstring dllPath = dir + L"vcam-source.dll";
    std::wstring exePathStr = exePath;

    // Check for --register argument (elevated child)
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    bool isRegisterMode = (argc >= 2 && wcscmp(argv[1], L"--register") == 0);
    if (argv) LocalFree(argv);

    auto clsid = GuidStr(CLSID_VLinkCameraSource);

    if (isRegisterMode) {
        int r = RunRegister(clsid, dllPath);
        CoUninitialize();
        return r;
    }

    // --- Normal mode ---

    if (GetFileAttributesW(dllPath.c_str()) == INVALID_FILE_ATTRIBUTES) {
        fwprintf(stderr, L"[vcam] vcam-source.dll not found: %s\n", dllPath.c_str());
        CoUninitialize(); return 1;
    }

    // 1. HKCU registration (always, no admin needed, cleaned up on exit)
    if (!WriteRegistration(HKCU, clsid, dllPath)) {
        fwprintf(stderr, L"[vcam] HKCU registration failed\n");
        CoUninitialize(); return 1;
    }
    fwprintf(stderr, L"[vcam] HKCU registration OK\n");

    // 2. HKLM registration (once only, requires elevation)
    if (HklmRegistrationCurrent(clsid, dllPath)) {
        fwprintf(stderr, L"[vcam] HKLM already registered, skipping UAC\n");
    } else {
        fwprintf(stderr, L"[vcam] HKLM not registered, requesting elevation...\n");

        SHELLEXECUTEINFOW sei = {};
        sei.cbSize       = sizeof(sei);
        sei.fMask        = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        sei.lpVerb       = L"runas";
        sei.lpFile       = exePathStr.c_str();
        sei.lpParameters = L"--register";
        sei.nShow        = SW_HIDE;

        if (!ShellExecuteExW(&sei)) {
            DWORD err = GetLastError();
            if (err == ERROR_CANCELLED) {
                fwprintf(stderr, L"[vcam] UAC cancelled by user, continuing without HKLM\n");
            } else {
                fwprintf(stderr, L"[vcam] ShellExecuteEx failed: 0x%08X\n", err);
            }
        } else {
            // Wait for elevated child to finish
            if (sei.hProcess) {
                fwprintf(stderr, L"[vcam] Waiting for elevation to complete...\n");
                WaitForSingleObject(sei.hProcess, 30000);
                DWORD exitCode = 0;
                GetExitCodeProcess(sei.hProcess, &exitCode);
                CloseHandle(sei.hProcess);
                if (exitCode == 0) {
                    fwprintf(stderr, L"[vcam] HKLM registration completed\n");
                } else {
                    fwprintf(stderr, L"[vcam] HKLM registration failed (code=%lu)\n", exitCode);
                }
            }
        }
    }

    // 3. Create shared memory
    fwprintf(stderr, L"[vcam] Creating shared memory\n");
    HANDLE hMap = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr,
        PAGE_READWRITE, 0, VCAM_SHM_SIZE, VCAM_MAP_NAME);
    if (!hMap) {
        fwprintf(stderr, L"[vcam] CreateFileMapping failed: 0x%08X\n", GetLastError());
        DeleteRegistration(HKCU, clsid); CoUninitialize(); return 1;
    }
    HANDLE hEvt = CreateEventW(nullptr, FALSE, FALSE, VCAM_EVENT_NAME);
    if (!hEvt) {
        fwprintf(stderr, L"[vcam] CreateEvent failed: 0x%08X\n", GetLastError());
        CloseHandle(hMap); DeleteRegistration(HKCU, clsid); CoUninitialize(); return 1;
    }
    auto* shm = static_cast<VCamShmHeader*>(
        MapViewOfFile(hMap, FILE_MAP_WRITE, 0, 0, VCAM_SHM_SIZE));
    if (!shm) {
        fwprintf(stderr, L"[vcam] MapViewOfFile failed\n");
        CloseHandle(hEvt); CloseHandle(hMap);
        DeleteRegistration(HKCU, clsid); CoUninitialize(); return 1;
    }

    fwprintf(stderr, L"[vcam] Ready. Waiting for frames on stdin...\n");

    // 4. Frame receive loop
    HANDLE hStdin = GetStdHandle(STD_INPUT_HANDLE);
    BYTE header[12];

    while (ReadExact(hStdin, header, sizeof(header)))
    {
        DWORD w   = *reinterpret_cast<UINT32*>(header + 0);
        DWORD h   = *reinterpret_cast<UINT32*>(header + 4);
        DWORD jsz = *reinterpret_cast<UINT32*>(header + 8);
        if (jsz == 0 || jsz > 20000000) break;

        std::vector<BYTE> jpeg(jsz);
        if (!ReadExact(hStdin, jpeg.data(), jsz)) break;

        UINT outW = 0, outH = 0;
        std::vector<BYTE> bgra;
        if (SUCCEEDED(DecodeJpeg(jpeg.data(), jsz, &outW, &outH, bgra))) {
            if (outW > 1920 || outH > 1080) continue;
            shm->width  = outW;
            shm->height = outH;
            memcpy(shm + 1, bgra.data(), bgra.size());
            SetEvent(hEvt);
        }
    }

    fwprintf(stderr, L"[vcam] Stdin closed, shutting down\n");
    UnmapViewOfFile(shm);
    CloseHandle(hEvt);
    CloseHandle(hMap);
    DeleteRegistration(HKCU, clsid);
    // Note: HKLM registration is intentionally kept (persistent)
    CoUninitialize();
    fwprintf(stderr, L"[vcam] Shutdown complete.\n");
    return 0;
}
