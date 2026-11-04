import { describe, expect, it } from 'vitest';
import { BudgetWriter, estimateTokens, measureSavings, ownedPathMatcher, rankSessions, significantWords, truncateText, type SessionCandidate } from '../../../src/core/memory/context.ts';

const session = (over: Partial<SessionCandidate>): SessionCandidate => ({
  notePath: 'Orquestador/Sesiones/x.md', taskId: 'otra', agentId: 'codex', title: 'Algo', outcome: 'ok', summary: '', files: [], at: '2026-11-01T10:00:00Z', ...over,
});

describe('ownedPathMatcher', () => {
  it('entiende **, *, ? y carpetas sin comodines, con \\ o /', () => {
    expect(ownedPathMatcher('src/core/memory/**')('src/core/memory/a/b.ts')).toBe(true);
    expect(ownedPathMatcher('src/core/memory/**')('src\\core\\memory\\x.ts')).toBe(true);
    expect(ownedPathMatcher('src/core/memory/**')('src/core/memoryx/x.ts')).toBe(false);
    expect(ownedPathMatcher('tests/**/*.test.ts')('tests/a.test.ts')).toBe(true);
    expect(ownedPathMatcher('tests/**/*.test.ts')('tests/core/a.test.ts')).toBe(true);
    expect(ownedPathMatcher('src/*.ts')('src/core/a.ts')).toBe(false);
    expect(ownedPathMatcher('src/a?.ts')('src/ab.ts')).toBe(true);
    expect(ownedPathMatcher('src/core/memory')('src/core/memory/x.ts')).toBe(true);
    expect(ownedPathMatcher('package.json')('package.json')).toBe(true);
    expect(ownedPathMatcher('a.b/(x)+')('a.b/(x)+')).toBe(true);
  });
});

describe('significantWords', () => {
  it('normaliza tildes y mayúsculas y quita palabras vacías', () => {
    expect([...significantWords('Memoria en Obsidián para el Orquestador y la API')].sort()).toEqual(['api', 'memoria', 'obsidian', 'orquestador']);
  });
});

describe('rankSessions', () => {
  const task = { id: 'c4-memoria', title: 'Memoria en Obsidian', ownedPaths: ['src/core/memory/**'] };

  it('descarta lo no pertinente y ordena: misma tarea > archivos > palabras; la recencia desempata', () => {
    const ranked = rankSessions([
      session({ notePath: 'n/ajena.md', title: 'Servidor local', files: ['src/core/server/app.ts'] }),
      session({ notePath: 'n/palabras.md', title: 'Notas de memoria', at: '2026-11-02T00:00:00Z' }),
      session({ notePath: 'n/archivos.md', files: ['src/core/memory/a.ts'] }),
      session({ notePath: 'n/misma.md', taskId: 'c4-memoria', at: '2026-10-01T00:00:00Z' }),
      session({ notePath: 'n/palabras-vieja.md', title: 'Notas de memoria', at: '2026-10-02T00:00:00Z' }),
    ], task);
    expect(ranked.map((r) => r.session.notePath)).toEqual(['n/misma.md', 'n/archivos.md', 'n/palabras.md', 'n/palabras-vieja.md']);
  });

  it('es determinista: el orden de entrada no cambia el resultado', () => {
    const list = [
      session({ notePath: 'n/b.md', files: ['src/core/memory/a.ts'] }),
      session({ notePath: 'n/a.md', files: ['src/core/memory/a.ts'] }),
      session({ notePath: 'n/c.md', files: ['src/core/memory/a.ts'], at: 'fecha-rota' }),
    ];
    const a = rankSessions(list, task).map((r) => r.session.notePath);
    const b = rankSessions([...list].reverse(), task).map((r) => r.session.notePath);
    expect(a).toEqual(['n/a.md', 'n/b.md', 'n/c.md']);
    expect(b).toEqual(a);
  });
});

describe('truncateText y BudgetWriter', () => {
  it('recorta sin partir emojis ni pasarse del máximo', () => {
    expect(truncateText('hola mundo', 20)).toBe('hola mundo');
    expect(truncateText('hola mundo', 6)).toBe('hola…');
    expect(truncateText('ab😀cd', 4)).toBe('ab…');
    expect(truncateText('abc', 0)).toBe('');
    for (let max = 0; max < 12; max++) expect(truncateText('ab😀cd😀ef', max).length).toBeLessThanOrEqual(max);
  });

  it('solo agrega bloques que caben, contando los saltos de línea', () => {
    const w = new BudgetWriter(11);
    expect(w.tryAdd('12345')).toBe(true);
    expect(w.remaining()).toBe(5);
    expect(w.tryAdd('123456')).toBe(false);
    expect(w.tryAdd('12345')).toBe(true);
    expect(w.toString()).toBe('12345\n12345');
    expect(w.remaining()).toBe(0);
  });
});

describe('estimateTokens y measureSavings', () => {
  it('≈ caracteres / 4 y ahorro frente al historial', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(measureSavings('a'.repeat(400), 'a'.repeat(4000))).toEqual({
      contextChars: 400, contextTokens: 100, fullChars: 4000, fullTokens: 1000, savedTokens: 900, savedRatio: 0.9,
    });
    expect(measureSavings('', '').savedRatio).toBe(0);
  });
});
