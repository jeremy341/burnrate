@echo off
rem Portable launcher used by the fallback Windows zip (no desktop shell built).
rem Prefers burnrate.exe (Tauri shell); otherwise serves the bundled web bundle
rem and opens the default browser. Close the server window to stop Burnrate.
setlocal
set "HERE=%~dp0"

if not defined BURNRATE_PORT set "BURNRATE_PORT=13790"
rem Both launchers need the bundled web dir; the shell only finds <exe>/dist/web
rem by itself, and the standalone server has no other way to locate it.
set "BURNRATE_WEB=%HERE%web"

if exist "%HERE%burnrate.exe" (
  start "" "%HERE%burnrate.exe"
  exit /b 0
)

start "Burnrate server" /min "%HERE%burnrate-server.exe"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%BURNRATE_PORT%/"
