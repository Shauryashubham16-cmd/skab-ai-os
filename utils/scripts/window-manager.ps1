param(
  [ValidateSet('list', 'active', 'action')]
  [string]$Op = 'list',

  [string]$Handle,

  [ValidateSet('focus', 'minimize', 'maximize', 'restore', 'close')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class JarvisWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsZoomed(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    public const uint GW_OWNER = 4;
    public const uint WM_CLOSE = 0x0010;
    public const int SW_MINIMIZE = 6;
    public const int SW_MAXIMIZE = 3;
    public const int SW_RESTORE = 9;

    public static List<IntPtr> ListTopLevelWindows() {
        var handles = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            if (GetWindowTextLength(hWnd) == 0) return true;
            // Skip owned windows (tool tips, popups) — keep real top-level app windows.
            if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero) return true;
            handles.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return handles;
    }

    public static string GetTitle(IntPtr hWnd) {
        int len = GetWindowTextLength(hWnd);
        if (len == 0) return "";
        var sb = new StringBuilder(len + 1);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
}
"@

function Get-WindowInfo([IntPtr]$hWnd) {
  $title = [JarvisWin32]::GetTitle($hWnd)
  $procId = 0
  [void][JarvisWin32]::GetWindowThreadProcessId($hWnd, [ref]$procId)
  $procName = $null
  try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $procName = $null }
  [PSCustomObject]@{
    handle       = $hWnd.ToInt64().ToString()
    title        = $title
    processName  = $procName
    pid          = $procId
    isMinimized  = [bool][JarvisWin32]::IsIconic($hWnd)
    isMaximized  = [bool][JarvisWin32]::IsZoomed($hWnd)
    isForeground = ($hWnd -eq [JarvisWin32]::GetForegroundWindow())
  }
}

switch ($Op) {
  'list' {
    $result = [JarvisWin32]::ListTopLevelWindows() | ForEach-Object { Get-WindowInfo $_ }
    $result | ConvertTo-Json -Compress -Depth 3
  }
  'active' {
    $hWnd = [JarvisWin32]::GetForegroundWindow()
    if ($hWnd -eq [IntPtr]::Zero) {
      '{"ok":false,"error":"No foreground window"}'
    } else {
      Get-WindowInfo $hWnd | ConvertTo-Json -Compress -Depth 3
    }
  }
  'action' {
    if (-not $Handle) { '{"ok":false,"error":"Handle is required"}'; exit 0 }
    $hWndVal = [int64]0
    if (-not [int64]::TryParse($Handle, [ref]$hWndVal)) {
      '{"ok":false,"error":"Invalid handle"}'; exit 0
    }
    $hWnd = [IntPtr]$hWndVal
    $ok = $true
    switch ($Action) {
      'focus'    { $ok = [JarvisWin32]::SetForegroundWindow($hWnd) }
      'minimize' { $ok = [JarvisWin32]::ShowWindow($hWnd, [JarvisWin32]::SW_MINIMIZE) }
      'maximize' { $ok = [JarvisWin32]::ShowWindow($hWnd, [JarvisWin32]::SW_MAXIMIZE) }
      'restore'  { $ok = [JarvisWin32]::ShowWindow($hWnd, [JarvisWin32]::SW_RESTORE) }
      'close'    { $ok = [JarvisWin32]::PostMessage($hWnd, [JarvisWin32]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) }
      default    { '{"ok":false,"error":"Unknown action"}'; exit 0 }
    }
    ([PSCustomObject]@{ ok = [bool]$ok; action = $Action; handle = $Handle }) | ConvertTo-Json -Compress
  }
}
