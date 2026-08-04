Set objShell = CreateObject("WScript.Shell")
objShell.Run "cmd /c ""cd /d C:\server\AlphaCard && node scripts\print-agent.mjs >> logs\print-agent.log 2>&1""", 0, False
