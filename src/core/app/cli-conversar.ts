import { z } from 'zod';
import { idSchema, redactSecrets } from '../../shared/index.ts';
import { CONDUCTOR_AGENT_ID } from '../conductor/index.ts';
import { CliError, parseFlags, parseUsd, type CliIo } from './cli-io.ts';
import type { Composition } from './compose.ts';
import { createConductor, describeProposals, usageDeltas, type ConductorOptions } from './conductor.ts';

const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export const CONVERSAR_HELP =
  'Una línea = un mensaje. /propuestas lista las tareas propuestas; /aprobar <ids> las aprueba y las entrega a la flota, /rechazar <ids> las descarta (eso es solo tuyo); /salir termina.';

/** Pruebas: `query` falsa y espera de cupos. */
export type ConversarTestHooks = Pick<ConductorOptions, 'query' | 'quotaTimeoutMs'>;

/**
 * `conversar`: chat con el orquestador desde la terminal, solo con la clave de la bóveda. Cada línea de stdin va a la
 * `ConductorSession`; se imprimen las respuestas de texto y los eventos quedan en SQLite (uso en diferencias).
 */
export async function conversar(argv: readonly string[], io: CliIo, comp: Composition, hooks: ConversarTestHooks = {}): Promise<number> {
  const f = parseFlags(argv, {
    agente: { type: 'string' },
    proyecto: { type: 'string' },
    carpeta: { type: 'string' },
    presupuesto: { type: 'string' },
    esfuerzo: { type: 'string' },
  });
  const projectId = idSchema.safeParse(f.proyecto ?? 'orquestador');
  if (!projectId.success) throw new CliError('--proyecto: minúsculas, dígitos y guiones');
  const effort = f.esfuerzo === undefined ? undefined : effortSchema.safeParse(f.esfuerzo);
  if (effort && !effort.success) throw new CliError('--esfuerzo: low, medium, high, xhigh o max');
  const maxBudgetUsd = parseUsd(f.presupuesto, '--presupuesto');
  const cwd = f.carpeta ?? process.cwd();

  const conductor = await createConductor(comp, {
    projectId: projectId.data,
    cwd,
    ...(f.agente ? { agentId: f.agente } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(effort?.success ? { effort: effort.data } : {}),
    log: (line) => io.err(line),
    ...hooks,
  });
  const { session, proposals, agent } = conductor;
  io.out(`Orquestador (${session.model}) con la clave de ${agent.config.id} desde la bóveda · proyecto ${projectId.data} · ${cwd}`);
  io.out(CONVERSAR_HELP);
  for (const w of session.warnings) io.err(`Aviso: ${w}`);

  const delta = usageDeltas();
  let turnDone: (() => void) | undefined;
  let ended = false;
  let crashed = false;
  const reader = (async () => {
    try {
      for await (const event of session.events()) {
        const stored = delta(event);
        try {
          if (stored) comp.store.append(stored);
        } catch {
          io.err('Aviso: no se pudo guardar un evento en SQLite');
        }
        if (event.parentSessionId) continue;
        if (event.type === 'text' && event.payload.role === 'assistant') io.out(`orquestador> ${event.payload.text}`);
        else if (event.type === 'tool_call') io.err(`  · ${event.payload.name}`);
        else if (event.type === 'error') io.err(`Error: ${event.payload.message}`);
        else if (event.type === 'done') {
          turnDone?.();
          turnDone = undefined;
        }
      }
    } catch (err) {
      crashed = true;
      io.err(`Error: ${redactSecrets(err instanceof Error ? err.message : String(err))}`.slice(0, 1000));
    } finally {
      ended = true;
      turnDone?.();
    }
  })();

  try {
    for await (const raw of io.lines()) {
      const line = raw.trim();
      if (!line) continue;
      if (line === '/salir') break;
      if (line === '/propuestas') {
        const list = describeProposals(proposals, projectId.data);
        io.out(list.length ? list.join('\n') : '(sin tareas propuestas)');
        continue;
      }
      const decision = /^\/(aprobar|rechazar)\s+(.+)$/.exec(line);
      if (decision) {
        const ids = (decision[2] ?? '').split(/[\s,]+/).filter(Boolean);
        try {
          if (decision[1] === 'aprobar') {
            // Modo plan: lo aprobado pasa directo a la flota, en orden de dependencias.
            const report = await conductor.approve(ids);
            if (report.delivered.length) io.out(`Aprobadas y entregadas a la flota: ${report.delivered.join(', ')}`);
            for (const f of report.failed) io.err(`Aprobada ${f.taskId}, pero no se entregó: ${f.reason}`);
          } else {
            io.out(`Rechazadas: ${proposals.reject(ids).map((p) => p.task.id).join(', ')}`);
          }
        } catch (err) {
          io.err(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      if (ended) break;
      const turn = new Promise<void>((resolve) => {
        turnDone = resolve;
      });
      session.send(line);
      await turn;
    }
  } finally {
    await conductor.close();
    await Promise.race([reader, new Promise((r) => setTimeout(r, 5_000).unref())]);
  }
  io.out(`Gasto del orquestador registrado en SQLite: ${comp.spentUsd(CONDUCTOR_AGENT_ID).toFixed(4)} USD`);
  return crashed ? 1 : 0;
}
