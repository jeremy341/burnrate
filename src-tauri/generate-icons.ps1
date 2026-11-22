<#
 Rebuilds src-tauri/icons from public/icon-512x512.png (the Burnrate logo).
 Run: powershell -File src-tauri/generate-icons.ps1 -src public/icon-512x512.png -out src-tauri/icons
#>
param($src, $out)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($src)
function Resize($size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($img, 0, 0, $size, $size)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return ,$ms.ToArray()
}
foreach ($pair in @(@(32,'32x32.png'),@(128,'128x128.png'),@(256,'128x128@2x.png'),@(512,'icon.png'))) {
  [IO.File]::WriteAllBytes((Join-Path $out $pair[1]), (Resize $pair[0]))
}
$sizes = 16,24,32,48,64,128,256
$frames = foreach ($s in $sizes) { ,(Resize $s) }
$ms = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $ms
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $frames[$i].Length
  $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$len); $w.Write([uint32]$offset)
  $offset += $len
}
foreach ($f in $frames) { $w.Write($f) }
[IO.File]::WriteAllBytes((Join-Path $out 'icon.ico'), $ms.ToArray())
$img.Dispose()
