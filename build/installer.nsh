; Cortex NSIS customization.
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
!include "nsDialogs.nsh"
!include "FileFunc.nsh"

; Declared in both compiles: customInstall and customUnInstall both use it.
Var CortexExitCode

!ifndef BUILD_UNINSTALLER
  Var CortexAgents
  Var CortexSkillLang
  Var CortexAddToPath

  Var CortexDshCheckbox
  Var CortexCodexCheckbox
  Var CortexClaudeCheckbox
  Var CortexCursorCheckbox
  Var CortexZhRadio
  Var CortexEnRadio
  Var CortexPathCheckbox
  Var CortexProbe

  ; Defaults also cover silent installs (/S), where the custom page never runs:
  ; no agent is preselected, so a silent install never rewrites agent configs.
  !macro customInit
    StrCpy $CortexAgents ""
    StrCpy $CortexSkillLang "zh"
    StrCpy $CortexAddToPath "0"
  !macroend

  ; Custom page right after the install-directory page: agent selection,
  ; skill language and the optional current-user PATH entry.
  !macro customPageAfterChangeDir
    Page custom CortexOptionsPageCreate CortexOptionsPageLeave
  !macroend

  Function CortexOptionsPageCreate
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 30u "安装器会在开始菜单创建「Cortex」与「Cortex CLI」快捷方式（bin\ctx.cmd）。$\r$\n勾选要接入的 Agent 与 Skill 语言；安装完成后会自动运行 ctx init 写入 stdio MCP 配置、Skill 与强制规则。$\r$\n（ctx init 失败不会中断安装，只会给出提示。）"
    Pop $0

    ${NSD_CreateGroupBox} 0 32u 100% 58u "接入 Agent（可多选）"
    Pop $0

    ${NSD_CreateCheckbox} 8u 42u 92% 11u "DeepSeek Harness"
    Pop $CortexDshCheckbox
    ${GetFileAttributes} "$PROFILE\.dsh" "DIRECTORY" $CortexProbe
    ${If} $CortexProbe == 1
      ${NSD_SetState} $CortexDshCheckbox ${BST_CHECKED}
    ${EndIf}

    ${NSD_CreateCheckbox} 8u 53u 92% 11u "Codex CLI"
    Pop $CortexCodexCheckbox
    ${GetFileAttributes} "$PROFILE\.codex" "DIRECTORY" $CortexProbe
    ${If} $CortexProbe == 1
      ${NSD_SetState} $CortexCodexCheckbox ${BST_CHECKED}
    ${EndIf}

    ${NSD_CreateCheckbox} 8u 64u 92% 11u "Claude Code"
    Pop $CortexClaudeCheckbox
    ; Unchecked unless detectable: ~/.claude, ~/.claude.json or the CLI on PATH.
    StrCpy $CortexProbe "0"
    ${GetFileAttributes} "$PROFILE\.claude" "DIRECTORY" $0
    ${If} $0 == 1
      StrCpy $CortexProbe "1"
    ${EndIf}
    ${If} ${FileExists} "$PROFILE\.claude.json"
      StrCpy $CortexProbe "1"
    ${EndIf}
    SearchPath $0 "claude.cmd"
    ${If} $0 != ""
      StrCpy $CortexProbe "1"
    ${EndIf}
    SearchPath $0 "claude.exe"
    ${If} $0 != ""
      StrCpy $CortexProbe "1"
    ${EndIf}
    ${If} $CortexProbe == 1
      ${NSD_SetState} $CortexClaudeCheckbox ${BST_CHECKED}
    ${EndIf}

    ${NSD_CreateCheckbox} 8u 75u 92% 11u "Cursor"
    Pop $CortexCursorCheckbox
    ${GetFileAttributes} "$PROFILE\.cursor" "DIRECTORY" $CortexProbe
    ${If} $CortexProbe == 1
      ${NSD_SetState} $CortexCursorCheckbox ${BST_CHECKED}
    ${EndIf}

    ${NSD_CreateGroupBox} 0 96u 100% 34u "Skill 语言 / Skill language"
    Pop $0
    ${NSD_CreateRadioButton} 8u 105u 40% 12u "中文（默认）"
    Pop $CortexZhRadio
    ${NSD_SetState} $CortexZhRadio ${BST_CHECKED}
    ${NSD_CreateRadioButton} 8u 116u 40% 12u "English"
    Pop $CortexEnRadio

    ${NSD_CreateCheckbox} 0 135u 100% 12u "将 ctx 加入当前用户 PATH（默认不勾选，仅修改 HKCU 用户 PATH）"
    Pop $CortexPathCheckbox

    nsDialogs::Show
  FunctionEnd

  Function CortexOptionsPageLeave
    StrCpy $CortexAgents ""

    ${NSD_GetState} $CortexDshCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $CortexAgents "dsh"
    ${EndIf}

    ${NSD_GetState} $CortexCodexCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      ${If} $CortexAgents == ""
        StrCpy $CortexAgents "codex"
      ${Else}
        StrCpy $CortexAgents "$CortexAgents,codex"
      ${EndIf}
    ${EndIf}

    ${NSD_GetState} $CortexClaudeCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      ${If} $CortexAgents == ""
        StrCpy $CortexAgents "claude"
      ${Else}
        StrCpy $CortexAgents "$CortexAgents,claude"
      ${EndIf}
    ${EndIf}

    ${NSD_GetState} $CortexCursorCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      ${If} $CortexAgents == ""
        StrCpy $CortexAgents "cursor"
      ${Else}
        StrCpy $CortexAgents "$CortexAgents,cursor"
      ${EndIf}
    ${EndIf}

    StrCpy $CortexSkillLang "zh"
    ${NSD_GetState} $CortexEnRadio $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $CortexSkillLang "en"
    ${EndIf}

    StrCpy $CortexAddToPath "0"
    ${NSD_GetState} $CortexPathCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $CortexAddToPath "1"
    ${EndIf}
  FunctionEnd
