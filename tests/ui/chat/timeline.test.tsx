// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  activityOf,
  anchorProposals,
  buildReply,
  MAX_SESSION_EVENTS,
  mergeEvents,
  PROPOSALS_AT_END,
  splitTurns,
  upsertMessage,
} from '../../../src/ui/features/chat/timeline.ts';
import { COMPACTED_DETAIL } from '../../../src/shared/index.ts';
import type { AgentEvent } from '../../../src/shared/index.ts';
import { at, ev, makeMessage, makeProposal } from './helpers.ts';

describe('mergeEvents', () => {
  it('une sin duplicar por seq y en orden aunque el replay llegue después del vivo', () => {
    const live = [ev.text(2, 2, 'c'), ev.text(3, 3, 'd')];
    const replay = [ev.text(0, 0, 'a'), ev.text(1, 1, 'b'), ev.text(2, 2, 'c')];
    const merged = mergeEvents(live, replay);
    expect(merged.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it('devuelve el mismo arreglo si no hay nada nuevo', () => {
    const prev = [ev.text(0, 0, 'a')];
    expect(mergeEvents(prev, [ev.text(0, 0, 'a')])).toBe(prev);
    expect(mergeEvents(prev, [])).toBe(prev);
  });

  it(`recorta a los últimos ${MAX_SESSION_EVENTS} eventos`, () => {
    const many = Array.from({ length: 620 }, (_, i) => ev.text(i, i, 'x'));
    const merged = mergeEvents([], many);
    expect(merged).toHaveLength(MAX_SESSION_EVENTS);
    expect(merged[0]?.seq).toBe(120);
    expect(merged.at(-1)?.seq).toBe(619);
  });
});

describe('buildReply', () => {
  it('junta los deltas de texto y pone la herramienta con su resultado en su lugar', () => {
    const draft = buildReply([
      ev.text(0, 1, 'Hola, '),
      ev.text(1, 1, 'mundo'),
      ev.call(2, 2, 'c1', 'mcp__orquestador__estado', 'proyecto demo'),
      ev.text(3, 3, 'Sigo.'),
      ev.result(4, 4, 'c1', true, '3 tareas'),
      ev.usage(5, 5, 1000, 200, 0.01),
      ev.usage(6, 6, 1500, 300, 0.02),
    ]);
    expect(draft.items).toEqual([
      { kind: 'text', key: 'text-0', text: 'Hola, mundo' },
      { kind: 'tool', key: 'tool-c1-2', callId: 'c1', name: 'mcp__orquestador__estado', input: 'proyecto demo', result: { ok: true, summary: '3 tareas' } },
      { kind: 'text', key: 'text-3', text: 'Sigo.' },
    ]);
    // El uso es acumulado por modelo: cuenta el último.
    expect(draft.usage).toEqual({ inputTokens: 1500, outputTokens: 300, costUsd: 0.02, models: ['claude-opus-5-5'] });
    expect(draft.done).toBe(false);
  });

  it('marca en su lugar del turno que el SDK compactó la conversación, y la marca sobrevive en activityOf', () => {
    const draft = buildReply([ev.text(0, 1, 'a'), ev.status(1, 2, COMPACTED_DETAIL), ev.text(2, 3, 'b'), ev.status(3, 4, 'modelo x')]);
    expect(draft.items.map((i) => i.kind)).toEqual(['text', 'compact', 'text']);
    expect(activityOf(draft).map((i) => i.kind)).toEqual(['compact']);
  });

  it('separa el pensamiento del texto y marca done', () => {
    const draft = buildReply([ev.thinking(0, 0, 'pienso'), ev.text(1, 0, 'digo'), ev.done(2, 1)]);
    expect(draft.items.map((i) => i.kind)).toEqual(['thinking', 'text']);
    expect(draft.done).toBe(true);
    expect(activityOf(draft)).toEqual([]);
  });
});

/** Estado cancelado del turno de la mente (lo que deja «Detener»). */
function cancelledAt(seq: number, sec: number): AgentEvent {
  const base = ev.status(seq, sec, 'interrumpido por ti');
  return { ...base, type: 'status', payload: { state: 'cancelled', detail: 'interrumpido por ti' } } as AgentEvent;
}

describe('splitTurns', () => {
  const messages = [
    makeMessage({ id: 'u1', role: 'user', text: 'hola', at: at(0) }),
    makeMessage({ id: 'a1', role: 'assistant', text: 'respuesta', at: at(10) }),
    makeMessage({ id: 'u2', role: 'user', text: 'otra', at: at(20) }),
  ];

  it('asigna a cada respuesta guardada los eventos de su turno y deja el resto como borrador', () => {
    const events = [ev.call(0, 2, 'c1', 'Read', 'a.ts'), ev.text(1, 5, 'respuesta'), ev.usage(2, 15, 1, 1), ev.text(3, 21, 'en curso')];
    const turns = splitTurns(events, messages);
    expect(turns.byMessage.get('a1')?.map((e) => e.seq)).toEqual([0, 1]);
    expect(turns.pending.map((e) => e.seq)).toEqual([3]);
  });

  it('no ancla como turno sin respuesta los eventos sueltos sin pasos (el usage tras la respuesta)', () => {
    const events = [ev.call(0, 2, 'c1', 'Read', 'a.ts'), ev.text(1, 5, 'respuesta'), ev.usage(2, 15, 1, 1), ev.text(3, 21, 'en curso')];
    expect(splitTurns(events, messages).orphans.size).toBe(0);
  });

  it('guarda bajo el mensaje del usuario los pasos y el error de un turno que terminó sin respuesta', () => {
    const list = [
      makeMessage({ id: 'u1', role: 'user', text: 'hola', at: at(10) }),
      makeMessage({ id: 'u2', role: 'user', text: 'otra vez', at: at(50) }),
      makeMessage({ id: 'a2', role: 'assistant', text: 'listo', at: at(80) }),
    ];
    const events = [ev.call(0, 12, 'c1', 'Read', 'a.ts'), ev.error(1, 15, 'Se agotó el cupo'), ev.text(2, 60, 'listo')];
    const turns = splitTurns(events, list);
    expect(turns.orphans.get('u1')?.map((e) => e.seq)).toEqual([0, 1]);
    expect(turns.byMessage.get('a2')?.map((e) => e.seq)).toEqual([2]);
    expect(turns.pending).toEqual([]);
  });

  it('mente-10: un mensaje enviado con el turno vivo no lo parte: los pasos siguen en la respuesta de ese turno', () => {
    const list = [
      makeMessage({ id: 'u1', role: 'user', text: 'continua', at: at(10) }),
      makeMessage({ id: 'u2', role: 'user', text: 'levanta la página', at: at(50) }),
    ];
    const events = [ev.call(0, 12, 'c1', 'Read', 'a.ts'), ev.call(1, 20, 'c2', 'Agent', 'investigador: revisa'), ev.text(2, 60, 'Recibido, la levanto')];
    // Turno en curso: nada queda como «turno sin respuesta» y el borrador trae los pasos de antes y de después.
    const live = splitTurns(events, list);
    expect(live.orphans.size).toBe(0);
    expect(live.pending.map((e) => e.seq)).toEqual([0, 1, 2]);
    // Al guardarse la respuesta, esa respuesta se queda con todo el turno.
    const done = splitTurns([...events, ev.done(3, 70)], [...list, makeMessage({ id: 'a1', role: 'assistant', text: 'listo', at: at(70) })]);
    expect(done.orphans.size).toBe(0);
    expect(done.byMessage.get('a1')?.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(done.pending).toEqual([]);
  });

  it('mente-10: si el turno anterior se cerró (Detener, error), sus pasos sí quedan como turno sin respuesta', () => {
    const list = [
      makeMessage({ id: 'u1', role: 'user', text: 'hola', at: at(10) }),
      makeMessage({ id: 'u2', role: 'user', text: 'otra vez', at: at(50) }),
    ];
    const events = [ev.call(0, 12, 'c1', 'Read', 'a.ts'), cancelledAt(1, 15), ev.text(2, 60, 'nuevo')];
    const turns = splitTurns(events, list);
    expect(turns.orphans.get('u1')?.map((e) => e.seq)).toEqual([0, 1]);
    expect(turns.pending.map((e) => e.seq)).toEqual([2]);
  });

  it('sin mensajes, todo es borrador', () => {
    const events = [ev.text(0, 1, 'x')];
    expect(splitTurns(events, []).pending).toEqual(events);
  });
});

describe('anchorProposals', () => {
  it('ancla la propuesta a la primera respuesta guardada después, o al final si aún no hay', () => {
    const messages = [makeMessage({ id: 'u1', role: 'user', text: 'x', at: at(0) }), makeMessage({ id: 'a1', role: 'assistant', text: 'y', at: at(10) })];
    const anchors = anchorProposals([makeProposal('t1', { proposedAt: at(5) }), makeProposal('t2', { proposedAt: at(30) })], messages);
    expect(anchors.get('a1')?.map((p) => p.task.id)).toEqual(['t1']);
    expect(anchors.get(PROPOSALS_AT_END)?.map((p) => p.task.id)).toEqual(['t2']);
  });
});

describe('upsertMessage', () => {
  it('reemplaza por id y mantiene el orden por fecha', () => {
    const a = makeMessage({ id: 'a', role: 'user', text: 'a', at: at(0) });
    const c = makeMessage({ id: 'c', role: 'user', text: 'c', at: at(20) });
    const b = makeMessage({ id: 'b', role: 'assistant', text: 'b', at: at(10) });
    const list = upsertMessage([a, c], b);
    expect(list.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(upsertMessage(list, { ...b, text: 'b2' }).find((m) => m.id === 'b')?.text).toBe('b2');
  });
});
