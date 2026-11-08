; New installations use the display name. Existing installations keep their directory
; and its managed-update ledger, including custom paths without either product name.
!undef APP_FILENAME
!define APP_FILENAME "CC Space"

; The installed client asks before recycling this exact installer, even if it was renamed.
!macro customInstall
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Delete "$INSTDIR\resources\cc-space-install.ini"
  System::Call 'ole32::CoCreateGuid(g .r0) i.r1'
  ${If} $1 == 0
    ClearErrors
    FileOpen $1 "$EXEPATH" r
    ${IfNot} ${Errors}
      FileSeek $1 0 END $2
      System::Call 'kernel32::GetFileTime(p r1, p 0, p 0, *l .r3) i.r4'
      FileClose $1
      ${If} $4 != 0
        ClearErrors
        FileOpen $1 "$INSTDIR\resources\cc-space-install.ini" w
        ${IfNot} ${Errors}
          FileWriteUTF16LE /BOM $1 "[CCSpaceInstall]$\r$\nId=$0$\r$\nVersion=${VERSION}$\r$\nPath=$EXEPATH$\r$\nSize=$2$\r$\nWriteTime=$3$\r$\n"
          FileClose $1
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customPageAfterChangeDir
  ; Replace the builder's instfiles callback before MUI_PAGE_INSTFILES consumes it.
  !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !define MUI_PAGE_CUSTOMFUNCTION_PRE ccSpaceDirectoryPre
  Function ccSpaceDirectoryPre
    Push $0
    ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != ""
    ${AndIf} $INSTDIR == $0
      Pop $0
      Return
    ${EndIf}
    ${GetFileName} "$INSTDIR" $0
    ${If} $0 != "CC Desk Tunnel"
      Call instFilesPre
    ${EndIf}
    Pop $0
  FunctionEnd
!macroend
