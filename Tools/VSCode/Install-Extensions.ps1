# Installs every extension under Jaui.VSCode\ into the current user's
# VS Code extensions folder via directory junction so edits to the
# source-of-truth files are picked up on the next VS Code reload
# (Ctrl+Shift+P -> Reload Window).
#
# Uses Windows directory junctions (not symlinks) so no admin rights
# or Developer Mode are required.

$ErrorActionPreference = "Stop"
$Source = $PSScriptRoot
$Target = Join-Path $env:USERPROFILE ".vscode\extensions"

if (-not (Test-Path $Target)) {
    throw "VS Code extensions folder not found at $Target. Install VS Code first."
}

$Extensions = Get-ChildItem -Path $Source -Directory | Where-Object {
    Test-Path (Join-Path $_.FullName "package.json")
}

foreach ($ext in $Extensions) {
    $link = Join-Path $Target $ext.Name
    if (Test-Path $link) {
        Write-Host "Removing existing $($ext.Name)..." -ForegroundColor Yellow
        Remove-Item $link -Recurse -Force
    }
    Write-Host "Linking $($ext.Name) -> $($ext.FullName)" -ForegroundColor Green
    New-Item -ItemType Junction -Path $link -Target $ext.FullName | Out-Null
}

Write-Host ""
Write-Host "Done. VS Code will pick up the extension on its own — open a .jss file to verify." -ForegroundColor Cyan
