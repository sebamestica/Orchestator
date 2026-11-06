/**
 * autoeval-trabajo-04: lo que la mente cambia ella misma (modo chat, o bypass con proyecto) queda en la memoria del
 * proyecto como una sesión de `orquestador`, con los archivos que tocó. Ver
 * inssues/autoeval-trabajo-04-trabajo-propio-de-la-mente-sin-memoria.md.
 */
import { randomUUID as uuid } from 'node:crypto';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { MODE_TEXT } from '../../../src/core/conductor/index.ts';
import { bench, closeBenches, sdkInit, sdkResult, sdkText, type ChatBench, type TurnFn } from './helpers.ts';

afterEach(closeBenches);

function toolUse(sid: string, id: string, name: string, input: unknown, parent: string | null = null): SDKMessage {
  return {
    type: 'assistant',
    message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
    parent_tool_use_id: parent,
    uuid: uuid(),
    session_id: sid,
  } as unknown as SDKMessage;
}

function toolResult(sid: string, id: string, parent: string | null = null): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    parent_tool_use_id: parent,
    uuid: uuid(),
    session_id: sid,
  } as unknown as SDKMessage;
}

/** Guion según el texto del usuario: escribe, corre un comando, delega en un subagente que escribe o solo responde. */
const repoOf: { path: string } = { path: '' };
const scripted: TurnFn = (message, ctx) => {
  const sid = typeof ctx.options.resume === 'string' ? ctx.options.resume : `sdk-${ctx.process}`;
  const content = message.message.content;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const steps: SDKMessage[] = [];
  if (text.includes('escribe')) steps.push(toolUse(sid, 'w1', 'Write', { file_path: join(repoOf.path, 'notas.md'), content: 'hola' }), toolResult(sid, 'w1'));
  if (text.includes('comando')) steps.push(toolUse(sid, 'b1', 'Bash', { command: 'npm install' }), toolResult(sid, 'b1'));
  if (text.includes('subagente')) {
    steps.push(
      toolUse(sid, 'a1', 'Agent', { description: 'Escribir guía', prompt: 'escribe docs/guia.md', subagent_type: 'general-purpose' }),
      toolUse(sid, 'w2', 'Write', { file_path: join(repoOf.path, 'docs', 'guia.md'), content: 'guía' }, 'a1'),
      toolResult(sid, 'w2', 'a1'),
      toolResult(sid, 'a1'),
    );
  }
  return [...(ctx.index === 0 ? [sdkInit(sid)] : []), ...steps, sdkText('Listo.', sid), sdkResult('Listo.', sid, 0.01)];
};

async function chatBench(): Promise<ChatBench> {
  const b = await bench({ turn: scripted });
  repoOf.path = b.repo;
  return b;
}

async function turn(b: ChatBench, chatId: string, text: string): Promise<void> {
  await b.service.send(chatId, { text });
  await b.settle(chatId);
}

describe('ChatService: el trabajo propio de la mente queda en la memoria del proyecto', () => {
  it('un Write en modo chat registra una sesión de orquestador con el archivo', async () => {
    const b = await chatBench();
    const chat = b.service.create({ projectId: 'demo', mode: 'chat', title: 'Notas del proyecto' });
    await turn(b, chat.id, 'escribe notas.md');
    expect(b.ports.memory.sessions).toHaveLength(1);
    expect(b.ports.memory.sessions[0]).toMatchObject({
      projectId: 'demo', taskId: `chat-${chat.id}`, agentId: 'orquestador', title: 'Notas del proyecto',
      filesChanged: ['notas.md'], outcome: 'ok',
    });
    expect(b.ports.memory.sessions[0]?.summary).toContain('Listo.');
  });

  it('un turno solo de texto no registra nada', async () => {
    const b = await chatBench();
    const chat = b.service.create({ projectId: 'demo', mode: 'chat' });
    await turn(b, chat.id, 'hola');
    expect(b.ports.memory.sessions).toEqual([]);
  });

  it('un comando sin Write registra la sesión y avisa que corrió comandos', async () => {
    const b = await chatBench();
    const chat = b.service.create({ projectId: 'demo', mode: 'chat' });
    await turn(b, chat.id, 'corre un comando');
    expect(b.ports.memory.sessions).toHaveLength(1);
    expect(b.ports.memory.sessions[0]?.filesChanged).toEqual([]);
    expect(b.ports.memory.sessions[0]?.summary).toMatch(/corrió comandos/);
  });

  it('un Write de un subagente entra en los archivos del turno', async () => {
    const b = await chatBench();
    const chat = b.service.create({ projectId: 'demo', mode: 'chat' });
    await turn(b, chat.id, 'escribe notas.md y usa un subagente');
    expect(b.ports.memory.sessions[0]?.filesChanged).toEqual(['notas.md', 'docs/guia.md']);
  });

  it('en una Conversación o en modo plan no registra nada', async () => {
    const b = await chatBench();
    const conversation = b.service.create({ projectId: null, cwd: b.dir, mode: 'chat' });
    await turn(b, conversation.id, 'escribe notas.md');
    const plan = b.service.create({ projectId: 'demo', mode: 'plan' });
    await turn(b, plan.id, 'escribe notas.md');
    expect(b.ports.memory.sessions).toEqual([]);
  });

  it('si la memoria falla, el turno termina igual y el chat queda idle', async () => {
    const b = await chatBench();
    b.ports.memory.failRecord = new Error('bóveda retenida');
    const chat = b.service.create({ projectId: 'demo', mode: 'chat' });
    await turn(b, chat.id, 'escribe notas.md');
    expect(b.service.get(chat.id).state).toBe('idle');
  });

  it('el modo chat con proyecto pide leer y escribir la memoria', () => {
    const text = MODE_TEXT.chat.join('\n');
    expect(text).toMatch(/leer_memoria/);
    expect(text).toMatch(/escribir_memoria/);
  });
});
