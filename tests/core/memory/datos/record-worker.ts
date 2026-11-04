/**
 * Proceso hijo para la prueba de concurrencia entre procesos (revisión de agy, hallazgo 1).
 * Uso: node record-worker.ts <bóveda> <sesiones en JSON base64> <instante de arranque en ms>
 * Espera hasta el instante indicado para que todos los procesos escriban a la vez.
 */
import { ObsidianMemory } from '../../../../src/core/memory/obsidian-memory.ts';
import type { SessionSummary } from '../../../../src/shared/index.ts';

const [vault = '', payload = '', startAt = '0'] = process.argv.slice(2);
const sessions = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as SessionSummary[];
await new Promise((resolve) => { setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())); });
const memory = new ObsidianMemory({ vaultPath: vault });
await Promise.all(sessions.map((s) => memory.recordSession(s)));
process.stdout.write(`ok ${sessions.length}\n`);
