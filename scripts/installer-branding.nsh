; New installations use the display name. Existing installations keep their directory
; and its managed-update ledger, including custom paths without either product name.
!undef APP_FILENAME
!define APP_FILENAME "CC SPACE"

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
