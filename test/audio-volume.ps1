# Prints master volume / mute of the default playback device (CoreAudio IAudioEndpointVolume).
$src = @"
using System;
using System.Runtime.InteropServices;
namespace CV {
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator { int EnumAudioEndpoints(int f, int m, out IntPtr p); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice dev); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr p); int UnregisterControlChangeNotify(IntPtr p); int GetChannelCount(out int n);
    int SetMasterVolumeLevel(float f, ref Guid g); int SetMasterVolumeLevelScalar(float f, ref Guid g);
    int GetMasterVolumeLevel(out float f); int GetMasterVolumeLevelScalar(out float f);
    int SetChannelVolumeLevel(int c, float f, ref Guid g); int SetChannelVolumeLevelScalar(int c, float f, ref Guid g);
    int GetChannelVolumeLevel(int c, out float f); int GetChannelVolumeLevelScalar(int c, out float f);
    int SetMute(bool b, ref Guid g); int GetMute(out bool b);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumerator { }
  public static class Vol {
    public static string Get() {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice dev; en.GetDefaultAudioEndpoint(0, 1, out dev);
      var iid = typeof(IAudioEndpointVolume).GUID; object o; dev.Activate(ref iid, 23, IntPtr.Zero, out o);
      var v = (IAudioEndpointVolume)o; float s; bool m; v.GetMasterVolumeLevelScalar(out s); v.GetMute(out m);
      return "volume=" + Math.Round(s * 100) + "% muted=" + m;
    }
  }
}
"@
Add-Type -TypeDefinition $src
[CV.Vol]::Get()
