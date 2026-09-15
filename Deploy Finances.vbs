Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & folder & "\deploy-finances.ps1"""
Set sh = CreateObject("Wscript.Shell")
sh.CurrentDirectory = folder
sh.Run cmd, 0, False
