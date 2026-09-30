# Live listening end to end on this machine, with the LOCAL engine and an isolated
# config (your real config, keys and quota are not touched): start Ghost hidden,
# press the listen hotkey, speak a sentence through the speakers (SAPI), stop,
# and print the transcript lines from the isolated log. The speakers are
# unmuted at a moderate volume for the test and restored afterwards (Windows
# loopback is captured after the volume/mute stage: muted = digital silence).
#   powershell -ExecutionPolicy Bypass -File test/live-local.ps1 [-Say "..."] [-Volume 40]
param([string]$Say = "Quick question for you. How does a hash table handle collisions, and what is the load factor?", [int]$SettleSec = 9, [int]$Volume = 40)
$dst = Split-Path -Parent $PSScriptRoot
$vol = "$dst\test\audio-volume.ps1"
$before = (& powershell -NoProfile -ExecutionPolicy Bypass -File $vol | Select-Object -Last 1)
"speakers before: $before"
$m = [regex]::Match($before, 'volume=(\d+)% muted=(True|False)')
$prevVol = [int]$m.Groups[1].Value; $prevMuted = $m.Groups[2].Value -eq 'True'
& powershell -NoProfile -ExecutionPolicy Bypass -File $vol -Set $Volume -Unmute | Out-Null
try {
  $ud = Join-Path $env:TEMP "ghost-live-local"
  Remove-Item -Recurse -Force $ud -ErrorAction SilentlyContinue | Out-Null
  New-Item -ItemType Directory -Force $ud | Out-Null
  Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep 1
  $env:GHOST_USERDATA = $ud
  $env:GHOST_MODELS = Join-Path $env:APPDATA "ghost\models"
  $env:GHOST_AUDIO_SOURCE = "both"; $env:GHOST_DUMP_AUDIO = "1"
  $p = Start-Process -FilePath "$dst\node_modules\electron\dist\electron.exe" -ArgumentList "`"$dst`"" -WorkingDirectory $dst -PassThru -WindowStyle Hidden
  Start-Sleep 7
  Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Speech
  [System.Windows.Forms.SendKeys]::SendWait("^+l"); Start-Sleep 4
  $tts = New-Object System.Speech.Synthesis.SpeechSynthesizer; $tts.Volume = 100; $tts.Speak($Say)
  Start-Sleep $SettleSec
  [System.Windows.Forms.SendKeys]::SendWait("^+l"); Start-Sleep 2
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  "=== said: $Say ==="
  Get-Content (Join-Path $ud "ghost.log") | Where-Object { $_ -match "\[live|\[stt|voice detector|starting sources|engine" } | ForEach-Object { ($_ -replace '^\S+ ', '').Substring(0, [Math]::Min(190, ($_ -replace '^\S+ ', '').Length)) }
} finally {
  $muteArg = if ($prevMuted) { '-Mute' } else { '-Unmute' }
  $after = (& powershell -NoProfile -ExecutionPolicy Bypass -File $vol -Set $prevVol $muteArg | Select-Object -Last 1)
  "speakers restored: $after"
  Remove-Item Env:GHOST_DUMP_AUDIO, Env:GHOST_USERDATA, Env:GHOST_MODELS, Env:GHOST_AUDIO_SOURCE -ErrorAction SilentlyContinue
}
