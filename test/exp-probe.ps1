param([string]$Transparent = "0", [string]$When = "before", [string]$Type = "")
$g = Split-Path -Parent $PSScriptRoot
if (-not ([System.Management.Automation.PSTypeName]'WP').Type) {
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class WP {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
}
"@ }
$env:EXP_TRANSPARENT = $Transparent; $env:EXP_WHEN = $When; $env:EXP_TYPE = $Type
$p = Start-Process -FilePath (Join-Path $g "node_modules\electron\dist\electron.exe") -ArgumentList (Join-Path $g "test\exp-main.js") -WorkingDirectory $g -PassThru
Start-Sleep -Seconds 4
$pids = (Get-Process electron -ErrorAction SilentlyContinue).Id
$script:main = [IntPtr]::Zero
[WP]::EnumWindows({ param($h, $l)
  $pid2 = [uint32]0; [void][WP]::GetWindowThreadProcessId($h, [ref]$pid2)
  if ($pids -notcontains [int]$pid2) { return $true }
  $cb = New-Object System.Text.StringBuilder 256; [void][WP]::GetClassName($h, $cb, 256)
  if ($cb.ToString() -like 'Chrome_WidgetWin_*' -and [WP]::IsWindowVisible($h)) { $script:main = $h }
  return $true }, [IntPtr]::Zero) | Out-Null
$h = $script:main
$a=[uint32]0; if ($h -ne [IntPtr]::Zero) { [void][WP]::GetWindowDisplayAffinity($h,[ref]$a) }
$ex = if ($h -ne [IntPtr]::Zero) { [WP]::GetWindowLong($h, -20) } else { 0 }
"transparent=$Transparent when=$When type=$Type -> hwnd=$h layered={0} toolwindow={3} affinity=0x{1:X} excluded={2}" -f (($ex -band 0x80000) -ne 0), $a, ($a -eq 0x11), (($ex -band 0x80) -ne 0)
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
