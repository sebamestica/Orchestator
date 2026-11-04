/**
 * Proceso hijo para la prueba de concurrencia entre procesos de `recordPlan` (como `record-worker.ts`).
 * Uso: node plan-worker.ts <bóveda> <planes en JSON base64> <instante de arranque en ms>
 */
import { ObsidianMemory, type PlanNoteInput } from '../../../../src/core/memory/obsidian-memory.ts';

const [vault = '', payload = '', startAt = '0'] = process.argv.slice(2);
const plans = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as PlanNoteInput[];
await new Promise((resolve) => { setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())); });
const memory = new ObsidianMemory({ vaultPath: vault });
await Promise.all(plans.map((p) => memory.recordPlan(p)));
process.stdout.write(`ok ${plans.length}\n`);
