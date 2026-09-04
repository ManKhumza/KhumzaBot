!include MUI2.nsh
!include LogicLib.nsh

!define MUI_ICON "${NSISDIR}\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Icons\modern-uninstall.ico"

Var RemoveData

!macro customInstall
  !insertmacro MUI_PAGE_WELCOME
  !insertmacro MUI_PAGE_LICENSE "${NSIS_LICENSE}"
  !insertmacro MUI_PAGE_DIRECTORY
  !insertmacro MUI_PAGE_INSTFILES
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUninstall
  !insertmacro MUI_UNPAGE_WELCOME
  !insertmacro MUI_UNPAGE_CONFIRM
  Page custom un.PageDataDirectory
  !insertmacro MUI_UNPAGE_INSTFILES
  !insertmacro MUI_UNPAGE_FINISH
!macroend

Function un.PageDataDirectory
  !insertmacro MUI_HEADER_TEXT "Remove User Data" "Choose whether to remove your personal data"
  
  nsDialogs::Create 1018
  Pop $Dialog
  
  ${NSD_CreateLabel} 0 0 100% 12u "Remove user data (models, knowledge, chat history)?"
  Pop $Label
  
  ${NSD_CreateCheckbox} 15u 20u 100% 10u "Also remove NOC AI Assistant user data and models"
  Pop $Checkbox
  
  nsDialogs::Show
  
  ${NSD_GetState} $Checkbox $CheckboxState
  StrCmp $CheckboxState ${BST_CHECKED} 0 +2
  StrCpy $RemoveData 1
  
  nsDialogs::Destroy
FunctionEnd

Function .onInit
  ; Check for running instance
  System::Call 'kernel32::CreateMutexA(i 0, i 1, t "Global\\NOC_AI_Assistant_Installer") i .r0'
  Pop $Mutex
  StrCmp $LastError 183 0 +3
  MessageBox MB_ICONEXCLAMATION "NOC AI Assistant is currently running. Please close it before installing."
  Abort
FunctionEnd

Function un.onInit
  ; Check for running instance during uninstall
  System::Call 'kernel32::CreateMutexA(i 0, i 1, t "Global\\NOC_AI_Assistant_Uninstaller") i .r0'
  Pop $Mutex
  StrCmp $LastError 183 0 +3
  MessageBox MB_ICONEXCLAMATION "NOC AI Assistant is currently running. Please close it before uninstalling."
  Abort
FunctionEnd

Section "UninstallData" SECUNINST
  ; Remove user data if requested
  StrCmp $RemoveData 1 0 +3
  RMDir /r "$APPDATA\NOC AI Assistant"
  RMDir /r "$LOCALAPPDATA\NOC AI Assistant"
SectionEnd