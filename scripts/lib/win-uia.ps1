<#
  UI Automation 工装：真机 WebView2 无 CDP 时用 Windows 可访问性树驱动 / 断言页面。
  PS 5.1 需要 UTF-8 BOM 才能正确解析中文（本文件由 float-uia-app.mjs 写出后转 BOM）。

  动作：
    dump   -Hwnd <hwnd> [-Max N]        列出可访问元素（Name/ControlType/屏幕矩形）
    find   -Hwnd <hwnd> -Name <文本> [-Type Button] 精确名优先、退化为包含匹配
    invoke -Hwnd <hwnd> -Name <文本> [-Type Button] 优先 InvokePattern，其次鼠标点中心
    clickxy -X -Y / dblclickxy -X -Y    绝对屏幕坐标鼠标
    rect   -Hwnd <hwnd>                 窗口矩形（物理像素）
#>
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Hwnd = '',
  [string]$Name = '',
  [string]$Type = '',
  [int]$Max = 600,
  [int]$X = 0,
  [int]$Y = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# DPI 感知：不做这一步 GetWindowRect / PrintWindow 拿到的是虚拟化坐标（150% 缩放下会横向裁掉一半内容）
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ReinDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }' -ErrorAction SilentlyContinue
try { [void][ReinDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][ReinDpi]::SetProcessDPIAware() } catch { } }


Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ReinUiaWin32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  public struct RECT { public int L; public int T; public int R; public int B; }
}
"@

function Get-Root([string]$hwnd) {
  return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$hwnd)
}

function Get-All($root) {
  # Chromium 的可访问性树是惰性构建的：第一次查询后等它长出来再取一次
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  for ($k = 0; $k -lt 8; $k++) {
    if ($all.Count -gt 15) { break }
    Start-Sleep -Milliseconds 700
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  }
  return $all
}

function To-Int($v) {
  # Chromium 的可访问性树里离屏元素可能出现 Infinity / NaN 的 BoundingRectangle
  try {
    $d = [double]$v
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return -1 }
    return [int][Math]::Round($d)
  } catch {
    return -1
  }
}

function Get-ElInfo($e) {
  $r = $e.Current.BoundingRectangle
  return [pscustomobject]@{
    name = $e.Current.Name
    type = ($e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', '')
    x    = (To-Int $r.X)
    y    = (To-Int $r.Y)
    w    = (To-Int $r.Width)
    h    = (To-Int $r.Height)
  }
}

function Find-El($root, [string]$name, [string]$type, [bool]$contains) {
  $all = Get-All $root
  $hits = @()
  for ($i = 0; $i -lt $all.Count; $i++) {
    $e = $all.Item($i)
    $n = $e.Current.Name
    if (-not $n) { continue }
    $ok = if ($contains) { $n.Contains($name) } else { $n -eq $name }
    if (-not $ok) { continue }
    if ($type -and (($e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', '') -ne $type)) { continue }
    $hits += $e
  }
  return $hits
}

function Click-Point([double]$px, [double]$py) {
  [void][ReinUiaWin32]::SetCursorPos([int]$px, [int]$py)
  Start-Sleep -Milliseconds 60
  [ReinUiaWin32]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
  [ReinUiaWin32]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
}

switch ($Action) {
  'dump' {
    $root = Get-Root $Hwnd
    $all = Get-All $root
    $out = @()
    for ($i = 0; $i -lt [Math]::Min($all.Count, $Max); $i++) {
      $info = Get-ElInfo $all.Item($i)
      if ($info.name) { $out += $info }
    }
    [pscustomobject]@{ count = $all.Count; items = $out } | ConvertTo-Json -Compress -Depth 4
  }
  'find' {
    $root = Get-Root $Hwnd
    $hits = @(Find-El $root $Name $Type $false)
    $mode = 'exact'
    if ($hits.Count -eq 0) { $hits = @(Find-El $root $Name $Type $true); $mode = 'contains' }
    if ($hits.Count -eq 0) { [pscustomobject]@{ found = $false; mode = $mode } | ConvertTo-Json -Compress; break }
    $info = Get-ElInfo $hits[0]
    [pscustomobject]@{ found = $true; mode = $mode; count = $hits.Count; name = $info.name; type = $info.type; x = $info.x; y = $info.y; w = $info.w; h = $info.h } | ConvertTo-Json -Compress
  }
  'invoke' {
    $root = Get-Root $Hwnd
    $hits = @(Find-El $root $Name $Type $false)
    $mode = 'exact'
    if ($hits.Count -eq 0) { $hits = @(Find-El $root $Name $Type $true); $mode = 'contains' }
    if ($hits.Count -eq 0) { [pscustomobject]@{ ok = $false; how = 'not-found' } | ConvertTo-Json -Compress; break }
    $e = $hits[0]
    $how = 'none'
    try {
      $pat = $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $pat.Invoke()
      $how = 'invoke'
    } catch {
      try {
        $legacy = $e.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
        $legacy.DoDefaultAction()
        $how = 'legacy'
      } catch {
        $r = $e.Current.BoundingRectangle
        Click-Point ($r.X + $r.Width / 2) ($r.Y + $r.Height / 2)
        $how = 'click'
      }
    }
    [pscustomobject]@{ ok = $true; how = $how; mode = $mode; name = $e.Current.Name } | ConvertTo-Json -Compress
  }
  'clickxy' {
    Click-Point $X $Y
    [pscustomobject]@{ ok = $true; x = $X; y = $Y } | ConvertTo-Json -Compress
  }
  'dblclickxy' {
    [void][ReinUiaWin32]::SetCursorPos([int]$X, [int]$Y)
    Start-Sleep -Milliseconds 60
    [ReinUiaWin32]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
    [ReinUiaWin32]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [ReinUiaWin32]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
    [ReinUiaWin32]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
    [pscustomobject]@{ ok = $true; x = $X; y = $Y } | ConvertTo-Json -Compress
  }
  'rect' {
    $r = New-Object ReinUiaWin32+RECT
    [void][ReinUiaWin32]::GetWindowRect([IntPtr][int64]$Hwnd, [ref]$r)
    [pscustomobject]@{ x = $r.L; y = $r.T; w = $r.R - $r.L; h = $r.B - $r.T } | ConvertTo-Json -Compress
  }
  default { throw "未知动作 $Action" }
}