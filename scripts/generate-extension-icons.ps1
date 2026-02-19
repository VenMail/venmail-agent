param(
    [string]$OutputDir = "packages/extension/public/icons"
)

Add-Type -AssemblyName System.Drawing

$fullOutputDir = Join-Path (Get-Location) $OutputDir
if (-not (Test-Path $fullOutputDir)) {
    New-Item -ItemType Directory -Path $fullOutputDir -Force | Out-Null
}

$iconSpecs = @{
    16  = "icon16.png"
    48  = "icon48.png"
    128 = "icon128.png"
}

foreach ($entry in $iconSpecs.GetEnumerator()) {
    $size = [int]$entry.Key
    $fileName = $entry.Value
    $filePath = Join-Path $fullOutputDir $fileName

    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::FromArgb(255, 30, 102, 197))

            $fontSize = [Math]::Max([Math]::Round($size * 0.45), 8)
            $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold)
            $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
            $format = New-Object System.Drawing.StringFormat
            $format.Alignment = [System.Drawing.StringAlignment]::Center
            $format.LineAlignment = [System.Drawing.StringAlignment]::Center

            $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
            $graphics.DrawString('V', $font, $brush, (New-Object System.Drawing.RectangleF(0, 0, $size, $size)), $format)
        }
        finally {
            if ($graphics) { $graphics.Dispose() }
        }

        $bitmap.Save($filePath, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Host "Generated $fileName"
    }
    finally {
        $bitmap.Dispose()
    }
}
