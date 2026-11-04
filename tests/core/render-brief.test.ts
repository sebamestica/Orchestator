import { describe, expect, it } from 'vitest';
import { renderBrief } from '../../src/core/brief/render-brief.ts';
import { taskBriefSchema } from '../../src/shared/index.ts';

const task = taskBriefSchema.parse({
  id: 'adaptador-x', projectId: 'orquestador', title: 'Adaptador X', objective: 'Hacer X',
  ownedPaths: ['src/core/x/**'], dependsOn: [], acceptance: ['pruebas en verde'], difficulty: 'medium',
  skillRefs: ['C:\\dev\\agent-hub\\skills\\flota-orquestador\\SKILL.md'],
});

describe('renderBrief', () => {
  it('incluye objetivo, rutas, criterios y skills', () => {
    const text = renderBrief(task);
    expect(text).toContain('# Tarea adaptador-x: Adaptador X');
    expect(text).toContain('- `src/core/x/**`');
    expect(text).toContain('- [ ] pruebas en verde');
    expect(text).toContain('flota-orquestador');
    expect(text).not.toContain('Continuación de otro agente');
  });

  it('agrega instrucciones de continuación en un traspaso y tacha secretos', () => {
    const text = renderBrief(task, {
      taskId: 'adaptador-x', fromAgent: 'codex', toAgent: 'claude-1', reason: 'quota_exhausted',
      worktreePath: 'C:\\w', partialSummary: 'avancé el parser; clave sk-ant-api03-zzzzzzzzzzzzzzzz', at: '2026-11-01T12:00:00Z',
    });
    expect(text).toContain('Continuación de otro agente');
    expect(text).toContain('`codex`');
    expect(text).not.toContain('sk-ant-api03');
  });
});
