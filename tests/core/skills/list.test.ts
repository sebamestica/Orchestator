import { existsSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_HUB_DIR, SkillHub } from '../../../src/core/skills/hub.ts';
import { cleanup, copyFixture, FIXTURES, tempDir } from './helpers.ts';

describe('SkillHub.list', () => {
  it('lee las skills de fixtures/skills y valida nombre = carpeta', async () => {
    const hub = new SkillHub({ roots: [FIXTURES], quarantineDir: path.join(FIXTURES, 'no-se-usa') });
    const skills = await hub.list();
    // `zips/` no tiene SKILL.md: no es una skill.
    expect(skills.map((s) => [s.folder, s.valid])).toEqual([
      ['con-scripts', true],
      ['flota-orquestador', true],
      ['navegador-chrome', true],
      ['nombre-distinto', false],
    ]);
    const distinto = skills.find((s) => s.folder === 'nombre-distinto');
    expect(distinto).toMatchObject({ name: 'otro-nombre', problems: ['«name» (otro-nombre) no coincide con la carpeta (nombre-distinto)'] });
    expect(skills.find((s) => s.folder === 'con-scripts')).toMatchObject({ license: 'MIT', root: FIXTURES });
  });

  describe('con carpetas temporales', () => {
    let dir: string;
    beforeAll(async () => { dir = await tempDir('list'); });
    afterAll(async () => { await cleanup(dir); });

    it('recorre varias raíces en orden, omite carpetas ocultas, archivos sueltos y raíces que no existen', async () => {
      const global = path.join(dir, 'hub', 'skills');
      const proyecto = path.join(dir, 'proyecto', '.agents', 'skills');
      await copyFixture('navegador-chrome', global);
      await copyFixture('con-scripts', proyecto);
      await mkdir(path.join(global, '.system', 'oculta'), { recursive: true });
      await writeFile(path.join(global, '.system', 'oculta', 'SKILL.md'), '---\nname: oculta\ndescription: x\n---\n');
      await writeFile(path.join(global, 'skills.lock.json'), '{}');
      await mkdir(path.join(global, 'rota'));
      await writeFile(path.join(global, 'rota', 'SKILL.md'), '# sin frontmatter\n');
      const hub = new SkillHub({ roots: [global, proyecto, path.join(dir, 'no-existe')] });
      const skills = await hub.list();
      expect(skills.map((s) => `${path.basename(path.dirname(s.root))}/${s.folder}:${String(s.valid)}`)).toEqual([
        'hub/navegador-chrome:true',
        'hub/rota:false',
        '.agents/con-scripts:true',
      ]);
      expect(skills[1]?.problems).toEqual(['SKILL.md no empieza con un bloque de frontmatter «---»']);
    });

    it('lee una skill enlazada por junction, como las que crea vincular-skills.ps1', async () => {
      const real = await copyFixture('flota-orquestador', path.join(dir, 'real'));
      const root = path.join(dir, 'enlazadas');
      await mkdir(root, { recursive: true });
      await symlink(real, path.join(root, 'flota-orquestador'), 'junction');
      const skills = await new SkillHub({ roots: [root] }).list();
      expect(skills.map((s) => [s.name, s.valid])).toEqual([['flota-orquestador', true]]);
    });
  });

  const realHub = path.join(AGENT_HUB_DIR, 'skills');
  it.skipIf(!existsSync(realHub))('lee las skills reales de C:\\dev\\agent-hub\\skills (solo lectura)', async () => {
    const skills = await new SkillHub({ roots: [realHub] }).list();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.map((s) => s.name)).toContain('flota-orquestador');
    expect(skills.filter((s) => !s.valid).map((s) => `${s.folder}: ${s.problems.join('; ')}`)).toEqual([]);
    for (const s of skills) expect(s.description?.length).toBeGreaterThan(20);
  });

  const vetworld = 'C:\\dev\\Vetworld\\.agents\\skills';
  it.skipIf(!existsSync(vetworld))('lee las skills de proyecto reales de Vetworld (.agents/skills, solo lectura)', async () => {
    const skills = await new SkillHub({ roots: [vetworld] }).list();
    expect(skills.length).toBeGreaterThanOrEqual(20);
    expect(skills.filter((s) => !s.valid).map((s) => `${s.folder}: ${s.problems.join('; ')}`)).toEqual([]);
  });

  it('por defecto usa C:\\dev\\agent-hub\\skills y .agents/skills del proyecto', () => {
    const hub = new SkillHub({ projectDir: 'C:\\dev\\proyecto' });
    if (process.platform !== 'win32') return;
    expect(hub.roots).toEqual(['C:\\dev\\agent-hub\\skills', 'C:\\dev\\proyecto\\.agents\\skills']);
    expect(hub.installRoot).toBe('C:\\dev\\agent-hub\\skills');
    expect(hub.quarantineDir).toBe('C:\\dev\\agent-hub\\skills-entrantes');
    expect(hub.lockPath).toBe('C:\\dev\\agent-hub\\skills.lock.json');
  });
});
