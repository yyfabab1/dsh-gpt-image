# Fit one PNG to a game's required spec (exact size, or "max" = contain without upscaling).
# ASCII-only on purpose: PowerShell 5.1 misreads BOM-less UTF-8 Chinese as ANSI and fails to parse.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File resize.ps1 -In a.png -Out b.png -Width 40 -Height 60 [-Max] [-Mode fit|stretch]
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][int]$Width,
  [Parameter(Mandatory = $true)][int]$Height,
  [switch]$Max,
  [string]$Mode = 'fit'
)

$resultFile = "$Out.result.txt"
function Done($text) { $text | Set-Content -Path $resultFile -Encoding UTF8; Write-Output $text }

try {
  $ErrorActionPreference = 'Stop'
  Add-Type -AssemblyName System.Drawing

  $src = [System.Drawing.Image]::FromFile($In)
  try {
    $sw = $src.Width; $sh = $src.Height
    $tw = $Width; $th = $Height

    if ($Max) {
      # contain: never upscale, keep aspect ratio
      $scale = [Math]::Min(1.0, [Math]::Min($Width / $sw, $Height / $sh))
      $tw = [int][Math]::Max(1, [Math]::Round($sw * $scale))
      $th = [int][Math]::Max(1, [Math]::Round($sh * $scale))
    }

    $bmp = New-Object System.Drawing.Bitmap($tw, $th, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    if ($Mode -eq 'stretch') {
      $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $tw, $th)))
    }
    else {
      # fit inside the target box, centered (keeps aspect; never distorts pixel art as badly as stretch)
      $scale = [Math]::Min($tw / $sw, $th / $sh)
      $dw = [int][Math]::Max(1, [Math]::Round($sw * $scale))
      $dh = [int][Math]::Max(1, [Math]::Round($sh * $scale))
      $dx = [int][Math]::Round(($tw - $dw) / 2)
      $dy = [int][Math]::Round(($th - $dh) / 2)
      $g.DrawImage($src, (New-Object System.Drawing.Rectangle($dx, $dy, $dw, $dh)))
    }
    $g.Dispose()

    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Done ("OK|{0}|{1}x{2}|from {3}x{4}" -f $Out, $tw, $th, $sw, $sh)
  }
  finally { $src.Dispose() }
}
catch {
  Done ("ERR|" + $_.Exception.Message)
  exit 1
}
