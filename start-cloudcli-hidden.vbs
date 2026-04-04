Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c set SERVER_PORT=8250 && cloudcli.cmd", 0, False
