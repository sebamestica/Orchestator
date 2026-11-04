---
name: flota-orquestador
description: Reglas para trabajar en la flota del orquestador casero (Claude ×5, Codex y Antigravity/agy en paralelo) en cualquier proyecto de C:\dev, con un worktree por tarea, propiedad de archivos, traspaso a Claude cuando un agente agota su cupo, candados de recursos e informe obligatorio.
---

# Trabajo en flota

Activar cuando un encargo diga que trabajas dentro de la flota del orquestador o cuando estés en un worktree `C:\dev\orquestador-wt\*` o `C:\dev\.worktrees\*`. Las reglas del repo (`AGENTS.md`) mandan sobre esta skill.

## Roles

| Agente | Fuerte | Usar para |
|---|---|---|
| Claude (orquestador + workers, clave de API sin tope de cupo) | razonamiento largo, arquitectura, revisión, integración | tareas difíciles, revisión final, continuar tareas de otros |
| Codex (suscripción ChatGPT, cupo 5 h y semanal) | escribe código acotado y revisa rápido (1–7 min); en su sandbox **no crea procesos** (no corre pruebas, Blender ni Slicer) ni hace commits; sin red por defecto | módulos acotados con contrato, revisiones de solo lectura (seguridad, licencias, código) |
| agy / Antigravity (suscripción Google AI Pro, cupo 5 h y semanal) | Gemini rápido, navegador integrado | módulos acotados, investigación web, pruebas |

## Reglas

1. **Un worktree por tarea** y un dueño por archivo. No edites fuera de tus rutas; propón el cambio en tu informe.
2. **Contratos primero:** usa los tipos compartidos del repo; no inventes formatos paralelos.
3. **Cupo:** si recibes un error de cupo o límite, detente, deja el worktree compilando lo mejor posible, haz commit `wip:` y escribe en `.orq/HANDOFF.md` qué hiciste, qué falta y qué probaste. Un Claude continuará desde ahí.
4. **Recursos compartidos** (GPU, CPU pesada, E2E, Blender y Slicer interactivos): skill `local-compute-scheduling` del hub (`C:\dev\agent-hub\skills\local-compute-scheduling`), candados en `C:\dev\agent-hub\locks`.
5. **Navegador:** skill `navegador-chrome`; abre tu propia pestaña y ciérrala al terminar.
6. **Descargas** de recursos: solo de fuentes oficiales, a una carpeta nueva de `C:\dev\agent-hub\downloads\<origen>-<versión>\`, sin ejecutar nada descargado; registra URL, versión y SHA-256 en el informe.
7. **Verificación real:** ejecuta las pruebas y copia las cifras reales. Lo no ejecutado se declara «no ejecutado».
8. **Nunca** push, despliegue, pagos, borrar ramas ni reescribir historia.

## Informe final

Archivos cambiados · comandos y salida real resumida · pruebas aprobadas/fallidas · no ejecutado · cambios propuestos fuera de tu zona · problemas al coordinarse con otros agentes · bloqueos.
