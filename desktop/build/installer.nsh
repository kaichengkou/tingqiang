; electron-builder writes the file association with the program's path unquoted, which is unreliable once the path has a space.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\TingQiang.Project\shell\open\command" "" '"$INSTDIR\tingqiang.exe" "%1"'
!macroend

; It also leaves the extension pointing at the class it just removed.
!macro customUnInstall
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.tqproj" ""
  StrCmp $0 "TingQiang.Project" 0 +2
    DeleteRegKey SHELL_CONTEXT "Software\Classes\.tqproj"
!macroend
