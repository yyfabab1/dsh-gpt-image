# Draw the asset name INSIDE the picture (labeled preview copy), so nobody confuses what a file is.
# ASCII-only on purpose (PowerShell 5.1 misreads BOM-less UTF-8 Chinese).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File label.ps1 -In a.png -Out a_labeled.png -Text "wx_clear_tile" -Sub "doomsday-ember 40x60" -MinSide 200
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Text,
  [string]$Sub = '',
  [int]$MinSide = 200,
  # MaxSide: cap the LONGEST side of the labeled preview. 0 = no cap (old behaviour).
  # Why the cap exists: a 1024x1024 asset made a full-size 1024x1024 preview (~1.7MB each).
  # 535 of them ate 928MB. Capping at 384px keeps the name readable at ~2-3% of the size.
  [int]$MaxSide = 0
)

$resultFile = "$Out.result.txt"
function Done($text) { $text | Set-Content -Path $resultFile -Encoding UTF8; Write-Output $text }

try {
  $ErrorActionPreference = 'Stop'
  Add-Type -AssemblyName System.Drawing

  $src = [System.Drawing.Image]::FromFile($In)
  try {
    $sw = $src.Width; $sh = $src.Height
    $scale = 1.0
    $short = [Math]::Min($sw, $sh)
    if ($MinSide -gt 0 -and $short -lt $MinSide) { $scale = [double]$MinSide / [double]$short }
    $w = [int][Math]::Max($sw, [Math]::Round($sw * $scale))
    $h = [int][Math]::Max($sh, [Math]::Round($sh * $scale))
    # Downscale: if the longest side exceeds MaxSide, scale down proportionally.
    # The preview only exists to identify an asset, so full resolution is wasted space.
    if ($MaxSide -gt 0) {
      $long = [Math]::Max($w, $h)
      if ($long -gt $MaxSide) {
        $shrink = [double]$MaxSide / [double]$long
        $w = [int][Math]::Max(1, [Math]::Round($w * $shrink))
        $h = [int][Math]::Max(1, [Math]::Round($h * $shrink))
      }
    }

    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    # upscale with nearest neighbour so pixel art stays crisp
    if ($scale -gt 1.0) { $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor }
    else { $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic }
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    # checkerboard behind transparency so "no background" is visible
    $c1 = [System.Drawing.Color]::FromArgb(255, 58, 62, 70)
    $c2 = [System.Drawing.Color]::FromArgb(255, 40, 43, 50)
    $cell = 16
    for ($y = 0; $y -lt $h; $y += $cell) {
      for ($x = 0; $x -lt $w; $x += $cell) {
        $brush = New-Object System.Drawing.SolidBrush(($(if ((([int]($x / $cell)) + ([int]($y / $cell))) % 2 -eq 0) { $c1 } else { $c2 })))
        $g.FillRectangle($brush, $x, $y, $cell, $cell)
        $brush.Dispose()
      }
    }
    $g.DrawImage($src, 0, 0, $w, $h)

    # label bar at the top: asset name + optional subtitle
    $fontSize = [float][Math]::Max(13.0, [Math]::Min(34.0, $w / 22.0))
    $subSize = [float][Math]::Max(10.0, $fontSize * 0.62)
    $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $subFont = New-Object System.Drawing.Font('Segoe UI', $subSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $pad = [int][Math]::Max(6, $w / 60)
    $barH = [int][Math]::Round($fontSize + $pad * 2 + $(if ($Sub) { $subSize + 4 } else { 0 }))
    $barBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(215, 0, 0, 0))
    $g.FillRectangle($barBrush, 0, 0, $w, $barH)
    $barBrush.Dispose()
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.DrawString($Text, $font, $textBrush, $pad, $pad)
    if ($Sub) {
      $subBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 200, 210, 225))
      $g.DrawString($Sub, $subFont, $subBrush, $pad, ($pad + $fontSize + 2))
      $subBrush.Dispose()
    }
    $textBrush.Dispose(); $font.Dispose(); $subFont.Dispose(); $g.Dispose()

    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Done ("OK|{0}|{1}x{2}" -f $Out, $w, $h)
  }
  finally { $src.Dispose() }
}
catch {
  Done ("ERR|" + $_.Exception.Message)
  exit 1
}
