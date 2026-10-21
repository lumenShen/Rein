<#
  真机截图 / 无边框验证（WebView2 无 CDP 时的兜底工装）。
  与 win32-window.ps1 分开：这里需要 GDI PrintWindow + DWM API，单独 Add-Type 免得互相干扰。

  动作：
    nccheck  -Hwnd <hwnd>   返回 style/exStyle、窗口矩形、客户区矩形与客户区屏幕原点、DWM 扩展框
                            → 判「实际无系统标题栏」：客户区原点 == 窗口原点（说明 WM_NCCALCSIZE 把非客户区归零）
    shotwin  -Hwnd -Out     用 PrintWindow(PW_RENDERFULLCONTENT) 截窗口；失败退 CopyFromScreen
    shotdesk -Out           截整个桌面（系统级置顶证明用）；PrintWindow(GetDesktopWindow) / CopyFromScreen
#>
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Hwnd = '',
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# DPI 感知：不做这一步 GetWindowRect / PrintWindow 拿到的是虚拟化坐标（150% 缩放下会横向裁掉一半内容）
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ReinDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }' -ErrorAction SilentlyContinue
try { [void][ReinDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][ReinDpi]::SetProcessDPIAware() } catch { } }

Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ReinCap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  public struct RECT { public int L; public int T; public int R; public int B; }
  public struct POINT { public int X; public int Y; }
}
"@

function Save-PrintWindow([IntPtr]$h, [string]$out) {
  $r = New-Object ReinCap+RECT
  [void][ReinCap]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L
  $hh = $r.B - $r.T
  if ($w -le 0 -or $hh -le 0) { throw "窗口矩形无效" }
  $screenDc = [ReinCap]::GetDC([IntPtr]::Zero)
  $memDc = [ReinCap]::CreateCompatibleDC($screenDc)
  $bmp = [ReinCap]::CreateCompatibleBitmap($screenDc, $w, $hh)
  $old = [ReinCap]::SelectObject($memDc, $bmp)
  # PW_RENDERFULLCONTENT = 2：WebView2 这类硬件合成窗口必须带这个标志，否则是一张黑图
  $okPrint = [ReinCap]::PrintWindow($h, $memDc, 2)
  $bmpObj = [System.Drawing.Image]::FromHbitmap($bmp)
  $bmpObj.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmpObj.Dispose()
  [void][ReinCap]::SelectObject($memDc, $old)
  [void][ReinCap]::DeleteObject($bmp)
  [void][ReinCap]::DeleteDC($memDc)
  [void][ReinCap]::ReleaseDC([IntPtr]::Zero, $screenDc)
  return [pscustomobject]@{ ok = [bool]$okPrint; path = $out; w = $w; h = $hh; method = 'printwindow' }
}

function Save-Screen([string]$out) {
  Add-Type -AssemblyName System.Windows.Forms
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  return [pscustomobject]@{ ok = $true; path = $out; w = $vs.Width; h = $vs.Height; method = 'copyfromscreen' }
}

switch ($Action) {
  'nccheck' {
    $h = [IntPtr][int64]$Hwnd
    $wr = New-Object ReinCap+RECT
    [void][ReinCap]::GetWindowRect($h, [ref]$wr)
    $cr = New-Object ReinCap+RECT
    [void][ReinCap]::GetClientRect($h, [ref]$cr)
    $pt = New-Object ReinCap+POINT
    $pt.X = 0; $pt.Y = 0
    [void][ReinCap]::ClientToScreen($h, [ref]$pt)
    $dwm = New-Object ReinCap+RECT
    $dwmOk = 0
    try { $dwmOk = [ReinCap]::DwmGetWindowAttribute($h, 9, [ref]$dwm, 16) } catch { $dwmOk = -1 }  # DWMWA_EXTENDED_FRAME_BOUNDS
    [pscustomobject]@{
      style = [ReinCap]::GetWindowLongPtr($h, -16).ToInt64()
      exStyle = [ReinCap]::GetWindowLongPtr($h, -20).ToInt64()
      winRect = @{ x = $wr.L; y = $wr.T; w = $wr.R - $wr.L; h = $wr.B - $wr.T }
      clientRect = @{ w = $cr.R - $cr.L; h = $cr.B - $cr.T }
      clientOrigin = @{ x = $pt.X; y = $pt.Y }
      dwmOk = $dwmOk
      dwmFrame = @{ x = $dwm.L; y = $dwm.T; w = $dwm.R - $dwm.L; h = $dwm.B - $dwm.T }
      captionPx = $pt.Y - $wr.T
      leftInsetPx = $pt.X - $wr.L
    } | ConvertTo-Json -Compress -Depth 4
  }
  'shotwin' {
    try {
      Save-PrintWindow ([IntPtr][int64]$Hwnd) $Out | ConvertTo-Json -Compress
    } catch {
      Save-Screen $Out | ConvertTo-Json -Compress
    }
  }
  'shotdesk' {
    try {
      Save-PrintWindow ([ReinCap]::GetDesktopWindow()) $Out | ConvertTo-Json -Compress
    } catch {
      Save-Screen $Out | ConvertTo-Json -Compress
    }
  }
  default { throw "未知动作 $Action" }
}