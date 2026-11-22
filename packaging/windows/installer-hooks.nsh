; Hooks for the primary Tauri NSIS installer (bundle.windows.nsis.installerHooks).
; Paths are resolved relative to src-tauri, like the other bundle.conf.json paths.
; The fallback standalone NSIS script (burnrate.nsi) repeats the same registrations.
; Per-user install ($LOCALAPPDATA\Programs\Burnrate, no admin prompt). The uninstaller never touches
; %APPDATA%\burnrate (settings, keys, history); only the registry keys written here are removed.

!macro NSIS_HOOK_POSTINSTALL
  ; burnrate:// deep links are parsed by src-tauri/src/deeplink.rs.
  WriteRegStr HKCU "Software\Classes\burnrate" "" "URL:Burnrate protocol"
  WriteRegStr HKCU "Software\Classes\burnrate" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\burnrate\DefaultIcon" "" '"$INSTDIR\burnrate.exe",0'
  WriteRegStr HKCU "Software\Classes\burnrate\shell\open\command" "" '"$INSTDIR\burnrate.exe" "%1"'

  ; WinRT toasts (notify.rs) use the AUMID "Burnrate". Register it for the user so an
  ; unpackaged app can raise toasts. The shell also (re)writes this key at every start.
  WriteRegStr HKCU "Software\Classes\AppUserModelId\Burnrate" "DisplayName" "Burnrate"
  WriteRegStr HKCU "Software\Classes\AppUserModelId\Burnrate" "IconUri" "$INSTDIR\burnrate.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\burnrate"
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\Burnrate"
  ; Launch-at-login value written by the shell (autostart.rs); the app is gone, so is its Run entry.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Burnrate"
!macroend
