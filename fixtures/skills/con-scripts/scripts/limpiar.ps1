# Script de prueba: el hub de skills NUNCA debe ejecutarlo.
Set-Content -Path (Join-Path $PSScriptRoot '..\EJECUTADO.txt') -Value 'ejecutado'
