import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSkillMeta } from '../../../src/core/skills/skill-md.ts';
import { FIXTURES } from './helpers.ts';

const fixture = (rel: string) => readFileSync(path.join(FIXTURES, rel), 'utf8');

describe('readSkillMeta', () => {
  it('lee una skill real (copia de C:\\dev\\agent-hub\\skills\\flota-orquestador)', () => {
    const { meta, problems } = readSkillMeta(fixture('flota-orquestador/SKILL.md'), 'flota-orquestador');
    expect(problems).toEqual([]);
    expect(meta?.name).toBe('flota-orquestador');
    expect(meta?.description).toMatch(/^Reglas para trabajar en la flota/);
  });

  it('acepta metadata en JSON en línea (formato de las skills de Codex) y lo informa como no interpretado', () => {
    const { meta, problems, unsupported } = readSkillMeta(fixture('con-scripts/SKILL.md'), 'con-scripts');
    expect(problems).toEqual([]);
    expect(meta?.license).toBe('MIT');
    expect(meta?.frontmatter['allowed-tools']).toEqual(['Read', 'Bash']);
    expect(unsupported).toContain('metadata');
  });

  it('marca el nombre que no coincide con la carpeta', () => {
    const { meta, problems } = readSkillMeta(fixture('nombre-distinto/SKILL.md'), 'nombre-distinto');
    expect(meta?.name).toBe('otro-nombre');
    expect(problems).toEqual(['«name» (otro-nombre) no coincide con la carpeta (nombre-distinto)']);
  });

  it('rechaza frontmatter ausente, nombres no válidos y descripciones vacías', () => {
    expect(readSkillMeta('# sin frontmatter').problems[0]).toMatch(/no empieza con un bloque de frontmatter/);
    expect(readSkillMeta('---\nname: s\n---\n').problems).toEqual(['falta «description» o no es texto']);
    expect(readSkillMeta('---\nname: Mi_Skill\ndescription: x\n---\n').problems).toEqual(['«name» debe usar minúsculas, dígitos y guiones']);
    expect(readSkillMeta('---\nname: ../evil\ndescription: x\n---\n').problems).toEqual(['«name» debe usar minúsculas, dígitos y guiones']);
    expect(readSkillMeta(`---\nname: ${'a'.repeat(65)}\ndescription: x\n---\n`).problems).toEqual(['«name» supera 64 caracteres']);
    expect(readSkillMeta('---\nname: s\ndescription: ""\n---\n').problems).toEqual(['«description» está vacía']);
    expect(readSkillMeta('---\nname: s\ndescription: x\n').problems[0]).toMatch(/frontmatter no válido/);
  });

  it('admite CRLF, BOM y descripciones en bloque', () => {
    const text = '\uFEFF---\r\nname: "con-bloque"\r\ndescription: >\r\n  Primera línea\r\n  sigue aquí.\r\n---\r\n# Cuerpo\r\n';
    const { meta, problems } = readSkillMeta(text, 'con-bloque');
    expect(problems).toEqual([]);
    expect(meta?.description).toBe('Primera línea sigue aquí.'); // Zod recorta los extremos
  });
});
