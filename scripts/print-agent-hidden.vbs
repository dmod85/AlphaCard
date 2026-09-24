Set objShell = CreateObject("WScript.Shell")
Do
  code = objShell.Run("cmd /c ""cd /d C:\server\AlphaCard && node scripts\print-agent.mjs >> logs\print-agent.log 2>&1""", 0, True)
  If code = 0 Then Exit Do
  WScript.Sleep 3000
Loop
