<#
.SYNOPSIS
  Crea el acceso directo «Berland» en el Escritorio del usuario.

.DESCRIPTION
  El acceso directo abre node_modules\electron\dist\electron.exe con la app compilada
  (apps\desktop\out) como argumento y la raíz del repo como carpeta de trabajo. El icono se copia a
  %LOCALAPPDATA%\orquestador\berland.ico para que el acceso directo no dependa de la rama ni del checkout.
  Si la app aún no está compilada en RepoRoot, avisa: basta con «npm run desktop» una vez.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\desktop-shortcut.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\desktop-shortcut.ps1 -RepoRoot C:\dev\orquestador
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = 'C:\dev\orquestador',
  [string]$Name = 'Berland'
)

$ErrorActionPreference = 'Stop'

$electron = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
$app = Join-Path $RepoRoot 'apps\desktop\out'
if (-not (Test-Path -LiteralPath $electron)) {
  throw "No encuentro Electron en $electron (instala las dependencias en $RepoRoot)."
}
if (-not (Test-Path -LiteralPath (Join-Path $app 'main.js'))) {
  Write-Warning "La app aún no está compilada en ${app}: ejecuta «npm run desktop» una vez en $RepoRoot."
}

$iconSource = Join-Path $PSScriptRoot '..\apps\desktop\assets\icon.ico'
if (-not (Test-Path -LiteralPath $iconSource)) { throw "No encuentro el icono $iconSource." }
$dataDir = Join-Path $env:LOCALAPPDATA 'orquestador'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$icon = Join-Path $dataDir 'berland.ico'
Copy-Item -LiteralPath $iconSource -Destination $icon -Force

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop "$Name.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnk)
$shortcut.TargetPath = $electron
$shortcut.Arguments = '"' + $app + '"'
$shortcut.WorkingDirectory = $RepoRoot
$shortcut.IconLocation = "$icon,0"
$shortcut.Description = 'Berland: orquestador de agentes'
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Output "Acceso directo: $lnk"
Write-Output "  Destino:    $electron"
Write-Output "  Argumentos: $($shortcut.Arguments)"
Write-Output "  Carpeta:    $RepoRoot"
Write-Output "  Icono:      $icon"