!endif

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

  ${If} $CortexAgents != ""
    DetailPrint "Cortex: 正在接入 Agent ($CortexAgents, skill-lang=$CortexSkillLang) ..."
    ExecWait '"$INSTDIR\bin\node.exe" "$INSTDIR\bin\ctx.cjs" init --yes --agents $CortexAgents --skill-lang $CortexSkillLang' $CortexExitCode
    ${If} $CortexExitCode == 0
      DetailPrint "Cortex: ctx init 成功（$CortexAgents）"
    ${Else}
      DetailPrint "Cortex: ctx init 失败（退出码 $CortexExitCode），安装继续"
      MessageBox MB_ICONEXCLAMATION|MB_OK "Cortex 已安装完成，但自动接入 Agent 失败（退出码 $CortexExitCode）。$\r$\n$\r$\n可在开始菜单运行「Cortex CLI」，或手动执行：$\r$\nctx init --yes --agents $CortexAgents --skill-lang $CortexSkillLang$\r$\n$\r$\n以写入 MCP 配置、Skill 与强制规则。"
    ${EndIf}
  ${Else}
    DetailPrint "Cortex: 未选择 Agent，跳过 ctx init（稍后可运行 ctx init 接入）"
  ${EndIf}

  ${If} $CortexAddToPath == "1"
    ExecWait '"$INSTDIR\bin\node.exe" "$INSTDIR\bin\ctx-path.cjs" add "$INSTDIR\bin"' $CortexExitCode
    ${If} $CortexExitCode == 0
      DetailPrint "Cortex: 已把 $INSTDIR\bin 加入当前用户 PATH"
    ${Else}
      DetailPrint "Cortex: 写入当前用户 PATH 失败（退出码 $CortexExitCode），安装继续"
    ${EndIf}
  ${EndIf}
!macroend

; NOTE: outside `!ifndef BUILD_UNINSTALLER` on purpose — this macro is expanded
; by uninstaller.nsh during the uninstaller compile.
!macro customUnInstall
  SetShellVarContext current

  DeleteRegKey HKCU "Software\Cortex"
  Delete "$SMPROGRAMS\Cortex CLI.lnk"
  Delete "$SMPROGRAMS\Cortex.lnk"

  ${If} ${FileExists} "$INSTDIR\bin\node.exe"
    ExecWait '"$INSTDIR\bin\node.exe" "$INSTDIR\bin\ctx-path.cjs" remove "$INSTDIR\bin"' $CortexExitCode
    DetailPrint "Cortex: 当前用户 PATH 清理退出码 $CortexExitCode"
  ${EndIf}

  ; %USERPROFILE%\.cortex\data.db is user data: never deleted on uninstall.
  DetailPrint "Cortex: 保留用户数据库 %USERPROFILE%\.cortex\data.db"
!macroend
