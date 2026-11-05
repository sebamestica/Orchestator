import { join } from 'node:path';
import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { BYPASS_TOOLS } from '../../../src/core/conductor/index.ts';
import { sendMessageBody } from '../../../src/shared/index.ts';
import { bench, closeBenches, type ChatBench } from './helpers.ts';

afterEach(closeBenches);

function optionsOf(b: ChatBench, i = 0): Options {
  const call = b.q.calls[i];
  if (!call) throw new Error(`query no se llamó ${i + 1} veces`);
  return call.options;
}

function guardOf(o: Options, cwd: string) {
  const hook = (o.hooks?.PreToolUse as HookCallbackMatcher[] | undefined)?.[0]?.hooks[0];
  if (!hook) throw new Error('falta la guardia');
  const signal = new AbortController().signal;
  return async (tool_name: string, tool_input: unknown): Promise<boolean> => {
    const out = await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: 'p', cwd }, 't', { signal });
    return !JSON.stringify(out).includes('"deny"');
  };
}

const textOf = (b: ChatBench, i: number) => {
  const content = b.q.received[i]?.message.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
};

async function turn(b: ChatBench, chatId: string, text: string, effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max') {
  const message = await b.service.send(chatId, { text, ...(effort ? { effort } : {}) });
  await b.settle(chatId);
  return message;
}

describe('ChatService: modo chat (como Claude Code)', () => {
  it('con proyecto: el SDK recibe las herramientas de Claude Code y no las de la flota; la guardia acota la escritura', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo', mode: 'chat' });
    expect(chat.mode).toBe('chat');
    await turn(b, chat.id, 'arregla el README');
    const o = optionsOf(b);
    for (const t of BYPASS_TOOLS) expect(o.allowedTools).toContain(t);
    for (const t of ['crear_tareas', 'delegar']) {
      expect(o.allowedTools).not.toContain(`mcp__orquestador__${t}`);
      expect(o.disallowedTools).toContain(`mcp__orquestador__${t}`);
    }
    expect((o.systemPrompt as string[])[2]).toMatch(/## Modo: chat/);
    const pre = guardOf(o, b.repo);
    expect(await pre('Write', { file_path: join(b.repo, 'README.md'), content: '# Demo' })).toBe(true);
    expect(await pre('Write', { file_path: join(b.dir, 'fuera.md'), content: 'x' })).toBe(false);
    expect(await pre('Bash', { command: 'git push' })).toBe(false);
    expect(await pre('mcp__orquestador__crear_tareas', { plan: 'x' })).toBe(false);
    // Las tareas no existen en este modo: ni propuestas ni flota.
    expect(b.ports.fleet.delegated).toEqual([]);
    expect(b.service.messages(chat.id).map((m) => m.mode)).toEqual(['chat', 'chat']);
  });

  it('agente suelto (sin proyecto): modo chat con la carpeta del chat como raíz', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: null, cwd: b.repo, mode: 'chat' });
    await turn(b, chat.id, 'hola');
    const o = optionsOf(b);
    expect(o.cwd).toBe(b.repo);
    for (const t of BYPASS_TOOLS) expect(o.allowedTools).toContain(t);
    expect(o.allowedTools).not.toContain('mcp__orquestador__crear_tareas');
    expect((o.systemPrompt as string[])[2]).toMatch(/agente suelto[\s\S]*## Modo: chat/);
    const pre = guardOf(o, b.repo);
    expect(await pre('Write', { file_path: join(b.repo, 'notas.md'), content: 'x' })).toBe(true);
    expect(await pre('Bash', { command: 'git status' })).toBe(true);
    expect(await pre('Write', { file_path: join(b.dir, 'fuera.md'), content: 'x' })).toBe(false);
  });

  it('cambiar de chat a plan recrea la sesión sin edición (reanudada)', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo', mode: 'chat' });
    await turn(b, chat.id, 'uno');
    b.service.patch(chat.id, { mode: 'plan' });
    await turn(b, chat.id, 'dos');
    const o = optionsOf(b, 1);
    expect(o.resume).toBe('sdk-1');
    for (const t of BYPASS_TOOLS) expect(o.allowedTools).not.toContain(t);
    expect(o.allowedTools).toContain('mcp__orquestador__crear_tareas');
  });
});

describe('ChatService: esfuerzo por mensaje', () => {
  it('el contrato acepta effort opcional y lo valida', () => {
    expect(sendMessageBody.parse({ text: 'hola', effort: 'low' })).toEqual({ text: 'hola', attachmentIds: [], effort: 'low' });
    expect(sendMessageBody.parse({ text: 'hola' })).toEqual({ text: 'hola', attachmentIds: [] });
    expect(sendMessageBody.safeParse({ text: 'hola', effort: 'turbo' }).success).toBe(false);
  });

  it('con applyFlagSettings: el esfuerzo cambia en vivo, sin recrear el proceso; la mente recibe la nota y el historial no', async () => {
    const b = await bench({ flags: true });
    const chat = b.service.create({ projectId: 'demo', mode: 'chat' });
    // Primer turno con esfuerzo propio: va directo en las opciones del SDK.
    await turn(b, chat.id, 'uno', 'low');
    expect(optionsOf(b).effort).toBe('low');
    expect(textOf(b, 0)).toBe('[Esfuerzo de este turno: bajo]\nuno');
    await turn(b, chat.id, 'dos', 'max');
    await turn(b, chat.id, 'tres');
    expect(b.q.calls).toHaveLength(1);
    expect(b.q.flags).toEqual([
      { process: 1, settings: { effortLevel: 'max' } },
      // Sin effort, vuelve al de los ajustes.
      { process: 1, settings: { effortLevel: 'medium' } },
    ]);
    expect(textOf(b, 1)).toBe('[Esfuerzo de este turno: máximo]\ndos');
    expect(textOf(b, 2)).toBe('tres');
    expect(b.service.messages(chat.id).filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['uno', 'dos', 'tres']);
  });

  it('sin applyFlagSettings: la sesión se recrea reanudada con el esfuerzo del turno', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo', mode: 'auto' });
    await turn(b, chat.id, 'uno');
    expect(optionsOf(b, 0).effort).toBe('medium');
    await turn(b, chat.id, 'dos', 'low');
    expect(b.q.calls).toHaveLength(2);
    expect(optionsOf(b, 1)).toMatchObject({ effort: 'low', resume: 'sdk-1' });
    // El mismo esfuerzo no la recrea.
    await turn(b, chat.id, 'tres', 'low');
    expect(b.q.calls).toHaveLength(2);
    await turn(b, chat.id, 'cuatro');
    expect(b.q.calls).toHaveLength(3);
    expect(optionsOf(b, 2).effort).toBe('medium');
  });

  it('un esfuerzo inválido se rechaza sin tocar la sesión', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo' });
    await expect(b.service.send(chat.id, { text: 'hola', effort: 'turbo' as 'low' })).rejects.toMatchObject({ code: 'invalid' });
    expect(b.q.calls).toHaveLength(0);
    await turn(b, chat.id, 'hola');
    expect(b.q.calls).toHaveLength(1);
  });
});
