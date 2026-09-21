# Frame-level loopback check for a given source ('system' | 'mic' | 'both') while a tone plays.
param([string]$Source = "both")
$dst = Split-Path -Parent $PSScriptRoot
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$env:GHOST_SMOKE = "frames"; $env:GHOST_SMOKE_OUT = $env:TEMP; $env:GHOST_AUDIO_SOURCE = $Source
$tone = Start-Process powershell -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","$dst\test\play-tone.ps1" -PassThru -WindowStyle Hidden
$p = Start-Process -FilePath "$dst\node_modules\electron\dist\electron.exe" -ArgumentList "`"$dst`"" -WorkingDirectory $dst -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\ghost-frames.txt" -RedirectStandardError "$env:TEMP\ghost-frames-err.txt"
$p.WaitForExit(20000) | Out-Null
Stop-Process -Id $tone.Id -Force -ErrorAction SilentlyContinue
$env:GHOST_SMOKE = $null; $env:GHOST_AUDIO_SOURCE = $null
$j = ((Get-Content "$env:TEMP\ghost-frames.txt" -Raw) -replace '(?s)^.*?SMOKE_OK ', '') | ConvertFrom-Json
$f = $j.frames
"source=$Source  active=$($f.active -join ',')  system: frames=$($f.system.frames) zero=$($f.system.zero) maxRms=$([math]::Round($f.system.maxRms,4))  mic: frames=$($f.mic.frames) zero=$($f.mic.zero) maxRms=$([math]::Round($f.mic.maxRms,4)) ducked=$($f.framesDucked)"
