/**
 * Flujo guionado de punta a punta por la sesión: el «modelo» es una query falsa que llama a las
 * herramientas reales del orquestador; el usuario aprueba entre turnos.
 *   crear_tareas → (delegar antes de aprobar: rechazado) → usuario aprueba → delegar → estado
 */
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { ConductorSession, mcpToolName } from '../../../src/core/conductor/index.ts';
import type { ConductorToolName, ToolResult } from '../../../src/core/conductor/index.ts';
import { assistantText, assistantToolUse, fakePorts, readTurn, resultMessage, scriptedQuery, textOf, toolResultMessage, userText } from './fakes.ts';

describe('flujo guionado del orquestador', () => {
  it('crear_tareas → el usuario aprueba → delegar → estado', async () => {
    const ports = fakePorts();
    const calls: { name: ConductorToolName; result: ToolResult }[] = [];
    const ref: { session?: ConductorSession } = {};
    let n = 0;

    /** Lo que haría el modelo: pedir una herramienta y recibir su resultado. */
    async function use(name: ConductorToolName, args: unknown): Promise<SDKMessage[]> {
      if (!ref.session) throw new Error('sin sesión');
      const id = `toolu_${++n}`;
      const result = await ref.session.tools.call(name, args);
      calls.push({ name, result });
      return [assistantToolUse(id, mcpToolName(name), args), toolResultMessage(id, textOf(result), result.isError === true)];
    }

    const script = async (message: SDKUserMessage, turn: number): Promise<SDKMessage[]> => {
      const text = userText(message);
      if (turn === 0) {
        const out = [...(await use('leer_memoria', { proyecto: 'demo' })), ...(await use('cupos', {})), ...(await use('crear_tareas', { plan: text }))];
        // Un modelo impaciente intenta delegar sin aprobación: la herramienta lo frena.
        out.push(...(await use('delegar', { taskId: 'api' })));
        out.push(assistantText('Propuse 2 tareas (api, ui). ¿Las apruebas?'), resultMessage('propuestas'));
        return out;
      }
      if (turn === 1) {
        const out = [...(await use('delegar', { taskId: 'api' })), ...(await use('delegar', { taskId: 'ui' })), ...(await use('estado', {}))];
        out.push(assistantText('Delegadas api y ui.'), resultMessage('delegadas'));
        return out;
      }
      const out = await use('estado', { taskId: 'api' });
      out.push(assistantText('api está en ejecución.'), resultMessage('estado'));
      return out;
    };

    const q = scriptedQuery(script);
    const session = new ConductorSession({ ports, projectId: 'demo', cwd: 'C:\\dev\\demo', env: { ANTHROPIC_API_KEY: 'clave-del-proxy-0123456789' }, baseEnv: {}, query: q.fn });
    ref.session = session;
    const stream = session.messages()[Symbol.asyncIterator]();

    // Turno 1: el usuario da el plan; el orquestador propone y no puede delegar todavía.
    session.send('Separar la API y la interfaz del tablero');
    const t1 = await readTurn(stream);
    expect(t1.at(-1)?.type).toBe('result');
    expect(calls.map((c) => c.name)).toEqual(['leer_memoria', 'cupos', 'crear_tareas', 'delegar']);
    expect(calls[2]?.result.isError).toBeFalsy();
    expect(calls[3]?.result.isError).toBe(true);
    expect(textOf(calls[3]?.result ?? { content: [] })).toMatch(/no está aprobada/);
    expect(ports.fleet.delegated).toEqual([]);
    expect(ports.proposals.list().map((e) => e.approval)).toEqual(['proposed', 'proposed']);
    expect(ports.planner.requests[0]?.planText).toBe('Separar la API y la interfaz del tablero');

    // El usuario aprueba desde la interfaz (no hay herramienta para que el modelo se apruebe solo).
    ports.proposals.approve(['api', 'ui']);
    session.send('Aprobadas, delégalas');
    await readTurn(stream);
    expect(calls.slice(4).map((c) => [c.name, c.result.isError ?? false])).toEqual([['delegar', false], ['delegar', false], ['estado', false]]);
    expect(ports.fleet.delegated.map((t) => t.id)).toEqual(['api', 'ui']);
    expect(ports.proposals.list().map((e) => e.approval)).toEqual(['delegated', 'delegated']);
    expect(JSON.parse(textOf(calls[6]?.result ?? { content: [] }))).toMatchObject({ total: 2, porAprobacion: { delegated: 2 }, porEstado: { pending: 2 } });

    // La flota avanza y el usuario pregunta.
    ports.fleet.advance('api', 'running', 'escribiendo pruebas');
    session.send('¿Cómo va api?');
    const t3 = await readTurn(stream);
    expect(JSON.parse(textOf(calls[7]?.result ?? { content: [] }))).toMatchObject({ tarea: 'api', aprobacion: 'delegated', estado: 'running', agente: 'claude-worker', detalle: 'escribiendo pruebas' });
    expect(JSON.stringify(t3)).toContain('mcp__orquestador__estado');

    // Toda la conversación pasó por una sola query y las herramientas usadas están en allowedTools.
    expect(q.calls).toHaveLength(1);
    for (const c of calls) expect(q.calls[0]?.options.allowedTools).toContain(mcpToolName(c.name));
    session.close();
  });
});
