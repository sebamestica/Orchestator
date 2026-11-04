/**
 * Proceso auxiliar de la prueba «dos procesos aprueban a la vez» (no es una prueba en sí).
 * Uso: node aprobar-proceso.ts <hubDir> <archivo-salida> <id> [<id>…]
 * Escribe «listo» y espera a que exista <archivo-salida>.go; entonces aprueba los ids en orden.
 */
import { existsSync } from 'node:fs';
import { SkillHub } from '../../../src/core/skills/hub.ts';

const [hubDir, goFile, ...ids] = process.argv.slice(2);
if (!hubDir || !goFile || ids.length === 0) throw new Error('uso: aprobar-proceso.ts <hubDir> <goFile> <id>…');

const hub = new SkillHub({ hubDir, projectDir: hubDir });
process.stdout.write('listo\n');
while (!existsSync(goFile)) await new Promise((r) => setTimeout(r, 2));
for (const id of ids) await hub.approve(id);
process.stdout.write('hecho\n');
