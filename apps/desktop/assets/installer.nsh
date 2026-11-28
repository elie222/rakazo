; electron-builder includes this file from buildResources in the Windows installer.

!macro customUnInstall
  ; Pages installed as apps start Rakazo itself, so their shortcuts and data go with it. An
  ; update also runs the uninstaller first; it keeps them.
  ${ifNot} ${isUpdated}
    RMDir /r "$APPDATA\Microsoft\Windows\Start Menu\Programs\Rakazo Apps"
    RMDir /r "$APPDATA\Rakazo Apps"
  ${endIf}
!macroend
