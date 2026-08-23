param(
    [int]$Port = 8000,
    [string]$HostAddress = '127.0.0.1'
)

$env:PORT = $Port
$env:THREED_CORE_HOST = $HostAddress
Write-Host "Starting 3D Core Studio at http://${HostAddress}:$Port"
python "$PSScriptRoot\..\server.py"
