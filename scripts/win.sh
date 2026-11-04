#!/usr/bin/env bash
# Ejecuta un comando con el Node/npm de WINDOWS en la raíz del checkout actual (también en worktrees).
# node_modules se instala con npm de Windows: no ejecutar npm/vitest con el Node de WSL.
# Uso: scripts/win.sh npm run -s check
set -euo pipefail
cd "$(dirname "$0")/.."
exec cmd.exe /d /c "cd /d $(wslpath -w "$PWD") && $*"
