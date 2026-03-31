# Build script for vlink-wasm-video
# Run from repo root: ./packages/wasm-video/build.ps1

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Push-Location $scriptDir

Write-Host "Building vlink-wasm-video..." -ForegroundColor Cyan

# Ensure the wasm32 target is installed
rustup target add wasm32-unknown-unknown

# Release build
cargo build --target wasm32-unknown-unknown --release

$src = Join-Path $scriptDir "target\wasm32-unknown-unknown\release\vlink_wasm_video.wasm"
$dst = Join-Path $scriptDir "video_proc.wasm"

# Optional: optimise with wasm-opt (binaryen) if available
if (Get-Command wasm-opt -ErrorAction SilentlyContinue) {
    Write-Host "Running wasm-opt..." -ForegroundColor Cyan
    wasm-opt -Oz --strip-debug -o $dst $src
} else {
    Write-Host "wasm-opt not found, copying raw WASM (install binaryen for smaller output)" -ForegroundColor Yellow
    Copy-Item $src $dst -Force
}

$size = (Get-Item $dst).Length
Write-Host "Done: $dst  ($size bytes)" -ForegroundColor Green

Pop-Location
