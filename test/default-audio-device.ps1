# Prints the current default render (playback) endpoints for each role via CoreAudio COM.
$src = @"
using System;
using System.Runtime.InteropServices;
namespace CA {
  public enum EDataFlow { eRender, eCapture, eAll }
  public enum ERole { eConsole, eMultimedia, eCommunications }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(EDataFlow dataFlow, int dwStateMask, out IntPtr ppDevices);
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IntPtr ppInterface);
    int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROPERTYKEY { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit)] public struct PROPVARIANT { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
  [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    int GetCount(out int cProps);
    int GetAt(int iProp, out PROPERTYKEY pkey);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumerator { }
  public static class Def {
    public static string Get(EDataFlow flow, ERole role) {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice dev; if (en.GetDefaultAudioEndpoint(flow, role, out dev) != 0) return "(none)";
      IPropertyStore ps; dev.OpenPropertyStore(0, out ps);
      var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 }; // PKEY_Device_FriendlyName
      PROPVARIANT pv; ps.GetValue(ref key, out pv);
      return Marshal.PtrToStringUni(pv.p);
    }
  }
}
"@
Add-Type -TypeDefinition $src
"default OUTPUT (console)        : " + [CA.Def]::Get([CA.EDataFlow]::eRender, [CA.ERole]::eConsole)
"default OUTPUT (multimedia)     : " + [CA.Def]::Get([CA.EDataFlow]::eRender, [CA.ERole]::eMultimedia)
"default OUTPUT (communications) : " + [CA.Def]::Get([CA.EDataFlow]::eRender, [CA.ERole]::eCommunications)
"default INPUT  (console)        : " + [CA.Def]::Get([CA.EDataFlow]::eCapture, [CA.ERole]::eConsole)
"default INPUT  (communications) : " + [CA.Def]::Get([CA.EDataFlow]::eCapture, [CA.ERole]::eCommunications)
