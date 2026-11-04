---
name: con-scripts
description: "Skill de prueba con scripts, licencia y metadatos en JSON: sirve para comprobar que el hub detecta scripts y nunca los ejecuta."
license: MIT
compatibility: Requiere internet y una clave en ELEVENLABS_API_KEY (formato copiado de una skill real de Codex).
metadata: {"openclaw": {"requires": {"env": ["ELEVENLABS_API_KEY"]}, "primaryEnv": "ELEVENLABS_API_KEY"}}
allowed-tools: [Read, Bash]
---

# Skill con scripts

Ejemplo para las pruebas del hub de skills. Si alguien ejecuta `scripts/instalar.sh` o `scripts/limpiar.ps1`,
crearán el archivo `EJECUTADO.txt`: las pruebas comprueban que ese archivo nunca aparece.
