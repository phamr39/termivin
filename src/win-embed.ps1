# Persistent Win32 helper for embedding external console windows into Termivin.
# Reads one JSON command per line on stdin, writes one JSON line per response.
# Also emits unsolicited event lines ({"evt":...}) from a global win-event hook
# that fires whenever the user finishes dragging any window (drop-to-attach).
# Commands: list | attach | move | show | alive | detach | detachAll | closeWindow

$ErrorActionPreference = 'Stop'

# Titles can contain Vietnamese etc. — force UTF-8 on the pipe.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}

Add-Type @"
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEmbed {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  public delegate void WinEventDelegate(IntPtr hHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwThread, uint dwTime);

  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int m);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint evMin, uint evMax, IntPtr hmod, WinEventDelegate cb, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG msg);

  [StructLayout(LayoutKind.Sequential)]
  public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }

  static readonly object OutLock = new object();
  static WinEventDelegate hookDel; // keep alive

  public static void Emit(string line) {
    lock (OutLock) {
      Console.Out.WriteLine(line);
      Console.Out.Flush();
    }
  }

  public static string GetTitle(IntPtr h) {
    int len = GetWindowTextLength(h);
    if (len == 0) return "";
    var sb = new StringBuilder(len + 2);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr p, int c, ref PBI i, int l, out int r);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool inh, uint pid);
  [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, int s, out IntPtr rd);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)]
  public struct PBI { public IntPtr R1; public IntPtr PebBaseAddress; public IntPtr R2a; public IntPtr R2b; public IntPtr UniquePid; public IntPtr R3; }

  // Read another process's current working directory from its PEB (x64).
  public static string GetProcessCwd(uint pid) {
    IntPtr h = OpenProcess(0x0410, false, pid); // QUERY_INFORMATION | VM_READ
    if (h == IntPtr.Zero) return "";
    try {
      var pbi = new PBI();
      int rl;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PBI)), out rl) != 0) return "";
      var buf = new byte[8]; IntPtr rd;
      if (!ReadProcessMemory(h, (IntPtr)((long)pbi.PebBaseAddress + 0x20), buf, 8, out rd)) return "";
      long pparams = BitConverter.ToInt64(buf, 0);
      var us = new byte[16]; // UNICODE_STRING CurrentDirectory.DosPath at +0x38
      if (!ReadProcessMemory(h, (IntPtr)(pparams + 0x38), us, 16, out rd)) return "";
      ushort len = BitConverter.ToUInt16(us, 0);
      long strPtr = BitConverter.ToInt64(us, 8);
      if (len == 0 || len > 4096 || strPtr == 0) return "";
      var sbuf = new byte[len];
      if (!ReadProcessMemory(h, (IntPtr)strPtr, sbuf, len, out rd)) return "";
      string s = Encoding.Unicode.GetString(sbuf);
      if (s.Length > 3 && s.EndsWith("\\")) s = s.TrimEnd('\\');
      return s;
    } catch { return ""; } finally { CloseHandle(h); }
  }

  public static List<string> ListWindows() {
    var res = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      string t = GetTitle(h);
      if (t.Length == 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      res.Add(((long)h).ToString() + "|" + pid + "|" + t);
      return true;
    }, IntPtr.Zero);
    return res;
  }

  // Global hook: user finished moving/resizing ANY top-level window.
  // Emits an event line so the app can offer "drop to attach".
  public static void StartMoveHook() {
    var t = new Thread(() => {
      hookDel = (hHook, ev, hwnd, idObject, idChild, thr, time) => {
        try {
          if (idObject != 0 || hwnd == IntPtr.Zero) return; // OBJID_WINDOW only
          uint pid;
          GetWindowThreadProcessId(hwnd, out pid);
          string title = GetTitle(hwnd);
          if (title.Length == 0) return;
          string b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(title));
          Emit("{\"evt\":\"movesizeend\",\"hwnd\":" + (long)hwnd + ",\"pid\":" + pid + ",\"title_b64\":\"" + b64 + "\"}");
        } catch {}
      };
      SetWinEventHook(0x000B, 0x000B, IntPtr.Zero, hookDel, 0, 0, 0); // EVENT_SYSTEM_MOVESIZEEND, out-of-context
      MSG msg;
      while (GetMessage(out msg, IntPtr.Zero, 0, 0)) {
        TranslateMessage(ref msg);
        DispatchMessage(ref msg);
      }
    });
    t.IsBackground = true;
    t.Start();
  }
}
"@

