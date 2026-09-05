param(
    [int]$Port = 8000,
    [string]$HostAddress = '0.0.0.0'
)

# Runs the desktop (Electron) build in dev mode -- the browser-mode
# scripts/run.ps1 is untouched and still works exactly as before; this is
# additive, not a replacement. Requires `npm install` once first.
$env:PORT = $Port
$env:THREED_CORE_HOST = $HostAddress
Write-Host "Starting 3D Core Studio (Electron desktop build) on port $Port"
Push-Location "$PSScriptRoot\.."
try {
    npx electron .
} finally {
    Pop-Location
}
