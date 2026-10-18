# Screen capture (Windows): full screen / a window / a region -> PNG
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File grab.ps1 -OutFile x.png -Mode screen|all|window|region -Window "title keyword" -Region "x,y,w,h"
# The outcome is ALSO written to "$OutFile.result.txt" so the caller never needs stdout pipes.
param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$Mode = 'screen',
  [string]$Window = '',
  [string]$Region = '',
  [int]$MaxWidth = 0
)

$resultFile = "$OutFile.result.txt"
function Done($text) { $text | Set-Content -Path $resultFile -Encoding UTF8; Write-Output $text }

try {
  $ErrorActionPreference = 'Stop'
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  # DPI awareness: without it a scaled display makes CopyFromScreen coordinates wrong.
  Add-Type -Namespace Dsh -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
  [Dsh.Dpi]::SetProcessDPIAware() | Out-Null

  $x = 0; $y = 0; $w = 0; $h = 0; $target = ''

  if ($Mode -eq 'region') {
    $parts = $Region -split ','
    if ($parts.Count -lt 4) { throw "Region needs four numbers: x,y,w,h" }
    $x = [int]$parts[0]; $y = [int]$parts[1]; $w = [int]$parts[2]; $h = [int]$parts[3]
    $target = "region $Region"
  }
  elseif ($Mode -eq 'window') {
    if (-not $Window) { throw "window mode needs -Window <title keyword>" }
    Add-Type -Namespace Dsh -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }'
    $proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$Window*" } | Select-Object -First 1
    if (-not $proc) { throw "no window with a title containing '$Window'" }
    [Dsh.Win]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 400
    $rect = New-Object 'Dsh.Win+RECT'
    [Dsh.Win]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
    $x = $rect.Left; $y = $rect.Top
    $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
    $target = "window '$($proc.MainWindowTitle)'"
  }
  elseif ($Mode -eq 'all') {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $x = $vs.X; $y = $vs.Y; $w = $vs.Width; $h = $vs.Height
    $target = 'all screens'
  }
  else {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $x = $b.X; $y = $b.Y; $w = $b.Width; $h = $b.Height
    $target = 'primary screen'
  }

  if ($w -le 0 -or $h -le 0) { throw "invalid capture size: $w x $h" }

  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))

  # Optional downscale: keeps the PNG small enough to inline into the conversation.
  if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) {
    $nh = [int][Math]::Round($h * ($MaxWidth / $w))
    $small = New-Object System.Drawing.Bitmap($MaxWidth, $nh)
    $sg = [System.Drawing.Graphics]::FromImage($small)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.DrawImage($bmp, 0, 0, $MaxWidth, $nh)
    $sg.Dispose()
    $bmp.Dispose()
    $g.Dispose()
    $bmp = $small
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $w = $MaxWidth
    $h = $nh
  }

  $dir = Split-Path -Parent $OutFile
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()

  Done ("OK|{0}|{1}x{2}|{3}" -f $OutFile, $w, $h, $target)
}
catch {
  Done ("ERR|" + $_.Exception.Message)
  exit 1
}
