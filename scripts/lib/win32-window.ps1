<#
  Win32 窗口工装（真机桌面断言用；docs/GLOBAL-FLOAT.md §10）。
  由 scripts/lib/float-app.mjs 以 pwsh -NoProfile -File ... -Action <动作> 调起，输出单行 JSON。

  为什么用 PowerShell + P/Invoke 而不是 Node 原生模块：GetWindowLongPtr / SetForegroundWindow /
  ShowWindow 都是 user32 的桌面 API，仓库里没有任何 native 依赖，Add-Type 现场编译是最小代价。
#>
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Hwnd = '',
  [string]$Pids = '',
  [string]$Name = '',
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 0,
  [int]$H = 0,
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# DPI 感知：不做这一步 GetWindowRect / PrintWindow 拿到的是虚拟化坐标（150% 缩放下会横向裁掉一半内容）
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ReinDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }' -ErrorAction SilentlyContinue
try { [void][ReinDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][ReinDpi]::SetProcessDPIAware() } catch { } }


Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ReinWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

function Get-WinInfo([IntPtr]$h) {
  $title = New-Object System.Text.StringBuilder 512
  [void][ReinWin32]::GetWindowText($h, $title, 512)
  $cls = New-Object System.Text.StringBuilder 256
  [void][ReinWin32]::GetClassName($h, $cls, 256)
  $rect = New-Object ReinWin32+RECT
  [void][ReinWin32]::GetWindowRect($h, [ref]$rect)
  [pscustomobject]@{
    hwnd    = $h.ToInt64().ToString()
    title   = $title.ToString()
    class   = $cls.ToString()
    style   = [ReinWin32]::GetWindowLongPtr($h, -16).ToInt64()
    exStyle = [ReinWin32]::GetWindowLongPtr($h, -20).ToInt64()
    x       = [int]$rect.Left
    y       = [int]$rect.Top
    w       = [int]($rect.Right - $rect.Left)
    h       = [int]($rect.Bottom - $rect.Top)
    visible = [bool][ReinWin32]::IsWindowVisible($h)
    zoomed  = [bool][ReinWin32]::IsZoomed($h)
  }
}

function Get-AllWindows {
  $list = New-Object System.Collections.ArrayList
  $callback = [ReinWin32+EnumWindowsProc]{
    param([IntPtr]$h, [IntPtr]$l)
    $procId = [uint32]0
    [void][ReinWin32]::GetWindowThreadProcessId($h, [ref]$procId)
    $info = Get-WinInfo $h
    $info | Add-Member -NotePropertyName pid -NotePropertyValue ([int64]$procId) | Out-Null
    [void]$list.Add($info)
    return $true
  }
  [void][ReinWin32]::EnumWindows($callback, [IntPtr]::Zero)
  return $list
}

switch ($Action) {
  'pidof' {
    $procs = @(Get-Process -Name $Name -ErrorAction SilentlyContinue)
    $result = @($procs | ForEach-Object { [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; mainHwnd = $_.MainWindowHandle.ToInt64().ToString() } })
    $result | ConvertTo-Json -Compress -Depth 4
  }
  'query' {
    $want = @()
    if ($Pids) { $want = $Pids.Split(',') | ForEach-Object { [int64]$_.Trim() } }
    $all = Get-AllWindows
    $hits = @($all | Where-Object { $want -contains $_.pid -and $_.visible })
    $hits | ConvertTo-Json -Compress -Depth 4
  }
  'all' {
    $all = Get-AllWindows
    @($all | Where-Object { $_.visible }) | ConvertTo-Json -Compress -Depth 4
  }
  'getfg' {
    [pscustomobject]@{ fg = [ReinWin32]::GetForegroundWindow().ToInt64().ToString() } | ConvertTo-Json -Compress
  }
  'foreground' {
    $h = [IntPtr][int64]$Hwnd
    $ok = [ReinWin32]::SetForegroundWindow($h)
    [pscustomobject]@{ ok = [bool]$ok; fg = [ReinWin32]::GetForegroundWindow().ToInt64().ToString() } | ConvertTo-Json -Compress
  }
  'minimize' {
    $h = [IntPtr][int64]$Hwnd
    $ok = [ReinWin32]::ShowWindow($h, 6)
    [pscustomobject]@{ ok = [bool]$ok; visible = [bool][ReinWin32]::IsWindowVisible($h) } | ConvertTo-Json -Compress
  }
  'restore' {
    $h = [IntPtr][int64]$Hwnd
    $ok = [ReinWin32]::ShowWindow($h, 9)
    [pscustomobject]@{ ok = [bool]$ok; visible = [bool][ReinWin32]::IsWindowVisible($h) } | ConvertTo-Json -Compress
  }
  'move' {
    $h = [IntPtr][int64]$Hwnd
    $ok = [ReinWin32]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, $W, $H, 0x14)
    [pscustomobject]@{ ok = [bool]$ok; info = (Get-WinInfo $h) } | ConvertTo-Json -Compress -Depth 4
  }
  'info' {
    Get-WinInfo ([IntPtr][int64]$Hwnd) | ConvertTo-Json -Compress -Depth 4
  }
  'shotwin' {
    # 只截某个窗口（真机截图用；副屏坐标可能为负，按窗口矩形直接 CopyFromScreen）
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $h = [IntPtr][int64]$Hwnd
    $r = New-Object ReinWin32+RECT
    [void][ReinWin32]::GetWindowRect($h, [ref]$r)
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    if ($w -le 0 -or $hh -le 0) { throw "窗口矩形无效" }
    $bmp = New-Object System.Drawing.Bitmap $w, $hh
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    [pscustomobject]@{ ok = $true; path = $Out; w = $w; h = $hh } | ConvertTo-Json -Compress
  }
  'screenshot' {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    [pscustomobject]@{ ok = $true; path = $Out; w = $vs.Width; h = $vs.Height } | ConvertTo-Json -Compress
  }
  default { throw "未知动作 $Action" }
}