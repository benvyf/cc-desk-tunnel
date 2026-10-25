; Keep the installation directory stable across the CC SPACE display/executable rename.
; The assisted installer's directory-page callback appends APP_FILENAME otherwise,
; moving an existing installation into a new subdirectory and losing its update ledger.
!undef APP_FILENAME
!define APP_FILENAME "CC Desk Tunnel"
