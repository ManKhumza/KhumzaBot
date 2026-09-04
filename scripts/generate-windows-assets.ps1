#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root 'resources\icons'

function New-NocBitmap([int]$width, [int]$height) {
    $bitmap = [System.Drawing.Bitmap]::new($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::FromArgb(30, 64, 175))
    $penWidth = [Math]::Max(3, [int]($height * 0.05))
    $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, $penWidth)
    $pen.StartCap = $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $left = [int]($width * 0.25)
    $graphics.DrawLine($pen, $left, [int]($height * 0.38), [int]($width * 0.75), [int]($height * 0.38))
    $graphics.DrawLine($pen, $left, [int]($height * 0.53), [int]($width * 0.63), [int]($height * 0.53))
    $graphics.DrawLine($pen, $left, [int]($height * 0.68), [int]($width * 0.50), [int]($height * 0.68))
    $pen.Dispose()
    $graphics.Dispose()
    return $bitmap
}

function Write-Ico([string]$path) {
    $bitmap = New-NocBitmap 256 256
    $png = [System.IO.MemoryStream]::new()
    $bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    $bytes = $png.ToArray()
    $png.Dispose()
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Create)
    $writer = [System.IO.BinaryWriter]::new($stream)
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
    $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$bytes.Length); $writer.Write([uint32]22); $writer.Write($bytes)
    $writer.Dispose()
}

foreach ($name in @('icon.ico', 'installer.ico', 'uninstaller.ico')) {
    Write-Ico (Join-Path $iconDir $name)
}

$header = New-NocBitmap 150 57
$header.Save((Join-Path $iconDir 'header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$header.Dispose()
Write-Host 'Generated valid Windows ICO and BMP resources.'
