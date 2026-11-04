---
name: navegador-chrome
description: Usar el Chrome personal del usuario (servidor chrome-personal, por defecto) o el perfil aislado chrome-agente mediante el MCP chrome-devtools-mcp para navegar, probar páginas web, rellenar formularios, tomar capturas, leer consola y red o auditar rendimiento. Usar cuando una tarea necesite un navegador real.
---

# Navegador Chrome por MCP

Herramienta: `chrome-devtools-mcp` 1.11.0 en `C:\dev\agent-hub\tools\browser` (Node de Windows).

## Qué servidor usar
- `chrome-personal` (por defecto, decisión del usuario 2026-11-01): el Chrome habitual del usuario (`--autoConnect`), con sus sesiones reales. Las páginas no lo detectan como automatizado (`navigator.webdriver = false`, comprobado). Requiere `chrome://inspect/#remote-debugging` activado. Si Chrome muestra un aviso de conexión, el usuario debe aceptarlo; si el MCP responde vacío o «Could not connect», pedirle que lo revise.
- `chrome-agente`: Chrome lanzado por el MCP con el perfil `tools\browser\chrome-profile`. Lo marca como automatizado (`navigator.webdriver = true`), por eso Google, Cloudflare y otros sitios lo bloquean por «actividad sospechosa». Usarlo solo si `chrome-personal` no está disponible o para pruebas que no deben tocar las sesiones del usuario.
- No intentar ocultar la automatización para saltarse los controles antibots de un sitio.

## Varios agentes a la vez
Todos comparten el mismo Chrome personal. Cada agente abre su propia pestaña con `new_page`, trabaja solo en ella y la cierra con `close_page` al terminar. Nunca cerrar, recargar ni navegar pestañas que el agente no abrió (pueden ser del usuario o de otro agente).

## Configurar en un agente nuevo (stdio)
- Desde Windows: comando `cmd`, argumentos `/c C:\dev\agent-hub\tools\browser\chrome-personal.cmd`.
- Desde WSL: comando `cmd.exe`, argumentos `/c C:\dev\agent-hub\tools\browser\chrome-personal.cmd`.
  (WSL está en modo NAT: no ejecutar el MCP con Node de Linux, no vería el localhost de Windows.)
- Registrado el 2026-11-01 en Claude Code (Windows y WSL), Codex (Windows) y Antigravity `agy` (Windows y WSL).

## Flujo recomendado
1. `new_page` o `navigate_page` con la URL.
2. `take_snapshot` (árbol de accesibilidad con uid) antes de `click`/`fill`; preferirlo a capturas.
3. `take_screenshot` solo para verificación visual.
4. `list_console_messages` y `list_network_requests` para depurar.

## Cuidados
- El Chrome personal tiene abiertas las cuentas reales del usuario (correo, bancos, redes): entrar solo a los sitios que la tarea necesita y no leer ni copiar datos personales ajenos a ella.
- No introducir contraseñas ni datos de pago; pedir al usuario que inicie sesión él mismo en la ventana.
- No enviar formularios, compras ni mensajes sin confirmación explícita del usuario.
- Telemetría y CrUX desactivados en los lanzadores; acceso a archivos limitado a `C:\dev`.