$GWL_STYLE = -16
$WS_CHILD = 0x40000000
$SW_HIDE = 0
$SW_SHOW = 5
$SW_RESTORE = 9
$WM_CLOSE = 0x0010

# hwnd(string) -> original style (session-local; the app also persists it)
$attached = @{}

# Console-ish process names we surface in the picker by default
$consoleNames = @(
  'cmd', 'powershell', 'pwsh', 'WindowsTerminal', 'OpenConsole', 'conhost',
  'wezterm-gui', 'alacritty', 'mintty', 'ConEmu64', 'ConEmu', 'Tabby', 'Hyper', 'warp'
)

function Respond($obj) {
  [WinEmbed]::Emit(($obj | ConvertTo-Json -Compress -Depth 5))
}

# Robust detach: restore the original style even if this helper instance never
# saw the attach (fallbackStyle persisted by the app), make sure the window is
# not left as a parentless WS_CHILD, and force it back onto the screen.
function Do-Detach([long]$h, $fallbackStyle) {
  $ptr = [IntPtr]$h
  if (-not [WinEmbed]::IsWindow($ptr)) { $attached.Remove("$h"); return $false }

  [void][WinEmbed]::SetParent($ptr, [IntPtr]::Zero)

  $style = $null
  if ($attached.ContainsKey("$h")) { $style = [int]$attached["$h"]; $attached.Remove("$h") }
  elseif ($null -ne $fallbackStyle) { $style = [int]$fallbackStyle }
  if ($null -ne $style) {
    [void][WinEmbed]::SetWindowLong($ptr, $GWL_STYLE, $style)
  } else {
    # last resort: at least clear WS_CHILD so the window can live on its own
    $cur = [WinEmbed]::GetWindowLong($ptr, $GWL_STYLE)
    [void][WinEmbed]::SetWindowLong($ptr, $GWL_STYLE, ($cur -band (-bnot $WS_CHILD)))
  }

  [void][WinEmbed]::MoveWindow($ptr, 120, 120, 1000, 640, $true)
  if ([WinEmbed]::IsIconic($ptr)) { [void][WinEmbed]::ShowWindow($ptr, $SW_RESTORE) }
  [void][WinEmbed]::ShowWindow($ptr, $SW_SHOW)
  [void][WinEmbed]::SetForegroundWindow($ptr)
  return $true
}

