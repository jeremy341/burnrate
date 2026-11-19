# Burnrate: starts the local server (Rust) and opens it in an app-style window.
$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot
$exe     = Join-Path $root 'server-rs\target\release\burnrate-server.exe'
$port    = 13790
$url     = "http://127.0.0.1:$port"
$edge    = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $root 'data\window-profile'

function Test-Up { try { Invoke-WebRequest "$url/" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null; $true } catch { $false } }

if (-not (Test-Up)) {
  if (-not (Test-Path $exe)) { throw "Build the server first: cargo build --release --manifest-path server-rs\Cargo.toml" }
  $env:BURNRATE_PORT = $port
  Start-Process $exe -WindowStyle Hidden -WorkingDirectory $root
  for ($i = 0; $i -lt 60 -and -not (Test-Up); $i++) { Start-Sleep -Milliseconds 250 }
}

New-Item -ItemType Directory -Force $profile | Out-Null
Start-Process $edge -ArgumentList "--app=$url", "--user-data-dir=$profile", '--window-size=1100,860'
