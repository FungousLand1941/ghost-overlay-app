# Verifies from OUTSIDE the app that the Ghost window has WDA_EXCLUDEFROMCAPTURE (0x11).
param([int]$ProcId = 0)
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W {
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
$found = @()
[W]::EnumWindows({ param($h, $l)
  $pid2 = [uint32]0; [void][W]::GetWindowThreadProcessId($h, [ref]$pid2)
  if ($ProcId -ne 0 -and $pid2 -ne $ProcId) { return $true }
  $n = [W]::GetWindowTextLength($h)
  $sb = New-Object System.Text.StringBuilder ($n + 2); [void][W]::GetWindowText($h, $sb, $sb.Capacity)
  $cb = New-Object System.Text.StringBuilder 256; [void][W]::GetClassName($h, $cb, 256)
  if ($ProcId -ne 0 -or $sb.ToString() -eq 'Ghost') {
    $a = [uint32]0; $ok = [W]::GetWindowDisplayAffinity($h, [ref]$a)
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $ex = [W]::GetWindowLong($h, -20)
    $script:found += [pscustomobject]@{ hwnd = $h; pid = $pid2; title = $sb.ToString(); class = $cb.ToString(); visible = [W]::IsWindowVisible($h); apiOk = $ok; err = $err; affinity = ('0x{0:X}' -f $a); excludedFromCapture = ($a -eq 0x11); toolWindow = (($ex -band 0x80) -ne 0) }
  }
  return $true }, [IntPtr]::Zero) | Out-Null
$found | Format-Table -AutoSize
if (-not $found) { Write-Host "Ghost window not found" }
