; Cortex NSIS customization.
;
; The installer only installs files and creates shortcuts; agent / Skill setup
; happens later from the desktop app's MCP page ("Connect agents" button) or by
; running `ctx init` manually. No custom installer pages are added.
;
; Included by electron-builder for BOTH the installer and the uninstaller
; compile (the uninstaller is built by recompiling installer.nsi with
; BUILD_UNINSTALLER defined). Keep installer-only UI in the BUILD_UNINSTALLER
; guard; `customUnInstall` must stay OUTSIDE it, otherwise the macro is not
; defined during the uninstaller compile and the cleanup silently disappears.
;
; Per-user install layout (%LOCALAPPDATA%\Programs\Cortex):
;   Cortex.exe                     Electron shell
;   bin\node.exe  ctx.cjs  mcp-stdio.cjs  ctx-path.cjs  skills\  node_modules\
;   bin\ctx.cmd                    CLI wrapper (also a Start Menu shortcut)
;
; The database lives outside the app (~/.cortex/data.db), so uninstalling never
; touches user data.

!include "LogicLib.nsh"

!macro customInstall
  SetShellVarContext current

  WriteRegStr HKCU "Software\Cortex" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Cortex" "Version" "${VERSION}"
  DetailPrint "Cortex: HKCU\Software\Cortex\InstallLocation=$INSTDIR"

  ; electron-builder already creates "$SMPROGRAMS\Cortex.lnk" (shortcutName);
  ; only create it as a fallback so we never override its icon / AppUserModelID.
  ${IfNot} ${FileExists} "$SMPROGRAMS\Cortex.lnk"
    CreateShortCut "$SMPROGRAMS\Cortex.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
  CreateShortCut "$SMPROGRAMS\Cortex CLI.lnk" "$INSTDIR\bin\ctx.cmd" "" "" 0
  DetailPrint "Cortex: 已创建开始菜单快捷方式（Cortex / Cortex CLI）"
!macroend

; NOTE: outside `!ifndef BUILD_UNINSTALLER` on purpose — this macro is expanded
; by uninstaller.nsh during the uninstaller compile.
!macro customUnInstall
  SetShellVarContext current

  DeleteRegKey HKCU "Software\Cortex"
  Delete "$SMPROGRAMS\Cortex CLI.lnk"
  Delete "$SMPROGRAMS\Cortex.lnk"

  ; Older installs may have added bin to the current-user PATH; clean that up.
  ${If} ${FileExists} "$INSTDIR\bin\node.exe"
    ExecWait '"$INSTDIR\bin\node.exe" "$INSTDIR\bin\ctx-path.cjs" remove "$INSTDIR\bin"'
    DetailPrint "Cortex: 已清理旧版本写入的当前用户 PATH"
  ${EndIf}

  ; %USERPROFILE%\.cortex\data.db is user data: never deleted on uninstall.
  DetailPrint "Cortex: 保留用户数据库 %USERPROFILE%\.cortex\data.db"
!macroend
