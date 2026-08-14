# Creates/updates the Start Menu shortcut for Termivin with an explicit
# AppUserModelID. Windows resolves a taskbar group's icon through the installed
# shortcut that carries the same AUMID as the running window — without this,
# dev and `termivin`-CLI runs show the generic electron.exe icon.
param(
  [Parameter(Mandatory)][string]$Target,   # electron.exe
  [Parameter(Mandatory)][string]$AppArgs,  # path to the app root
  [Parameter(Mandatory)][string]$Icon,     # assets\icon.ico
  [Parameter(Mandatory)][string]$Aumid     # com.termivin.app
)
$ErrorActionPreference = 'Stop'

$lnkPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'Termivin.lnk'
$marker = "Termivin terminal workspace [$Aumid]"

# Skip the write when the shortcut is already correct (the marker in the
# description doubles as "AUMID was set by us").
if (Test-Path $lnkPath) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    $cur = $shell.CreateShortcut($lnkPath)
    if ($cur.TargetPath -eq $Target -and
        $cur.Arguments -eq "`"$AppArgs`"" -and
        $cur.IconLocation -eq "$Icon,0" -and
        $cur.Description -eq $marker) {
      Write-Output 'shortcut up to date'
      exit 0
    }
  } catch {}
}

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $Target
$lnk.Arguments = "`"$AppArgs`""
$lnk.WorkingDirectory = $AppArgs
$lnk.IconLocation = "$Icon,0"
$lnk.Description = $marker
$lnk.Save()

# Stamp System.AppUserModel.ID onto the .lnk via the shell property store.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PropertyKey {
  public Guid fmtid;
  public uint pid;
  public PropertyKey(Guid f, uint p) { fmtid = f; pid = p; }
}

[StructLayout(LayoutKind.Explicit)]
public struct PropVariant {
  [FieldOffset(0)] public ushort vt;
  [FieldOffset(8)] public IntPtr pv;
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
  uint GetCount(out uint cProps);
  uint GetAt(uint iProp, out PropertyKey pkey);
  uint GetValue(ref PropertyKey key, out PropVariant pv);
  uint SetValue(ref PropertyKey key, ref PropVariant pv);
  uint Commit();
}

public static class LnkAumid {
  [DllImport("shell32.dll", SetLastError = true)]
  private static extern int SHGetPropertyStoreFromParsingName(
    [MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc,
    int flags, ref Guid riid, out IPropertyStore store);

  public static void Set(string lnkPath, string aumid) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore store;
    int hr = SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2 /* GPS_READWRITE */, ref iid, out store);
    if (hr != 0) throw new Exception("SHGetPropertyStoreFromParsingName failed: 0x" + hr.ToString("X"));
    PropertyKey key = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5); // PKEY_AppUserModel_ID
    PropVariant pv = new PropVariant();
    pv.vt = 31; // VT_LPWSTR
    pv.pv = Marshal.StringToCoTaskMemUni(aumid);
    try {
      uint r = store.SetValue(ref key, ref pv);
      if (r != 0) throw new Exception("SetValue failed: 0x" + r.ToString("X"));
      r = store.Commit();
      if (r != 0) throw new Exception("Commit failed: 0x" + r.ToString("X"));
    } finally {
      Marshal.FreeCoTaskMem(pv.pv);
      Marshal.ReleaseComObject(store);
    }
  }
}
'@

[LnkAumid]::Set($lnkPath, $Aumid)
Write-Output "shortcut written: $lnkPath"
