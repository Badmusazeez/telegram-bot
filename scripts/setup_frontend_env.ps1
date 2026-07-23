# Create frontend/.env for FoldPredict (Windows-safe, no UTF-8 BOM).
# Run from project root OR any folder:
#   powershell -ExecutionPolicy Bypass -File scripts\setup_frontend_env.ps1
# Optional:
#   powershell -ExecutionPolicy Bypass -File scripts\setup_frontend_env.ps1 -Address 0xYourContract

param(
  [string]$Address = "0x3029992164f4c7e64e7f29bc40a23f2521a5c95f",
  [string]$RpcUrl = "http://127.0.0.1:4000/api",
  [string]$Chain = "localnet"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root "frontend\package.json"))) {
  # Allow running when script lives next to frontend
  if (Test-Path (Join-Path (Get-Location) "frontend\package.json")) {
    $root = (Get-Location).Path
  } else {
    Write-Host "ERROR: Could not find frontend/package.json. cd to the project root first." -ForegroundColor Red
    exit 1
  }
}

$frontend = Join-Path $root "frontend"
$envPath = Join-Path $frontend ".env"

if ($Address -notmatch '^0x[a-fA-F0-9]{40}$') {
  Write-Host "ERROR: Address must look like 0x + 40 hex chars. Got: $Address" -ForegroundColor Red
  exit 1
}

$lines = @(
  "VITE_CONTRACT_ADDRESS=$Address",
  "VITE_RPC_URL=$RpcUrl",
  "VITE_CHAIN=$Chain"
)

# WriteAllLines uses UTF-8 without BOM on modern .NET / PowerShell Core.
# On Windows PowerShell 5.x, force no-BOM UTF-8 via UTF8Encoding(false).
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllLines($envPath, $lines, $utf8NoBom)

Write-Host "Wrote $envPath" -ForegroundColor Green
Get-Content $envPath | ForEach-Object { Write-Host "  $_" }

# Remove common mistake file
$bad = Join-Path $frontend ".env.txt"
if (Test-Path $bad) {
  Remove-Item $bad -Force
  Write-Host "Removed leftover .env.txt" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  1) Make sure GLSim is running on port 4000"
Write-Host "  2) cd frontend"
Write-Host "  3) npm run dev"
Write-Host "  4) Open http://127.0.0.1:5173/  (or the port Vite prints)"
Write-Host ""
Write-Host "If market calls fail, deploy a fresh contract and re-run this script with -Address <new>."
