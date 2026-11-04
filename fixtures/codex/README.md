# Procedencia de fixtures de Codex

- `exec-ok.jsonl` y `rollout-token-count.jsonl`: capturas reales entregadas con la base del repositorio. El primero solo contiene una respuesta `OK`; el segundo incluye cupo real de 5 h y semanal.
- `exec-init-failed.txt`: salida real del intento de captura en este worktree, Codex CLI 0.165.0, Node 24.13.1, 2026-11-01. Ruta de usuario sustituida por `<CODEX_HOME>`. El sandbox impidió inicializar el cliente (`Acceso denegado`, salida 1).
- `items-synthetic.jsonl`, `errors-synthetic.jsonl`, `app-server-synthetic.json`: datos **sintéticos**, no capturas reales. Cubren traducción y protocolo sin consumir cupo. La forma del cupo sigue la documentación oficial y el registro real incluido.
- `capture.mjs`: captura manual reproducible de app-server y de una tarea con comando y edición en carpeta temporal. Ejecutar explícitamente `node fixtures/codex/capture.mjs` desde un entorno que permita crear subprocesos y acceder a la sesión. Consume cupo en la tarea de edición; no es una prueba automática. No ejecutarlo en paralelo con otra captura porque escribe los mismos destinos.

La captura real con comando y edición y la confirmación real de app-server siguen pendientes: Node `spawn` devuelve `EPERM` en este sandbox. Los fixtures sintéticos no satisfacen ese criterio de aceptación.

Protocolo oficial: <https://learn.chatgpt.com/docs/app-server#initialization> y <https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt>. JSON-RPC por líneas, transporte stdio predeterminado, sin cabeceras Content-Length. Enviar `initialize` (id 0, `clientInfo`), esperar respuesta, notificar `initialized`, enviar `account/rateLimits/read` (id 1). Mantener stdin abierto hasta la respuesta. `usedPercent` expresa porcentaje consumido; `resetsAt` es Unix en segundos. Los registros de sesión usan `used_percent` y `resets_at`.
