# A/B a Live API setup variant against the REAL endpoint using the running app:
# restart Ghost with GHOST_LIVE_VARIANT, toggle listen via hotkey, speak via TTS, read log.
param([string]$Variant = "full", [string]$Model = "", [string]$Source = "", [string]$Say = "Hey, quick question. What is a binary tree, and how is it different from a linked list?")
$dst = "C:\Users\abhij\Ghost"
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep 1
Remove-Item "$env:APPDATA\ghost\ghost.log" -ErrorAction SilentlyContinue
$env:GHOST_LIVE_VARIANT = $Variant; if ($Model) { $env:GHOST_LIVE_MODEL = $Model }; if ($Source) { $env:GHOST_AUDIO_SOURCE = $Source }
Start-Process -FilePath "$dst\node_modules\electron\dist\electron.exe" -ArgumentList "`"$dst`"" -WorkingDirectory $dst -WindowStyle Hidden
Start-Sleep 5
Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Speech
[System.Windows.Forms.SendKeys]::SendWait("^+l"); Start-Sleep 3
$tts = New-Object System.Speech.Synthesis.SpeechSynthesizer; $tts.Volume = 100; $tts.Speak($Say)
Start-Sleep 5
[System.Windows.Forms.SendKeys]::SendWait("^+l"); Start-Sleep 1
"=== variant=$Variant model=$Model source=$Source ==="
Get-Content "$env:APPDATA\ghost\ghost.log" | Where-Object { $_ -notmatch "sessionResumptionUpdate|starting, preferred" } | ForEach-Object { $_ -replace '^\S+ ', '' }
Remove-Item Env:GHOST_LIVE_VARIANT, Env:GHOST_LIVE_MODEL, Env:GHOST_AUDIO_SOURCE -ErrorAction SilentlyContinue
