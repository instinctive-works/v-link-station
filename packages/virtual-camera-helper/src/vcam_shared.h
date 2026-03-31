#pragma once
#include <windows.h>

#define VCAM_MAP_NAME   L"Local\\VLinkVCam"
#define VCAM_EVENT_NAME L"Local\\VLinkVCamNew"
#define VCAM_SHM_SIZE   (10 * 1024 * 1024)  // 10 MB (>= 1920x1080 BGRA)

// Layout: VCamShmHeader immediately followed by width*height*4 bytes of BGRA
#pragma pack(push, 1)
struct VCamShmHeader {
    UINT32 width;
    UINT32 height;
};
#pragma pack(pop)
