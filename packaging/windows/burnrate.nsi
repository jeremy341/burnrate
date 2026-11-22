; Burnrate Windows installer (standalone makensis fallback).
;
; The normal path is the Tauri bundler with packaging/tauri/bundle.conf.json.
; This script exists so a release can still ship a per-user installer when the
; Tauri shell has not been built (server + built web bundle only).
;
; Build (nothing in this repo runs it automatically):
;   makensis /DPRODUCT_VERSION=0.1.0 /DPRODUCT_VERSION_QUAD=0.1.0.0 \
;            /DSTAGE_DIR=C:\path\to\stage /DOUT_DIR=C:\path\to\out \
;            packaging\windows\burnrate.nsi
;
; STAGE_DIR must contain burnrate.exe (desktop shell, optional but expected) or
; burnrate-server.exe plus web\, start.cmd and LICENSE.
; Per-user install ($LOCALAPPDATA\Programs\Burnrate): no admin prompt, no
; machine-wide registry keys. User data is never deleted by the uninstaller.

!include "MUI2.nsh"

!define APP_NAME "Burnrate"
!define APP_PUBLISHER "Burnrate"
!define APP_EXE "burnrate.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Burnrate"

!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.0.0"
!endif
!ifndef PRODUCT_VERSION_QUAD
  ; VIProductVersion needs four numeric parts; the release workflow passes the
  ; real value derived from the tag.
  !define PRODUCT_VERSION_QUAD "0.0.0.0"
!endif
!ifndef STAGE_DIR
  !define STAGE_DIR "..\..\dist\package"
!endif
!ifndef OUT_DIR
  !define OUT_DIR "."
!endif

Name "${APP_NAME} ${PRODUCT_VERSION}"
OutFile "${OUT_DIR}\Burnrate-${PRODUCT_VERSION}-x64-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"
RequestExecutionLevel user
Unicode true
SetCompressor /SOLID lzma
BrandingText "${APP_NAME} ${PRODUCT_VERSION}"

VIProductVersion "${PRODUCT_VERSION_QUAD}"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "Burnrate installer"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "LegalCopyright" "MIT licensed"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "German"

Section "Install" SEC_INSTALL
  SetOutPath "$INSTDIR"
  File /r "${STAGE_DIR}\*.*"

  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ; burnrate:// deep links (the shell handles them; see docs/CONTRACTS.md section 12).
  WriteRegStr HKCU "Software\Classes\burnrate" "" "URL:Burnrate protocol"
  WriteRegStr HKCU "Software\Classes\burnrate" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\burnrate\shell\open\command" "" '"$INSTDIR\${APP_EXE}" "%1"'

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"

  ; WinRT toasts: register the AUMID from notify.rs for the user (the shell also rewrites it at start).
  ; The old WScript.Shell shortcut-property approach never worked: that object has no AppUserModelID.
  WriteRegStr HKCU "Software\Classes\AppUserModelId\Burnrate" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Classes\AppUserModelId\Burnrate" "IconUri" "$INSTDIR\${APP_EXE}"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\Classes\burnrate"
  DeleteRegKey HKCU "Software\${APP_NAME}"

  ; User data (%APPDATA%\Burnrate, settings, keys) is intentionally kept.
  RMDir /r "$INSTDIR"
SectionEnd
