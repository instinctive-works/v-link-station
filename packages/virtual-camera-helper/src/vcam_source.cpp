// vcam_source.cpp
// DirectShow virtual camera filter (in-proc COM server)
// Implements a capture filter that reads BGRA frames from shared memory
// and delivers them as MEDIATYPE_Video / MEDIASUBTYPE_RGB32

#define NTDDI_VERSION   0x0A00000C
#define _WIN32_WINNT    0x0A00
#define WINVER          0x0A00
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include <amvideo.h>  // VIDEOINFOHEADER, BITMAPINFOHEADER
#include <strmif.h>   // IBaseFilter, IPin, IMediaFilter, etc.
#include <uuids.h>    // MEDIATYPE_Video, MEDIASUBTYPE_RGB32, FORMAT_VideoInfo
#include <dvdmedia.h> // VIDEO_STREAM_CONFIG_CAPS
#include <vfwmsgs.h>  // VFW_E_* error codes
#include <ks.h>       // KSPROPERTY
#include <ksproxy.h>  // IKsPropertySet
#include <vector>
#include <mutex>
#include <atomic>
#include <cstdio>
#include "vcam_shared.h"

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "strmiids.lib")

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
static void VCamLog(const char* fmt, ...)
{
    char buf[512];
    va_list args; va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    wchar_t tmpPath[MAX_PATH]; GetTempPathW(MAX_PATH, tmpPath);
    wchar_t logPath[MAX_PATH];
    _snwprintf_s(logPath, MAX_PATH, L"%svcam-source.log", tmpPath);
    HANDLE h = CreateFileW(logPath, GENERIC_WRITE, FILE_SHARE_READ,
        nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
    SetFilePointer(h, 0, nullptr, FILE_END);
    SYSTEMTIME st; GetLocalTime(&st);
    char line[600];
    int len = _snprintf_s(line, sizeof(line), "[%02d:%02d:%02d] %s\r\n",
        st.wHour, st.wMinute, st.wSecond, buf);
    DWORD w; WriteFile(h, line, (DWORD)len, &w, nullptr);
    CloseHandle(h);
}

// ---------------------------------------------------------------------------
// CLSID
// ---------------------------------------------------------------------------
static const GUID CLSID_VLinkCameraSource =
    { 0xA1C3E5F7, 0x2B4D, 0x6E8A,
      { 0x0C, 0x2E, 0x4F, 0x6A, 0x8C, 0x0E, 0x2F, 0x4A } };

// ---------------------------------------------------------------------------
// Forward declarations
// ---------------------------------------------------------------------------
class CameraFilter;
class CameraPin;

// ===========================================================================
// IMemAllocator implementation (minimal, single fixed buffer per GetBuffer call)
// ===========================================================================
class SimpleAllocator : public IMemAllocator
{
    LONG  m_ref = 1;
    DWORD m_bufSize = 0;
    bool  m_committed = false;

    struct Sample : public IMediaSample
    {
        LONG  m_ref = 1;
        std::vector<BYTE> m_data;
        LONG  m_actualLen = 0;
        REFERENCE_TIME m_tStart = 0, m_tStop = 0;
        bool  m_hasTime = false;

        explicit Sample(DWORD size) : m_data(size) {}

        STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
            if (!ppv) return E_POINTER;
            if (riid==IID_IUnknown||riid==IID_IMediaSample){*ppv=this;AddRef();return S_OK;}
            *ppv=nullptr;return E_NOINTERFACE;
        }
        ULONG STDMETHODCALLTYPE AddRef()  override { return InterlockedIncrement(&m_ref); }
        ULONG STDMETHODCALLTYPE Release() override {
            LONG r=InterlockedDecrement(&m_ref); if(r==0)delete this; return r;
        }
        STDMETHODIMP GetPointer(BYTE** pp) override { *pp=m_data.data(); return S_OK; }
        STDMETHODIMP_(LONG) GetSize() override { return (LONG)m_data.size(); }
        STDMETHODIMP GetTime(REFERENCE_TIME* s,REFERENCE_TIME* e) override {
            if(!m_hasTime)return VFW_S_NO_STOP_TIME;
            *s=m_tStart;*e=m_tStop;return S_OK;
        }
        STDMETHODIMP SetTime(REFERENCE_TIME* s,REFERENCE_TIME* e) override {
            m_tStart=s?*s:0;m_tStop=e?*e:0;m_hasTime=(s!=nullptr);return S_OK;
        }
        STDMETHODIMP IsSyncPoint() override { return S_OK; }
        STDMETHODIMP SetSyncPoint(BOOL) override { return S_OK; }
        STDMETHODIMP IsPreroll() override { return S_FALSE; }
        STDMETHODIMP SetPreroll(BOOL) override { return S_OK; }
        STDMETHODIMP_(LONG) GetActualDataLength() override { return m_actualLen; }
        STDMETHODIMP SetActualDataLength(LONG l) override { m_actualLen=l; return S_OK; }
        STDMETHODIMP GetMediaType(AM_MEDIA_TYPE** pp) override { *pp=nullptr;return S_FALSE; }
        STDMETHODIMP SetMediaType(AM_MEDIA_TYPE*) override { return S_OK; }
        STDMETHODIMP IsDiscontinuity() override { return S_FALSE; }
        STDMETHODIMP SetDiscontinuity(BOOL) override { return S_OK; }
        STDMETHODIMP GetMediaTime(LONGLONG*,LONGLONG*) override { return VFW_E_MEDIA_TIME_NOT_SET; }
        STDMETHODIMP SetMediaTime(LONGLONG*,LONGLONG*) override { return S_OK; }
    };

public:
    STDMETHODIMP QueryInterface(REFIID riid,void** ppv) override {
        if(!ppv)return E_POINTER;
        if(riid==IID_IUnknown||riid==IID_IMemAllocator){*ppv=this;AddRef();return S_OK;}
        *ppv=nullptr;return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef()  override { return InterlockedIncrement(&m_ref); }
    ULONG STDMETHODCALLTYPE Release() override {
        LONG r=InterlockedDecrement(&m_ref);if(r==0)delete this;return r;
    }
    STDMETHODIMP SetProperties(ALLOCATOR_PROPERTIES* pReq,ALLOCATOR_PROPERTIES* pAct) override {
        if(pReq->cbBuffer>0)m_bufSize=pReq->cbBuffer;
        pAct->cBuffers=pReq->cBuffers>0?pReq->cBuffers:1;
        pAct->cbBuffer=m_bufSize>0?m_bufSize:1920*1080*4;
        pAct->cbAlign=pReq->cbAlign>0?pReq->cbAlign:1;
        pAct->cbPrefix=0;
        m_bufSize=pAct->cbBuffer;
        return S_OK;
    }
    STDMETHODIMP GetProperties(ALLOCATOR_PROPERTIES* p) override {
        p->cBuffers=2;p->cbBuffer=m_bufSize?m_bufSize:1920*1080*4;p->cbAlign=1;p->cbPrefix=0;
        return S_OK;
    }
    STDMETHODIMP Commit()   override { m_committed=true;  return S_OK; }
    STDMETHODIMP Decommit() override { m_committed=false; return S_OK; }
    STDMETHODIMP GetBuffer(IMediaSample** pp,REFERENCE_TIME*,REFERENCE_TIME*,DWORD) override {
        if(!m_committed)return VFW_E_NOT_COMMITTED;
        DWORD sz=m_bufSize?m_bufSize:1920*1080*4;
        *pp=new Sample(sz);
        return S_OK;
    }
    STDMETHODIMP ReleaseBuffer(IMediaSample* p) override { p->Release(); return S_OK; }
};

// ===========================================================================
// CameraPin  (output pin)
// ===========================================================================
class CameraPin : public IPin,
                  public IQualityControl,
                  public IAMStreamConfig,
                  public IKsPropertySet
{
    LONG          m_ref = 1;
    CameraFilter* m_filter;
    IPin*         m_connected = nullptr;
    IMemInputPin* m_memInput  = nullptr;
    SimpleAllocator* m_alloc  = nullptr;

    std::atomic<bool> m_running{false};
    HANDLE            m_thread  = nullptr;
    HANDLE            m_stopEvt = nullptr;

    LONGLONG          m_frameNum = 0;
    AM_MEDIA_TYPE     m_mt{};

    void FillMediaType(AM_MEDIA_TYPE* pmt, DWORD w=1920, DWORD h=1080)
    {
        ZeroMemory(pmt, sizeof(AM_MEDIA_TYPE));
        pmt->majortype  = MEDIATYPE_Video;
        pmt->subtype    = MEDIASUBTYPE_RGB32;
        pmt->formattype = FORMAT_VideoInfo;
        pmt->bFixedSizeSamples    = TRUE;
        pmt->bTemporalCompression = FALSE;
        pmt->lSampleSize = w*h*4;

        auto* vi = reinterpret_cast<VIDEOINFOHEADER*>(
            CoTaskMemAlloc(sizeof(VIDEOINFOHEADER)));
        ZeroMemory(vi, sizeof(VIDEOINFOHEADER));
        vi->AvgTimePerFrame = 333333;
        vi->bmiHeader.biSize        = sizeof(BITMAPINFOHEADER);
        vi->bmiHeader.biWidth       = (LONG)w;
        vi->bmiHeader.biHeight      = (LONG)h;  // bottom-up
        vi->bmiHeader.biPlanes      = 1;
        vi->bmiHeader.biBitCount    = 32;
        vi->bmiHeader.biCompression = BI_RGB;
        vi->bmiHeader.biSizeImage   = w*h*4;
        pmt->pbFormat = reinterpret_cast<BYTE*>(vi);
        pmt->cbFormat = sizeof(VIDEOINFOHEADER);
    }

    static void FreeMediaType(AM_MEDIA_TYPE* pmt)
    {
        if(pmt->pbFormat){CoTaskMemFree(pmt->pbFormat);pmt->pbFormat=nullptr;}
        if(pmt->pUnk){pmt->pUnk->Release();pmt->pUnk=nullptr;}
    }

    static AM_MEDIA_TYPE* CopyMediaType(const AM_MEDIA_TYPE* src)
    {
        auto* dst=reinterpret_cast<AM_MEDIA_TYPE*>(CoTaskMemAlloc(sizeof(AM_MEDIA_TYPE)));
        *dst=*src;
        if(src->cbFormat&&src->pbFormat){
            dst->pbFormat=reinterpret_cast<BYTE*>(CoTaskMemAlloc(src->cbFormat));
            memcpy(dst->pbFormat,src->pbFormat,src->cbFormat);
        }
        return dst;
    }

    static DWORD WINAPI ThreadProc(void* p)
    {
        static_cast<CameraPin*>(p)->FrameLoop();
        return 0;
    }
    void FrameLoop();

public:
    explicit CameraPin(CameraFilter* f) : m_filter(f)
    {
        FillMediaType(&m_mt);
        m_stopEvt = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    }
    ~CameraPin()
    {
        FreeMediaType(&m_mt);
        if(m_connected){m_connected->Release();m_connected=nullptr;}
        if(m_memInput) {m_memInput->Release(); m_memInput=nullptr;}
        if(m_alloc)    {m_alloc->Release();     m_alloc=nullptr;}
        if(m_stopEvt)  {CloseHandle(m_stopEvt); m_stopEvt=nullptr;}
    }

    void StartStreaming()
    {
        if(m_running.exchange(true))return;
        ResetEvent(m_stopEvt);
        if(m_alloc)m_alloc->Commit();
        m_thread=CreateThread(nullptr,0,ThreadProc,this,0,nullptr);
        VCamLog("CameraPin: StartStreaming thread=%p", m_thread);
    }
    void StopStreaming()
    {
        if(!m_running.exchange(false))return;
        SetEvent(m_stopEvt);
        if(m_thread){WaitForSingleObject(m_thread,3000);CloseHandle(m_thread);m_thread=nullptr;}
        if(m_alloc)m_alloc->Decommit();
        VCamLog("CameraPin: StopStreaming done");
    }

    // IUnknown
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override
    {
        if(!ppv)return E_POINTER;
        if(riid==IID_IUnknown||riid==IID_IPin)
            {*ppv=static_cast<IPin*>(this);AddRef();return S_OK;}
        if(riid==IID_IQualityControl)
            {*ppv=static_cast<IQualityControl*>(this);AddRef();return S_OK;}
        if(riid==__uuidof(IAMStreamConfig))
            {*ppv=static_cast<IAMStreamConfig*>(this);AddRef();return S_OK;}
        if(riid==IID_IKsPropertySet)
            {*ppv=static_cast<IKsPropertySet*>(this);AddRef();return S_OK;}
        VCamLog("CameraPin::QI MISS {%08X-%04X-%04X}",riid.Data1,riid.Data2,riid.Data3);
        *ppv=nullptr;return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef()  override { return InterlockedIncrement(&m_ref); }
    ULONG STDMETHODCALLTYPE Release() override {
        LONG r=InterlockedDecrement(&m_ref);if(r==0)delete this;return r;
    }

    // IPin
    STDMETHODIMP Connect(IPin* pReceivePin, const AM_MEDIA_TYPE* pmt) override
    {
        VCamLog("CameraPin::Connect called");
        if(m_connected)return VFW_E_ALREADY_CONNECTED;
        if(!pReceivePin)return E_POINTER;

        // Try supplied type, then our preferred type
        const AM_MEDIA_TYPE* tryMt = pmt;
        AM_MEDIA_TYPE preferred{};
        if(!tryMt){ FillMediaType(&preferred); tryMt=&preferred; }

        HRESULT hr = pReceivePin->ReceiveConnection(static_cast<IPin*>(this), tryMt);
        if(!pmt) FreeMediaType(&preferred);

        if(FAILED(hr)){
            VCamLog("CameraPin::Connect ReceiveConnection failed: 0x%08X",(unsigned)hr);
            return hr;
        }
        m_connected=pReceivePin; m_connected->AddRef();
        if(SUCCEEDED(pReceivePin->QueryInterface(IID_IMemInputPin,
                reinterpret_cast<void**>(&m_memInput))))
        {
            m_alloc=new SimpleAllocator();
            ALLOCATOR_PROPERTIES req{},act{};
            req.cBuffers=2; req.cbBuffer=1920*1080*4; req.cbAlign=1;
            m_alloc->SetProperties(&req,&act);
            m_memInput->NotifyAllocator(m_alloc,FALSE);
        }
        VCamLog("CameraPin::Connect OK");
        return S_OK;
    }
    STDMETHODIMP ReceiveConnection(IPin*,const AM_MEDIA_TYPE*) override
        { return E_UNEXPECTED; }
    STDMETHODIMP Disconnect() override
    {
        VCamLog("CameraPin::Disconnect");
        StopStreaming();
        if(m_connected){m_connected->Release();m_connected=nullptr;}
        if(m_memInput) {m_memInput->Release(); m_memInput=nullptr;}
        return S_OK;
    }
    STDMETHODIMP ConnectedTo(IPin** pp) override
    {
        if(!m_connected){*pp=nullptr;return VFW_E_NOT_CONNECTED;}
        *pp=m_connected;m_connected->AddRef();return S_OK;
    }
    STDMETHODIMP ConnectionMediaType(AM_MEDIA_TYPE* pmt) override
    {
        if(!m_connected)return VFW_E_NOT_CONNECTED;
        *pmt=m_mt;
        if(m_mt.pbFormat){
            pmt->pbFormat=reinterpret_cast<BYTE*>(CoTaskMemAlloc(m_mt.cbFormat));
            memcpy(pmt->pbFormat,m_mt.pbFormat,m_mt.cbFormat);
        }
        return S_OK;
    }
    STDMETHODIMP QueryPinInfo(PIN_INFO* p) override;
    STDMETHODIMP QueryDirection(PIN_DIRECTION* d) override
        { *d=PINDIR_OUTPUT; return S_OK; }
    STDMETHODIMP QueryId(LPWSTR* lpId) override
    {
        *lpId=static_cast<LPWSTR>(CoTaskMemAlloc(14));
        wcscpy_s(*lpId,7,L"Output");
        return S_OK;
    }
    STDMETHODIMP QueryAccept(const AM_MEDIA_TYPE* pmt) override
    {
        if(pmt->majortype!=MEDIATYPE_Video)return S_FALSE;
        if(pmt->subtype!=MEDIASUBTYPE_RGB32&&pmt->subtype!=MEDIASUBTYPE_ARGB32)return S_FALSE;
        return S_OK;
    }
    STDMETHODIMP EnumMediaTypes(IEnumMediaTypes** pp) override;
    STDMETHODIMP QueryInternalConnections(IPin**,ULONG*) override { return E_NOTIMPL; }
    STDMETHODIMP EndOfStream() override { return S_OK; }
    STDMETHODIMP BeginFlush()  override { return S_OK; }
    STDMETHODIMP EndFlush()    override { return S_OK; }
    STDMETHODIMP NewSegment(REFERENCE_TIME,REFERENCE_TIME,double) override { return S_OK; }

    // IQualityControl
    STDMETHODIMP Notify(IBaseFilter*,Quality) override { return S_OK; }
    STDMETHODIMP SetSink(IQualityControl*)   override { return S_OK; }

    // IAMStreamConfig
    STDMETHODIMP SetFormat(AM_MEDIA_TYPE* pmt) override
    {
        if(!pmt)return E_POINTER;
        FreeMediaType(&m_mt);
        m_mt=*pmt;
        if(pmt->pbFormat){
            m_mt.pbFormat=reinterpret_cast<BYTE*>(CoTaskMemAlloc(pmt->cbFormat));
            memcpy(m_mt.pbFormat,pmt->pbFormat,pmt->cbFormat);
        }
        return S_OK;
    }
    STDMETHODIMP GetFormat(AM_MEDIA_TYPE** pp) override
    {
        *pp=CopyMediaType(&m_mt);
        return S_OK;
    }
    STDMETHODIMP GetNumberOfCapabilities(int* piCount,int* piSize) override
    {
        *piCount=1; *piSize=sizeof(VIDEO_STREAM_CONFIG_CAPS); return S_OK;
    }
    STDMETHODIMP GetStreamCaps(int idx,AM_MEDIA_TYPE** ppmt,BYTE* pSCC) override
    {
        if(idx!=0)return S_FALSE;
        *ppmt=reinterpret_cast<AM_MEDIA_TYPE*>(CoTaskMemAlloc(sizeof(AM_MEDIA_TYPE)));
        FillMediaType(*ppmt);
        if(pSCC){
            auto* c=reinterpret_cast<VIDEO_STREAM_CONFIG_CAPS*>(pSCC);
            ZeroMemory(c,sizeof(*c));
            c->guid=FORMAT_VideoInfo;
            c->InputSize.cx=c->MinOutputSize.cx=c->MaxOutputSize.cx=1920;
            c->InputSize.cy=c->MinOutputSize.cy=c->MaxOutputSize.cy=1080;
            c->MinCroppingSize=c->MaxCroppingSize=c->InputSize;
            c->CropGranularityX=c->CropGranularityY=1;
            c->OutputGranularityX=c->OutputGranularityY=1;
            c->MinFrameInterval=c->MaxFrameInterval=333333;
            c->MinBitsPerSecond=c->MaxBitsPerSecond=1920*1080*4*30*8;
        }
        return S_OK;
    }

    // IKsPropertySet  (stub — return S_OK/E_PROP_SET_UNSUPPORTED as appropriate)
    STDMETHODIMP Set(REFGUID guidPropSet, DWORD dwID,
        LPVOID pInstanceData, DWORD cbInstanceData,
        LPVOID pPropData,     DWORD cbPropData) override
    {
        VCamLog("IKsPropertySet::Set {%08X} id=%lu", guidPropSet.Data1, dwID);
        return E_PROP_SET_UNSUPPORTED;
    }
    STDMETHODIMP Get(REFGUID guidPropSet, DWORD dwID,
        LPVOID pInstanceData, DWORD cbInstanceData,
        LPVOID pPropData,     DWORD cbPropData,
        DWORD* pcbReturned) override
    {
        VCamLog("IKsPropertySet::Get {%08X} id=%lu", guidPropSet.Data1, dwID);
        // AMPROPERTY_PIN_CATEGORY — return PIN_CATEGORY_CAPTURE
        // {9B00F101-1567-11d1-B3F1-00AA003761C5}
        static const GUID AMPROPSETID_Pin =
            {0x9B00F101,0x1567,0x11d1,{0xB3,0xF1,0x00,0xAA,0x00,0x37,0x61,0xC5}};
        if(guidPropSet==AMPROPSETID_Pin && dwID==0 /*AMPROPERTY_PIN_CATEGORY*/)
        {
            if(pPropData&&cbPropData>=sizeof(GUID))
                *reinterpret_cast<GUID*>(pPropData) = PIN_CATEGORY_CAPTURE;
            if(pcbReturned)*pcbReturned=sizeof(GUID);
            return S_OK;
        }
        return E_PROP_SET_UNSUPPORTED;
    }
    STDMETHODIMP QuerySupported(REFGUID guidPropSet, DWORD dwID,
        DWORD* pTypeSupport) override
    {
        static const GUID AMPROPSETID_Pin =
            {0x9B00F101,0x1567,0x11d1,{0xB3,0xF1,0x00,0xAA,0x00,0x37,0x61,0xC5}};
        if(guidPropSet==AMPROPSETID_Pin && dwID==0){
            if(pTypeSupport)*pTypeSupport=KSPROPERTY_SUPPORT_GET;
            return S_OK;
        }
        return E_PROP_SET_UNSUPPORTED;
    }
};

// ===========================================================================
// EnumPins
// ===========================================================================
class EnumPins : public IEnumPins
{
    LONG  m_ref=1; ULONG m_pos=0; IPin* m_pin;
public:
    explicit EnumPins(IPin* p):m_pin(p){m_pin->AddRef();}
    ~EnumPins(){m_pin->Release();}
    STDMETHODIMP QueryInterface(REFIID riid,void** ppv) override {
        if(riid==IID_IUnknown||riid==IID_IEnumPins){*ppv=this;AddRef();return S_OK;}
        *ppv=nullptr;return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef()  override{return InterlockedIncrement(&m_ref);}
    ULONG STDMETHODCALLTYPE Release() override{LONG r=InterlockedDecrement(&m_ref);if(!r)delete this;return r;}
    STDMETHODIMP Next(ULONG n,IPin** pp,ULONG* pf) override {
        ULONG f=0;
        while(f<n&&m_pos<1){pp[f++]=m_pin;m_pin->AddRef();++m_pos;}
        if(pf)*pf=f; return f==n?S_OK:S_FALSE;
    }
    STDMETHODIMP Skip(ULONG n) override{m_pos+=n;return m_pos<=1?S_OK:S_FALSE;}
    STDMETHODIMP Reset() override{m_pos=0;return S_OK;}
    STDMETHODIMP Clone(IEnumPins** pp) override{*pp=new EnumPins(m_pin);return S_OK;}
};

// ===========================================================================
// EnumMediaTypes
// ===========================================================================
class EnumMediaTypesImpl : public IEnumMediaTypes
{
    LONG m_ref=1; ULONG m_pos=0; CameraPin* m_pin;
public:
    explicit EnumMediaTypesImpl(CameraPin* p):m_pin(p){m_pin->AddRef();}
    ~EnumMediaTypesImpl(){m_pin->Release();}
    STDMETHODIMP QueryInterface(REFIID riid,void** ppv) override {
        if(riid==IID_IUnknown||riid==IID_IEnumMediaTypes){*ppv=this;AddRef();return S_OK;}
        *ppv=nullptr;return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef()  override{return InterlockedIncrement(&m_ref);}
    ULONG STDMETHODCALLTYPE Release() override{LONG r=InterlockedDecrement(&m_ref);if(!r)delete this;return r;}
    STDMETHODIMP Next(ULONG n,AM_MEDIA_TYPE** pp,ULONG* pf) override {
        ULONG f=0;
        while(f<n&&m_pos<1){
            m_pin->GetStreamCaps(0,&pp[f],nullptr);
            ++f;++m_pos;
        }
        if(pf)*pf=f; return f==n?S_OK:S_FALSE;
    }
    STDMETHODIMP Skip(ULONG n) override{m_pos+=n;return S_OK;}
    STDMETHODIMP Reset() override{m_pos=0;return S_OK;}
    STDMETHODIMP Clone(IEnumMediaTypes** pp) override{*pp=new EnumMediaTypesImpl(m_pin);return S_OK;}
};

// ===========================================================================
// CameraFilter
// ===========================================================================
class CameraFilter : public IBaseFilter, public IAMFilterMiscFlags
{
    LONG          m_ref=1;
    IFilterGraph* m_graph=nullptr;
    FILTER_STATE  m_state=State_Stopped;
    std::wstring  m_name=L"V-Link Station Camera";
    CameraPin*    m_pin=nullptr;

public:
    CameraFilter()
    {
        m_pin=new CameraPin(this);
        VCamLog("CameraFilter created (pid=%lu)", GetCurrentProcessId());
    }
    ~CameraFilter()
    {
        if(m_pin){m_pin->Release();m_pin=nullptr;}
        VCamLog("CameraFilter destroyed");
    }

    STDMETHODIMP QueryInterface(REFIID riid,void** ppv) override
    {
        if(!ppv)return E_POINTER;
        if(riid==IID_IUnknown||riid==IID_IPersist||
           riid==IID_IMediaFilter||riid==IID_IBaseFilter)
            {*ppv=static_cast<IBaseFilter*>(this);AddRef();return S_OK;}
        if(riid==__uuidof(IAMFilterMiscFlags))
            {*ppv=static_cast<IAMFilterMiscFlags*>(this);AddRef();return S_OK;}
        VCamLog("CameraFilter::QI MISS {%08X-%04X-%04X}",riid.Data1,riid.Data2,riid.Data3);
        *ppv=nullptr;return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef()  override{return InterlockedIncrement(&m_ref);}
    ULONG STDMETHODCALLTYPE Release() override{
        LONG r=InterlockedDecrement(&m_ref);if(r==0)delete this;return r;
    }

    // IPersist
    STDMETHODIMP GetClassID(CLSID* p) override{*p=CLSID_VLinkCameraSource;return S_OK;}

    // IMediaFilter
    STDMETHODIMP Stop() override
    {
        VCamLog("CameraFilter::Stop");
        m_pin->StopStreaming();
        m_state=State_Stopped;
        return S_OK;
    }
    STDMETHODIMP Pause() override
    {
        VCamLog("CameraFilter::Pause");
        m_state=State_Paused;
        return S_OK;
    }
    STDMETHODIMP Run(REFERENCE_TIME) override
    {
        VCamLog("CameraFilter::Run");
        m_state=State_Running;
        m_pin->StartStreaming();
        return S_OK;
    }
    STDMETHODIMP GetState(DWORD,FILTER_STATE* p) override{*p=m_state;return S_OK;}
    STDMETHODIMP SetSyncSource(IReferenceClock*) override{return S_OK;}
    STDMETHODIMP GetSyncSource(IReferenceClock** p) override{*p=nullptr;return S_OK;}

    // IBaseFilter
    STDMETHODIMP EnumPins(IEnumPins** pp) override
        {*pp=new ::EnumPins(m_pin);return S_OK;}
    STDMETHODIMP FindPin(LPCWSTR Id,IPin** pp) override
    {
        if(wcscmp(Id,L"Output")==0){*pp=m_pin;m_pin->AddRef();return S_OK;}
        *pp=nullptr;return VFW_E_NOT_FOUND;
    }
    STDMETHODIMP QueryFilterInfo(FILTER_INFO* p) override
    {
        wcsncpy_s(p->achName,MAX_FILTER_NAME,m_name.c_str(),_TRUNCATE);
        p->pGraph=m_graph;if(m_graph)m_graph->AddRef();
        return S_OK;
    }
    STDMETHODIMP JoinFilterGraph(IFilterGraph* pGraph,LPCWSTR pName) override
    {
        VCamLog("CameraFilter::JoinFilterGraph");
        m_graph=pGraph;
        if(pName)m_name=pName;
        return S_OK;
    }
    STDMETHODIMP QueryVendorInfo(LPWSTR*) override{return E_NOTIMPL;}

    // IAMFilterMiscFlags
    ULONG STDMETHODCALLTYPE GetMiscFlags() override
        {return AM_FILTER_MISC_FLAGS_IS_SOURCE;}
};

// ---------------------------------------------------------------------------
// CameraPin methods needing CameraFilter fully defined
// ---------------------------------------------------------------------------
STDMETHODIMP CameraPin::QueryPinInfo(PIN_INFO* p)
{
    wcsncpy_s(p->achName,MAX_PIN_NAME,L"Output",_TRUNCATE);
    p->dir=PINDIR_OUTPUT;
    p->pFilter=m_filter;
    if(m_filter)m_filter->AddRef();
    return S_OK;
}

STDMETHODIMP CameraPin::EnumMediaTypes(IEnumMediaTypes** pp)
{
    *pp=new EnumMediaTypesImpl(this);
    return S_OK;
}

// ---------------------------------------------------------------------------
// FrameLoop
// ---------------------------------------------------------------------------
void CameraPin::FrameLoop()
{
    VCamLog("FrameLoop start (pid=%lu)", GetCurrentProcessId());

    HANDLE hMap = OpenFileMappingW(FILE_MAP_READ, FALSE, VCAM_MAP_NAME);
    HANDLE hEvt = OpenEventW(SYNCHRONIZE, FALSE, VCAM_EVENT_NAME);
    const VCamShmHeader* mem = nullptr;

    if(hMap && hEvt){
        mem = static_cast<const VCamShmHeader*>(
            MapViewOfFile(hMap, FILE_MAP_READ, 0, 0, VCAM_SHM_SIZE));
    }
    if(!mem){
        VCamLog("FrameLoop: shared memory not available (hMap=%p hEvt=%p)", hMap, hEvt);
        if(hMap){CloseHandle(hMap);hMap=nullptr;}
        if(hEvt){CloseHandle(hEvt);hEvt=nullptr;}
    } else {
        VCamLog("FrameLoop: shared memory OK");
    }

    REFERENCE_TIME ts=0;
    const REFERENCE_TIME dur=333333;
    LONGLONG frameCount=0;

    while(m_running.load())
    {
        // If shared memory unavailable, wait for stop or retry every 500ms
        if(!mem){
            if(WaitForSingleObject(m_stopEvt,500)==WAIT_OBJECT_0)break;
            // Retry opening shared memory
            hMap=OpenFileMappingW(FILE_MAP_READ,FALSE,VCAM_MAP_NAME);
            hEvt=OpenEventW(SYNCHRONIZE,FALSE,VCAM_EVENT_NAME);
            if(hMap&&hEvt){
                mem=static_cast<const VCamShmHeader*>(
                    MapViewOfFile(hMap,FILE_MAP_READ,0,0,VCAM_SHM_SIZE));
                if(mem)VCamLog("FrameLoop: shared memory connected (retry)");
                else{CloseHandle(hMap);hMap=nullptr;CloseHandle(hEvt);hEvt=nullptr;}
            }else{
                if(hMap){CloseHandle(hMap);hMap=nullptr;}
                if(hEvt){CloseHandle(hEvt);hEvt=nullptr;}
            }
            continue;
        }

        // Wait for new frame signal or stop
        HANDLE handles[2]={m_stopEvt, hEvt};
        DWORD wr=WaitForMultipleObjects(2,handles,FALSE,200);
        if(wr==WAIT_OBJECT_0)break;          // stop
        if(wr==WAIT_TIMEOUT)continue;
        if(!m_running.load())break;

        if(!m_connected||!m_memInput||!m_alloc)continue;

        UINT32 w=mem->width, h=mem->height;
        if(w==0||h==0||w>1920||h>1080)continue;

        DWORD frameBytes=w*h*4;

        IMediaSample* sample=nullptr;
        REFERENCE_TIME tStart=ts, tEnd=ts+dur;
        if(FAILED(m_alloc->GetBuffer(&sample,&tStart,&tEnd,0)))continue;

        BYTE* dst=nullptr;
        if(SUCCEEDED(sample->GetPointer(&dst)))
            memcpy(dst, mem+1, frameBytes);
        sample->SetActualDataLength(frameBytes);
        sample->SetTime(&tStart,&tEnd);
        sample->SetSyncPoint(TRUE);
        sample->SetDiscontinuity(frameCount==0?TRUE:FALSE);

        HRESULT hr=m_memInput->Receive(sample);
        sample->Release();

        if(FAILED(hr)){
            VCamLog("FrameLoop: Receive failed 0x%08X",(unsigned)hr);
            break;
        }
        ts+=dur;
        ++frameCount;
        if(frameCount==1||frameCount%300==0)
            VCamLog("FrameLoop: delivered %lld frames (%ux%u)",frameCount,w,h);
    }

    if(mem) UnmapViewOfFile(mem);
    if(hMap)CloseHandle(hMap);
    if(hEvt)CloseHandle(hEvt);
    VCamLog("FrameLoop exit after %lld frames", m_frameNum);
}

// ===========================================================================
// ClassFactory
// ===========================================================================
class ClassFactory : public IClassFactory
{
    LONG m_ref=1;
public:
    STDMETHODIMP QueryInterface(REFIID riid,void** ppv) override {
        if(riid==IID_IUnknown||riid==IID_IClassFactory){*ppv=this;AddRef();return S_OK;}
        *ppv=nullptr;return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef()  override{return InterlockedIncrement(&m_ref);}
    ULONG STDMETHODCALLTYPE Release() override{LONG r=InterlockedDecrement(&m_ref);if(!r)delete this;return r;}
    STDMETHODIMP CreateInstance(IUnknown* outer,REFIID riid,void** ppv) override
    {
        VCamLog("ClassFactory::CreateInstance (pid=%lu)",GetCurrentProcessId());
        if(outer)return CLASS_E_NOAGGREGATION;
        auto* f=new CameraFilter();
        HRESULT hr=f->QueryInterface(riid,ppv);
        f->Release();
        return hr;
    }
    STDMETHODIMP LockServer(BOOL) override{return S_OK;}
};

// ===========================================================================
// DLL entry points
// ===========================================================================
BOOL WINAPI DllMain(HINSTANCE, DWORD reason, LPVOID)
{
    if(reason==DLL_PROCESS_ATTACH)
        VCamLog("DllMain: ATTACH (pid=%lu)", GetCurrentProcessId());
    return TRUE;
}

extern "C" HRESULT __stdcall DllGetClassObject(REFCLSID rclsid, REFIID riid, void** ppv)
{
    VCamLog("DllGetClassObject (pid=%lu) riid={%08X}", GetCurrentProcessId(), riid.Data1);
    if(rclsid!=CLSID_VLinkCameraSource)return CLASS_E_CLASSNOTAVAILABLE;
    auto* f=new ClassFactory();
    HRESULT hr=f->QueryInterface(riid,ppv);
    f->Release();
    return hr;
}

extern "C" HRESULT __stdcall DllCanUnloadNow() { return S_FALSE; }
