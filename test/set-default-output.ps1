# Set the default playback device (all roles) by friendly-name substring, using the
# undocumented-but-stable IPolicyConfig COM interface (what the Sound control panel uses).
param([string]$Name = "Speakers (Realtek")
$src = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace PC {
  [Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPolicyConfig {
    int GetMixFormat(string d, IntPtr p); int GetDeviceFormat(string d, int b, IntPtr p); int ResetDeviceFormat(string d);
    int SetDeviceFormat(string d, IntPtr a, IntPtr b); int GetProcessingPeriod(string d, int b, IntPtr a, IntPtr c);
    int SetProcessingPeriod(string d, IntPtr p); int GetShareMode(string d, IntPtr p); int SetShareMode(string d, IntPtr p);
    int GetPropertyValue(string d, int b, IntPtr k, IntPtr v); int SetPropertyValue(string d, int b, IntPtr k, IntPtr v);
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int role);
    int SetEndpointVisibility(string d, int v);
  }
  [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")] public class PolicyConfigClient { }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator { int EnumAudioEndpoints(int f, int m, out IMMDeviceCollection c); int GetDefaultAudioEndpoint(int f, int r, out IMMDevice d); }
  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceCollection { int GetCount(out int n); int Item(int i, out IMMDevice d); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice { int Activate(ref Guid iid, int c, IntPtr p, out IntPtr o); int OpenPropertyStore(int a, out IPropertyStore s); int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); }
  [StructLayout(LayoutKind.Sequential)] public struct PROPERTYKEY { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit)] public struct PROPVARIANT { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
  [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore { int GetCount(out int c); int GetAt(int i, out PROPERTYKEY k); int GetValue(ref PROPERTYKEY k, out PROPVARIANT v); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumerator { }
  public static class Audio {
    public static string SetDefaultOutput(string nameContains) {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDeviceCollection col; en.EnumAudioEndpoints(0 /*render*/, 1 /*active*/, out col);
      int n; col.GetCount(out n);
      var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
      for (int i = 0; i < n; i++) {
        IMMDevice dev; col.Item(i, out dev);
        IPropertyStore ps; dev.OpenPropertyStore(0, out ps);
        PROPVARIANT pv; ps.GetValue(ref key, out pv);
        string name = Marshal.PtrToStringUni(pv.p);
        if (name != null && name.IndexOf(nameContains, StringComparison.OrdinalIgnoreCase) >= 0) {
          string id; dev.GetId(out id);
          var pc = (IPolicyConfig)new PolicyConfigClient();
          pc.SetDefaultEndpoint(id, 0); pc.SetDefaultEndpoint(id, 1); pc.SetDefaultEndpoint(id, 2);
          return name;
        }
      }
      return null;
    }
  }
}
"@
if (-not ([System.Management.Automation.PSTypeName]'PC.Audio').Type) { Add-Type -TypeDefinition $src }
$r = [PC.Audio]::SetDefaultOutput($Name)
if ($r) { "default output set to: $r" } else { "no active playback device matching '$Name'"; exit 1 }
