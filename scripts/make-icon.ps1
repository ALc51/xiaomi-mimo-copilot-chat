# Marketplace 128x128 PNG from prototype A (faithful wide mark, centered).
Add-Type -AssemblyName System.Drawing
$size = 128
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::FromArgb(255, 30, 30, 30))
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 9.5
$pen.StartCap = 'Round'
$pen.EndCap = 'Round'
$pen.LineJoin = 'Round'
# Map original viewBox 8,32,82,44 into 128 square with letterbox
$viewX = 8.0; $viewY = 32.0; $viewW = 82.0; $viewH = 44.0
$scale = [Math]::Min($size / $viewW, $size / $viewH) * 0.86
$ox = ($size - $viewW * $scale) / 2.0 - $viewX * $scale
$oy = ($size - $viewH * $scale) / 2.0 - $viewY * $scale
function X([double]$v) { return [float]($ox + $v * $scale) }
function Y([double]$v) { return [float]($oy + $v * $scale) }
$g.DrawLine($pen, (X 14), (Y 52), (X 14), (Y 70))
$pts = @(
  (New-Object System.Drawing.PointF (X 14), (Y 37)),
  (New-Object System.Drawing.PointF (X 27), (Y 57)),
  (New-Object System.Drawing.PointF (X 40), (Y 37)),
  (New-Object System.Drawing.PointF (X 40), (Y 70))
)
$g.DrawLines($pen, $pts)
$rect = New-Object System.Drawing.RectangleF (X 53.5), (Y 36.5), ([float](34 * $scale)), ([float](34 * $scale))
$g.DrawArc($pen, $rect, -40, 160)
$g.DrawArc($pen, $rect, 140, 160)
New-Item -ItemType Directory -Force -Path media | Out-Null
$out = Join-Path (Get-Location) 'media\mimo-icon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $pen.Dispose()
Write-Output "Wrote $out"