[WinEmbed]::StartMoveHook()

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $req = $line | ConvertFrom-Json
    switch ($req.cmd) {

      'list' {
        $procMap = @{}
        foreach ($p in Get-Process) { $procMap[[int]$p.Id] = $p.ProcessName }
        $items = @()
        foreach ($s in [WinEmbed]::ListWindows()) {
          $parts = $s -split '\|', 3
          $h = [long]$parts[0]
          $wpid = [int]$parts[1]
          $title = $parts[2]
          $pname = $procMap[$wpid]
          $skip = ($wpid -eq [int]$req.excludePid) -or ($wpid -eq $PID) -or (-not $pname)
          if (-not $skip) {
            $isConsole = $consoleNames -contains $pname
            if ($isConsole -or $req.all) {
              $items += @{ pid = $wpid; proc = $pname; title = $title; hwnd = $h }
            }
          }
        }
        Respond @{ id = $req.id; ok = $true; result = $items }
      }

      'attach' {
        $ptr = [IntPtr][long]$req.hwnd
        if (-not [WinEmbed]::IsWindow($ptr)) { Respond @{ id = $req.id; ok = $false; error = 'window gone' }; break }
        $orig = [WinEmbed]::GetWindowLong($ptr, $GWL_STYLE)
        $attached["$([long]$req.hwnd)"] = $orig
        [void][WinEmbed]::SetWindowLong($ptr, $GWL_STYLE, ($orig -bor $WS_CHILD))
        [void][WinEmbed]::SetParent($ptr, [IntPtr][long]$req.parent)
        [void][WinEmbed]::MoveWindow($ptr, [int]$req.x, [int]$req.y, [int]$req.w, [int]$req.h, $true)
        [void][WinEmbed]::ShowWindow($ptr, $SW_SHOW)
        Respond @{ id = $req.id; ok = $true; origStyle = $orig }
      }

      'move' {
        $ptr = [IntPtr][long]$req.hwnd
        if ([WinEmbed]::IsWindow($ptr)) {
          [void][WinEmbed]::MoveWindow($ptr, [int]$req.x, [int]$req.y, [int]$req.w, [int]$req.h, $true)
        }
        Respond @{ id = $req.id; ok = $true }
      }

      'show' {
        $ptr = [IntPtr][long]$req.hwnd
        if ([WinEmbed]::IsWindow($ptr)) {
          $mode = if ($req.visible) { $SW_SHOW } else { $SW_HIDE }
          [void][WinEmbed]::ShowWindow($ptr, $mode)
        }
        Respond @{ id = $req.id; ok = $true }
      }

      'alive' {
        $ptr = [IntPtr][long]$req.hwnd
        Respond @{ id = $req.id; ok = $true; result = [WinEmbed]::IsWindow($ptr) }
      }

      'parent' {
        $ptr = [IntPtr][long]$req.hwnd
        $par = 0
        if ([WinEmbed]::IsWindow($ptr)) { $par = [long][WinEmbed]::GetParent($ptr) }
        Respond @{ id = $req.id; ok = $true; result = $par }
      }

      'detach' {
        $r = Do-Detach ([long]$req.hwnd) $req.origStyle
        Respond @{ id = $req.id; ok = $r }
      }

      'detachAll' {
        foreach ($k in @($attached.Keys)) { [void](Do-Detach ([long]$k) $null) }
        Respond @{ id = $req.id; ok = $true }
      }

      'cwds' {
        # Working directories of shell-ish processes under the window's pid
        # (Windows Terminal hosts all tab shells as children of one process).
        $shellNames = @('cmd.exe','powershell.exe','pwsh.exe','bash.exe','wsl.exe','node.exe','python.exe')
        $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate
    $byParent = @{}
        foreach ($p in $all) {
          $k = [int]$p.ParentProcessId
          if (-not $byParent.ContainsKey($k)) { $byParent[$k] = @() }
          $byParent[$k] += ,$p
        }
        $target = [int]$req.pid
        $queue = New-Object System.Collections.Queue
        $queue.Enqueue($target)
        $descendants = @()
        $seen = @{}
        while ($queue.Count -gt 0) {
          $cur = [int]$queue.Dequeue()
          if ($seen.ContainsKey($cur)) { continue }
          $seen[$cur] = $true
          if ($byParent.ContainsKey($cur)) {
            foreach ($c in $byParent[$cur]) {
              $descendants += ,$c
              $queue.Enqueue([int]$c.ProcessId)
            }
          }
        }
        $self = $all | Where-Object { [int]$_.ProcessId -eq $target }
        $cands = @()
        foreach ($p in (@($self) + $descendants)) {
          if ($null -eq $p) { continue }
          if ($shellNames -contains $p.Name.ToLower()) {
            $cwd = [WinEmbed]::GetProcessCwd([uint32]$p.ProcessId)
            if ($cwd) {
              $created = 0
              try { $created = [long]($p.CreationDate.ToFileTime()) } catch {}
              $cands += @{ pid = [int]$p.ProcessId; name = $p.Name; cwd = $cwd; created = $created }
            }
          }
        }
        $cands = @($cands | Sort-Object -Property created -Descending | Select-Object -First 8)
        Respond @{ id = $req.id; ok = $true; result = $cands }
      }

      'closeWindow' {
        $ptr = [IntPtr][long]$req.hwnd
        if ([WinEmbed]::IsWindow($ptr)) {
          [void][WinEmbed]::PostMessage($ptr, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
        }
        Respond @{ id = $req.id; ok = $true }
      }

      default { Respond @{ id = $req.id; ok = $false; error = "unknown cmd: $($req.cmd)" } }
    }
  } catch {
    $rid = $null
    try { $rid = $req.id } catch {}
    Respond @{ id = $rid; ok = $false; error = "$_" }
  }
}

# stdin closed — the app is gone (quit or crashed). Best-effort: give any
# still-attached windows back to the desktop before we exit too.
foreach ($k in @($attached.Keys)) {
  try { [void](Do-Detach ([long]$k) $null) } catch {}
}
