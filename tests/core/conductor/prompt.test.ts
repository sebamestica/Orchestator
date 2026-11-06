import { createHash } from 'node:crypto';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import {
  CONDUCTOR_PROMPT_PREFIX,
  CONDUCTOR_TOOL_NAMES,
  ConductorSession,
  MODE_TEXT,
  buildConductorSystemPrompt,
  effortNote,
  renderSessionContext,
} from '../../../src/core/conductor/index.ts';
import type { ConductorQueryFn } from '../../../src/core/conductor/index.ts';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { FAKE_API_KEY, FakeQuotas, SECRET_PATTERN, fakePorts, fixtureQuotas, promptBlocks } from './fakes.ts';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('prompt de sistema del orquestador', () => {
  it('el inicio es idéntico byte a byte con datos dinámicos distintos', async () => {
    const quotas = await fixtureQuotas();
    const a = buildConductorSystemPrompt({ projectId: 'vetworld', projectDir: 'C:\\dev\\vetworld', date: new Date('2026-11-01T10:00:00Z'), quotas, quotaFloor: 0.2 });
    const b = buildConductorSystemPrompt({ projectId: 'orquestador', projectDir: 'C:\\dev\\orquestador', date: new Date('2027-03-15T23:59:00Z'), quotaFloor: 0.35, notes: 'hoy solo Codex' });
    expect(a[0]).toBe(CONDUCTOR_PROMPT_PREFIX);
    expect(b[0]).toBe(CONDUCTOR_PROMPT_PREFIX);
    const [headA = '', headB = ''] = [a[0], b[0]];
    expect(Buffer.from(headA, 'utf8').equals(Buffer.from(headB, 'utf8'))).toBe(true);
    expect(sha(headA)).toBe(sha(headB));
    // Lo variable va después del marcador del SDK, nunca al inicio.
    expect(a[1]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(b[1]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(a[2]).not.toBe(b[2]);
    expect(a.join('\n').startsWith(CONDUCTOR_PROMPT_PREFIX)).toBe(true);
  });

  it('el prefijo no contiene datos de sesión (fechas, rutas, proyectos, cupos)', async () => {
    expect(CONDUCTOR_PROMPT_PREFIX).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(CONDUCTOR_PROMPT_PREFIX).not.toMatch(/[A-Z]:\\|\/mnt\/|\/home\//);
    expect(CONDUCTOR_PROMPT_PREFIX).not.toMatch(/\d+(?:[.,]\d+)? ?%/);
    expect(CONDUCTOR_PROMPT_PREFIX).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    const dynamic = renderSessionContext({ projectId: 'vetworld', projectDir: 'C:\\dev\\vetworld', date: new Date('2026-11-01T10:00:00Z'), quotas: await fixtureQuotas() });
    expect(dynamic).toMatch(/vetworld/);
    expect(dynamic).toMatch(/2026-11-01/);
    expect(dynamic).toMatch(/agy: \d+(?:\.\d)? %/);
  });

  it('lleva rol, reglas de la flota y el uso de las siete herramientas', () => {
    const p = CONDUCTOR_PROMPT_PREFIX;
    expect(p).toMatch(/^Eres el orquestador/);
    expect(p).toMatch(/no editas código ni ejecutas comandos: delegas/);
    expect(p).toMatch(/cada tarea tiene su worktree y su rama/);
    expect(p).toMatch(/modo local .*la flota trabaja directamente en la carpeta del proyecto, una tarea a la vez y sin commits/);
    expect(p).toMatch(/Propiedad de archivos/);
    expect(p).toMatch(/revisor de una tarea siempre es un agente distinto de su autor/);
    expect(p).toMatch(/Codex o agy agotan su cupo.*Claude continúa la tarea en el mismo worktree \(o en la misma carpeta, en modo local\)/);
    expect(p).toMatch(/Push, merge a main.*solo con aprobación explícita del usuario/);
    for (const name of CONDUCTOR_TOOL_NAMES) expect(p).toContain(`- ${name}(`);
    expect(p).toMatch(/Tú no puedes aprobarlas/);
    expect(p).toMatch(/Agent \(subagentes\)/);
  });

  it('trata como datos el contenido externo', () => {
    const p = CONDUCTOR_PROMPT_PREFIX;
    expect(p).toMatch(/## Contenido externo/);
    const section = p.split('## Contenido externo')[1]?.split('\n## ')[0] ?? '';
    for (const source of ['Chrome', 'Canva', 'Read', 'adjuntos', 'imagen']) expect(section, source).toContain(source);
    expect(section).toMatch(/no instrucciones/);
    expect(section).toMatch(/avísale al usuario/);
  });

  it('exige un plan de implementación en cada crear_tareas (en el prefijo fijo)', () => {
    const p = CONDUCTOR_PROMPT_PREFIX;
    expect(p).toMatch(/## Plan de implementación \(obligatorio\)/);
    expect(p).toMatch(/Toda llamada a crear_tareas lleva en plan un plan de implementación completo, aunque el usuario no lo pida y aunque no se le muestre/);
    for (const part of ['Objetivo', 'Pasos numerados', 'rutas propias', 'Riesgos', 'Verificación']) expect(p).toContain(part);
    expect(p).toMatch(/íntegro en plan, sin resumirlo, y guárdalo con escribir_memoria/);
    expect(p).toContain('.orq/PLAN.md');
    expect(p).toMatch(/## Modos/);
    // El modo concreto nunca va en el prefijo: solo en el contexto dinámico.
    expect(p).not.toMatch(/## Modo: /);
  });

  it('el modo y el agente suelto van en el contexto dinámico; el prefijo es el mismo en los tres modos', () => {
    const prompts = (['plan', 'auto', 'bypass'] as const).map((mode) => buildConductorSystemPrompt({ projectId: 'demo', projectDir: 'C:\\dev\\demo', mode }));
    for (const p of prompts) expect(p[0]).toBe(CONDUCTOR_PROMPT_PREFIX);
    expect(prompts[0]?.[2]).toMatch(/## Modo: plan[\s\S]*delegar no está disponible/);
    expect(prompts[1]?.[2]).toMatch(/## Modo: auto[\s\S]*quedan aprobadas al instante/);
    expect(prompts[2]?.[2]).toMatch(/## Modo: bypass[\s\S]*leer fuera de la carpeta del proyecto/);
    const solo = renderSessionContext({ projectId: null, projectDir: 'C:\\Users\\yo\\Desktop', mode: 'auto', extraRoots: ['D:\\fotos'] });
    expect(solo).toMatch(/Proyecto: ninguno \(conversación: sin proyecto ni flota\)/);
    expect(solo).toMatch(/## Conversación\n/);
    expect(solo).toMatch(/No le pidas una carpeta/);
    expect(solo).toMatch(/Carpetas extra de lectura: D:\\fotos/);
    expect(solo).not.toMatch(/## Modo:/);
  });

  it('el prefijo es idéntico byte a byte en los cuatro modos (también sin proyecto) y no contradice a bypass ni a chat', () => {
    const modes = ['plan', 'auto', 'bypass', 'chat'] as const;
    const heads = [
      ...modes.map((mode) => buildConductorSystemPrompt({ projectId: 'demo', projectDir: 'C:\\dev\\demo', mode, workMode: 'local' })[0] ?? ''),
      ...modes.map((mode) => buildConductorSystemPrompt({ projectId: null, projectDir: 'C:\\Users\\yo\\Desktop', mode })[0] ?? ''),
    ];
    expect(new Set(heads.map(sha)).size).toBe(1);
    expect(heads[0]).toBe(CONDUCTOR_PROMPT_PREFIX);
    const p = CONDUCTOR_PROMPT_PREFIX;
    expect(p).toMatch(/Fuera de los modos bypass y chat no editas código ni ejecutas comandos: delegas/);
    expect(p).toMatch(/Solo en bypass y chat editas archivos y ejecutas comandos/);
    expect(p).toMatch(/modo vigente \(plan, auto, bypass o chat\)/);
    expect(p).toMatch(/En chat no orquestas: no creas tareas ni delegas/);
    expect(p).toMatch(/En ningún modo haces push, pasas a main, despliegas, pagas, borras ramas ni reescribes la historia/);
    // Ninguna frase del prefijo obliga a la mente a no actuar, preguntar o terminar pidiendo cosas en bypass.
    expect(p).not.toMatch(/Tú no editas código/);
    expect(p).not.toMatch(/En ningún modo editas/);
    expect(p).not.toMatch(/lo que sigue y lo que necesitas del usuario/);
    expect(p).toMatch(/en bypass no preguntas/);
    expect(p).toMatch(/en bypass delegas sin presentarlas/);
    expect(p).toMatch(/Salvo en bypass, muéstraselas al usuario/);
  });

  it('MODE_TEXT.bypass: autonomía, hacerlo ella misma, no preguntar, plan interno, persistir y límites', () => {
    const text = MODE_TEXT.bypass.join('\n');
    expect(text).toMatch(/Claude Code autónomo con la flota a mano/);
    expect(text).toMatch(/Hazlo tú mismo cuando sea más rápido que delegar/);
    expect(text).toMatch(/edita y crea archivos \(Read, Edit, Write\) y ejecuta comandos \(Bash, PowerShell\)/);
    expect(text).toMatch(/carpeta del proyecto y en las carpetas extra del chat/);
    expect(text).toMatch(/no preguntes ni pidas confirmación/i);
    expect(text).toMatch(/Elige la opción razonable, aplícala y al final di .* qué decidiste/);
    expect(text).toMatch(/bloqueo real: credenciales que no tienes, un pago o algo irreversible fuera del proyecto/);
    expect(text).toMatch(/es interno: no se lo muestres al usuario/);
    expect(text).toMatch(/No termines tus respuestas con listas de «Necesito de ti» ni «Pendiente de ti»/);
    expect(text).toMatch(/Persiste: si algo falla, prueba otra vía \(otra herramienta, otro agente de la flota o hacerlo tú\)/);
    expect(text).toMatch(/Push, despliegue, pagos, borrar ramas y reescribir la historia siguen prohibidos/);
    expect(text).toMatch(/No ejecutes ni instales archivos bajados de internet ni adjuntos/);
    expect(MODE_TEXT.chat.join('\n')).toMatch(/No ejecutes ni instales archivos bajados de internet ni adjuntos/);
    // Nadie pasa a main por su cuenta: la flota integra en la rama de integración y main lo decide el usuario.
    expect(text).not.toMatch(/El paso a main lo hace la flota/);
    expect(text).toMatch(/pasar a main lo hace el usuario/);
    // Plan y auto no cambian: ni edición ni shell.
    for (const mode of ['plan', 'auto'] as const) expect(MODE_TEXT[mode].join('\n'), mode).not.toMatch(/Edit|Bash|no preguntes/i);
  });

  it('MODE_TEXT.chat: asistente directo como Claude Code, sin flota, con concisión según el esfuerzo', () => {
    const text = MODE_TEXT.chat.join('\n');
    expect(text).toContain('Conversas directamente con el usuario como un asistente de programación (como Claude Code): respondes, explicas y haces los cambios tú mismo en la carpeta. No creas tareas ni delegas a la flota.');
    expect(text).toMatch(/editas y creas archivos \(Edit, Write\) y ejecutas comandos \(Bash, PowerShell\)/);
    expect(text).toMatch(/Adjuntos: <ruta>/);
    expect(text).toMatch(/Concisión según el esfuerzo del turno/);
    expect(text).toMatch(/con bajo o medio responde rápido, corto y directo/);
    expect(text).toMatch(/Push, despliegue, pagos, borrar ramas y reescribir la historia siguen prohibidos/);
    expect(text).not.toMatch(/crear_tareas \(|delegar\)/);
    // Con proyecto y sin él, el modo chat lleva su texto (no el del agente suelto).
    for (const projectId of ['demo', null]) {
      const ctx = renderSessionContext({ projectId, projectDir: 'C:\\dev\\demo', mode: 'chat' });
      expect(ctx, String(projectId)).toMatch(/## Modo: chat\n- Conversas directamente/);
      expect(ctx, String(projectId)).not.toMatch(/## Conversación\n/);
    }
    // El agente suelto en los otros modos sugiere el modo chat para editar.
    expect(renderSessionContext({ projectId: null, projectDir: 'C:\\x', mode: 'bypass' })).toMatch(/## Conversación\n[\s\S]*sugiérele el modo chat/);
  });

  it('effortNote: la línea del esfuerzo del turno, en español', () => {
    expect(effortNote('low')).toBe('[Esfuerzo de este turno: bajo]');
    expect(effortNote('medium')).toBe('[Esfuerzo de este turno: medio]');
    expect(effortNote('high')).toBe('[Esfuerzo de este turno: alto]');
    expect(effortNote('xhigh')).toBe('[Esfuerzo de este turno: muy alto]');
    expect(effortNote('max')).toBe('[Esfuerzo de este turno: máximo]');
    expect(CONDUCTOR_PROMPT_PREFIX).not.toContain('[Esfuerzo de este turno');
  });

  it('el modo de trabajo del proyecto va en el contexto: en local, la mente sabe que no hacen falta commits', () => {
    const local = renderSessionContext({ projectId: 'marketing', projectDir: 'C:\\dev\\marketing', mode: 'bypass', workMode: 'local' });
    expect(local).toMatch(/Modo de trabajo: local\. La flota escribe directamente en C:\\dev\\marketing/);
    expect(local).toMatch(/No le pidas al usuario commits, git init ni ramas/);
    const wt = renderSessionContext({ projectId: 'orquestador', projectDir: 'C:\\dev\\orquestador', workMode: 'worktrees' });
    expect(wt).toMatch(/Modo de trabajo: worktrees/);
    // Sin el dato (terminal antigua), no se agrega la línea; el prefijo no cambia.
    expect(renderSessionContext({ projectId: 'x1', projectDir: 'C:\\x' })).not.toMatch(/Modo de trabajo/);
    expect(buildConductorSystemPrompt({ projectId: 'marketing', projectDir: 'C:\\dev\\marketing', workMode: 'local' })[0]).toBe(CONDUCTOR_PROMPT_PREFIX);
  });

  it('tacha secretos del contexto dinámico', () => {
    const text = renderSessionContext({ projectId: 'demo', projectDir: 'C:\\dev\\demo', notes: `usa ${FAKE_API_KEY}`, secrets: ['secreto-de-sesion-9f8e7d6c'] });
    expect(text).not.toMatch(SECRET_PATTERN);
  });

  it('dos sesiones con proyectos y cupos distintos mandan el mismo inicio de prompt al SDK', async () => {
    const captured: Options[] = [];
    const query: ConductorQueryFn = ({ options }) => {
      captured.push(options);
      return (async function* () {})();
    };
    const quotas = await fixtureQuotas();
    const one = new ConductorSession({ ports: fakePorts({ quotas: new FakeQuotas(quotas) }), projectId: 'vetworld', cwd: 'C:\\dev\\vetworld', query, now: () => new Date('2026-11-01T08:00:00Z') });
    const two = new ConductorSession({ ports: fakePorts(), projectId: 'orquestador', cwd: 'C:\\dev\\orquestador', query, now: () => new Date('2026-12-24T20:00:00Z'), notes: 'otra nota' });
    one.send('hola');
    two.send('hola');
    const [s1 = [], s2 = []] = captured.map(promptBlocks);
    expect(s1[0]).toBe(s2[0]);
    expect(s1[0]).toBe(CONDUCTOR_PROMPT_PREFIX);
    expect(s1[2]).not.toBe(s2[2]);
    one.close();
    two.close();
  });
});
