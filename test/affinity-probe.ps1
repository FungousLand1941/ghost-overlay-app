# Launches Ghost, finds its main window, reads display affinity, optionally tries to set it from outside.
param([switch]$TrySet, [switch]$Toggle, [int]$WaitSeconds = 6)
$g = Split-Path -Parent $PSScriptRoot
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class WP {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
}
"@
if ($Toggle) { $env:GHOST_TEST_TOGGLE = "1" } else { Remove-Item Env:GHOST_TEST_TOGGLE -EA SilentlyContinue }
$p = Start-Process -FilePath (Join-Path $g "node_modules\electron\dist\electron.exe") -ArgumentList "." -WorkingDirectory $g -PassThru
Start-Sleep -Seconds $WaitSeconds
$pids = (Get-Process electron -ErrorAction SilentlyContinue).Id
$script:main = [IntPtr]::Zero
[WP]::EnumWindows({ param($h, $l)
  $pid2 = [uint32]0; [void][WP]::GetWindowThreadProcessId($h, [ref]$pid2)
  if ($pids -notcontains [int]$pid2) { return $true }
  $cb = New-Object System.Text.StringBuilder 256; [void][WP]::GetClassName($h, $cb, 256)
  if ($cb.ToString() -like 'Chrome_WidgetWin_*' -and [WP]::IsWindowVisible($h)) { $script:main = $h }
  return $true }, [IntPtr]::Zero) | Out-Null
if ($script:main -eq [IntPtr]::Zero) { "main window not found"; Get-Process electron -EA SilentlyContinue | Stop-Process -Force; exit 1 }
$h = $script:main
$ex = [WP]::GetWindowLong($h, -20)
"hwnd=$h exstyle=0x{0:X} layered={1} toolwindow={2}" -f $ex, (($ex -band 0x80000) -ne 0), (($ex -band 0x80) -ne 0)
$a=[uint32]0; [void][WP]::GetWindowDisplayAffinity($h,[ref]$a); "affinity (as set by app): 0x{0:X}  excludedFromCapture={1}" -f $a, ($a -eq 0x11)
if ($TrySet) {
  $ok = [WP]::SetWindowDisplayAffinity($h, 0x11); $err=[System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  "external SetWindowDisplayAffinity(0x11): ok=$ok err=$err"
  [void][WP]::GetWindowDisplayAffinity($h,[ref]$a); "affinity now: 0x{0:X}" -f $a
}
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
