; Viku NSIS additions (electron-builder include)
;  - uninstaller page with a checkbox "Also delete my projects, models and settings" (off by default)
;  - stops a running bundled engine (python from <install>\engine-env) before files are removed
;  - the engine environment (<install>\engine-env, made on first launch) goes away with $INSTDIR
; Silent uninstall keeps user data unless "--delete-app-data" is passed (electron-builder built-in).

!include nsDialogs.nsh
!include LogicLib.nsh

!ifdef BUILD_UNINSTALLER
  Var VikuDeleteData
  Var VikuDeleteBox

  Function un.vikuDataPageShow
    StrCpy $VikuDeleteData "0"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 36u "Viku will be removed from this PC. Your sermon projects, finished reels, downloaded models, Bibles and illustration library are kept in $APPDATA\Viku, so a reinstall picks up where you left off."
    Pop $0
    ${NSD_CreateCheckbox} 0 46u 100% 12u "Also delete my projects, models and settings ($APPDATA\Viku)"
    Pop $VikuDeleteBox
    ${NSD_CreateLabel} 12u 62u 95% 24u "Only tick this if you are sure: finished reels inside the projects folder are deleted too."
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function un.vikuDataPageLeave
    ${NSD_GetState} $VikuDeleteBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $VikuDeleteData "1"
    ${Else}
      StrCpy $VikuDeleteData "0"
    ${EndIf}
  FunctionEnd
!endif

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.vikuDataPageShow un.vikuDataPageLeave
!macroend

!macro vikuStopEngine
  ; the engine (and its python child) run from $INSTDIR\engine-env: stop them so the folder can be removed
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR\', 'OrdinalIgnoreCase') -and $$_.Id -ne $$PID } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0
!macroend

!macro customUnInstall
  !insertmacro vikuStopEngine
  ${ifNot} ${isUpdated}
    ${If} $VikuDeleteData == "1"
      SetShellVarContext current
      RMDir /r "$APPDATA\Viku"
    ${EndIf}
  ${endif}
!macroend
